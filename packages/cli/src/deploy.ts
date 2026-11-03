import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Actuator } from "@actuate/sdk";
import { CliError, describePlan, resolvePlan, type ResolvedPlan } from "./account.js";
import { ApiError, api, readCredentials, type Credentials } from "./api.js";
import { checkSource, formatDiagnostic, type Diagnostic } from "./check.js";
import { bundleActuator, describeActuator, loadActuator, type ActuatorMetadata } from "./load.js";
import { platformChecks, type AccountFacts, type PlatformIssue } from "./platform-checks.js";

/** Body of POST /v1/actuators/deploy. The platform re-derives and verifies metadata server-side. */
export interface DeployRequest {
  metadata: ActuatorMetadata;
  /** Single ESM module whose default export is the actuator. */
  code: string;
  /** sha256 of `code`, hex. With the actuator name, it forms the stable worker ID. */
  codeHash: string;
  /** Operator configuration to set with this deploy (validated against the ConfigSchema). */
  config?: unknown;
}

export interface DeployResponse {
  name: string;
  version: number;
  urls: { api: string; webhook: string; mcp: string; openapi: string; dashboard: string };
  warnings?: string[];
}

/** actuate.config.json: absent (undefined), its value, or why it can't be used. */
export function readConfigFile(cwd: string): { value: unknown } | { error: string } | undefined {
  const path = join(cwd, "actuate.config.json");
  if (!existsSync(path)) return undefined;
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { error: `actuate.config.json is not valid JSON: ${(err as Error).message}` };
  }
}

/** Lint, bundle and describe the actuator: everything a deploy needs, nothing uploaded. Throws on lint errors. */
export async function prepareDeploy(file: string, cwd: string, withConfig: boolean, log: (line: string) => void = console.log): Promise<DeployRequest> {
  return (await prepare(file, cwd, withConfig, log)).request;
}

interface Prepared {
  request: DeployRequest;
  actuator: Actuator;
  diagnostics: Diagnostic[];
  config: { value: unknown } | { error: string } | undefined;
}

async function prepare(file: string, cwd: string, withConfig: boolean, log: (line: string) => void, stopOnLintErrors = true): Promise<Prepared> {
  const abs = resolve(cwd, file);
  if (!existsSync(abs)) throw new CliError(`${file} not found. Run this in your project folder, or pass the actuator file.`);
  const diagnostics = checkSource(file, readFileSync(abs, "utf8"));
  for (const d of diagnostics) log(formatDiagnostic(d));
  if (stopOnLintErrors && diagnostics.some((d) => d.severity === "error")) throw new CliError("Fix the replay-safety errors above before deploying.");

  const [code, actuator] = await Promise.all([bundleActuator(abs), loadActuator(abs, join(cwd, ".actuate", "tmp"))]);
  const request: DeployRequest = {
    metadata: describeActuator(actuator),
    code,
    codeHash: createHash("sha256").update(code).digest("hex"),
  };
  const config = withConfig ? readConfigFile(cwd) : undefined;
  if (config && "value" in config) request.config = config.value;
  return { request, actuator, diagnostics, config };
}

interface Deployed {
  exists: boolean;
  version?: number;
  codeHash?: string;
}

/** What the account knows that the deploy checks need. Each lookup is optional: failures only skip a check. */
async function accountFacts(creds: Credentials, name: string, resolved: ResolvedPlan): Promise<{ facts: AccountFacts; deployed?: Deployed; notes: string[] }> {
  const notes: string[] = [];
  const facts: AccountFacts = {};
  if (typeof resolved.me?.usage?.deploys === "number") facts.deploysThisMonth = resolved.me.usage.deploys;
  const [providers, detail] = await Promise.allSettled([
    api<Array<{ capability: string }>>(creds, "/v1/providers"),
    api<{ version: number; versions?: Array<{ version: number; code_hash: string }> }>(creds, `/v1/actuators/${encodeURIComponent(name)}`),
  ]);
  if (providers.status === "fulfilled") facts.configuredCapabilities = [...new Set(providers.value.map((p) => p.capability))];
  else notes.push(`providers: ${(providers.reason as Error).message}`);
  let deployed: Deployed | undefined;
  if (detail.status === "fulfilled") {
    const current = detail.value.versions?.find((v) => v.version === detail.value.version);
    deployed = { exists: true, version: detail.value.version, ...(current ? { codeHash: current.code_hash } : {}) };
    facts.exists = true;
  } else if (detail.reason instanceof ApiError && detail.reason.status === 404) {
    deployed = { exists: false };
    facts.exists = false;
    try {
      facts.actuatorCount = (await api<unknown[]>(creds, "/v1/actuators")).length;
    } catch (err) {
      notes.push(`actuators: ${(err as Error).message}`);
    }
  } else {
    notes.push(`actuator: ${(detail.reason as Error).message}`);
  }
  return { facts, ...(deployed ? { deployed } : {}), notes };
}

export function formatIssue(i: PlatformIssue): string {
  return `${i.severity === "error" ? "error" : "warn "}  ${i.message}  (${i.rule})`;
}

/** Same JSON, whatever the key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

export interface DeployChecks {
  prepared: Prepared;
  resolved: ResolvedPlan;
  issues: PlatformIssue[];
  account: { facts: AccountFacts; deployed?: Deployed; notes: string[] };
}

/**
 * Lint, bundle and load the actuator, then run the platform's deploy checks
 * on it: locally, plus the account's when logged in. Prints as it goes.
 * Shared by `actuate deploy` and `actuate check --platform`.
 */
export async function deployChecks(
  file: string,
  cwd: string,
  opts: { withConfig: boolean; plan?: string; log: (line: string) => void; creds?: Credentials | null; stopOnLintErrors?: boolean },
): Promise<DeployChecks> {
  const log = opts.log;
  const creds = opts.creds === undefined ? readCredentials() : opts.creds;
  const prepared = await prepare(file, cwd, opts.withConfig, log, opts.stopOnLintErrors ?? true);
  const { request } = prepared;
  const resolved = await resolvePlan(opts.plan, { online: true, creds });
  const account = creds ? await accountFacts(creds, request.metadata.name, resolved) : { facts: {}, notes: [] as string[] };
  if (resolved.meError) account.notes.unshift(`account: ${resolved.meError}`);
  const bytes = Buffer.byteLength(request.code);
  const issues = platformChecks({
    metadata: request.metadata,
    actuator: prepared.actuator,
    plan: resolved.plan,
    bundleBytes: bytes,
    ...(prepared.config ? { config: prepared.config } : {}),
    account: account.facts,
  });
  log(`Bundled ${request.metadata.name}: ${(bytes / 1024).toFixed(1)} KiB, sha256 ${request.codeHash.slice(0, 12)}`);
  log(`Deploy checks: ${describePlan(resolved)}${creds ? "" : "; not logged in, so the provider, actuator-count and deploy-budget checks were skipped"}`);
  for (const note of account.notes) log(`  skipped  ${note}`);
  for (const i of issues) log(`  ${formatIssue(i)}`);
  if (!issues.length) log("  ✓ passes the platform's deploy checks (mirrored locally; the platform has the final say)");
  return { prepared, resolved, issues, account };
}

export interface DeployOptions {
  /** Send actuate.config.json (default true). */
  config: boolean;
  /** Check and bundle, but upload nothing. */
  dryRun: boolean;
  /** Check against this plan instead of the account's. */
  plan?: string;
  /** Deploy even when the local checks find errors, or nothing changed. */
  force?: boolean;
  /** Print one JSON object instead of text. */
  json?: boolean;
  log?: (line: string) => void;
}

/**
 * `actuate deploy`: lint, bundle, run the platform's deploy checks locally
 * (and, logged in, the account's: providers, actuator count, deploy budget),
 * skip the upload when the deployed version already runs this code, and
 * deploy. A refused deploy still counts against the deploy budget, which is
 * why everything that can be checked here is.
 */
export async function deploy(file: string, cwd: string, opts: DeployOptions): Promise<number> {
  const out = opts.log ?? console.log;
  const log = opts.json ? () => {} : out;
  const creds = readCredentials();
  if (!opts.dryRun && !creds) throw new CliError("Not logged in. Run `actuate login` (or set ACTUATE_API_TOKEN) first, or use --dry-run.");
  const checked = await deployChecks(file, cwd, { withConfig: opts.config, ...(opts.plan ? { plan: opts.plan } : {}), log, creds });
  const { prepared, resolved, issues, account } = checked;
  const { request } = prepared;
  const errors = issues.filter((i) => i.severity === "error");
  const bytes = Buffer.byteLength(request.code);
  const deployed = account.deployed;
  const summary = {
    name: request.metadata.name,
    diagnostics: prepared.diagnostics,
    bundle: { bytes, sha256: request.codeHash },
    plan: { id: resolved.plan.id, source: resolved.source },
    issues,
    ...(deployed?.exists ? { deployed: { version: deployed.version, sameCode: deployed.codeHash === request.codeHash } } : {}),
  };

  if (opts.dryRun) {
    if (opts.json) out(JSON.stringify({ ...summary, dryRun: true, metadata: request.metadata }, null, 2));
    else out(JSON.stringify(request.metadata, null, 2));
    return errors.length ? 1 : 0;
  }
  if (errors.length && !opts.force) {
    throw new CliError(
      `The platform would refuse this deploy (${errors.length} error${errors.length === 1 ? "" : "s"} above), and a refused deploy still counts against your deploy budget. Fix ${errors.length === 1 ? "it" : "them"}, or pass --force to deploy anyway.`,
    );
  }

  // The deployed version already runs this code: update the configuration alone, which uses no deploy.
  if (deployed?.exists && deployed.codeHash === request.codeHash && !opts.force) {
    const name = encodeURIComponent(request.metadata.name);
    let action: "none" | "config" = "none";
    if (request.config !== undefined) {
      const current = await api<{ config: unknown }>(creds!, `/v1/actuators/${name}/config`).catch(() => null);
      if (!current || canonical(current.config) !== canonical(request.config)) {
        await api(creds!, `/v1/actuators/${name}/config`, { method: "PUT", body: JSON.stringify({ config: request.config }) });
        action = "config";
      }
    }
    if (opts.json) out(JSON.stringify({ ...summary, deployedNow: false, configUpdated: action === "config", version: deployed.version }, null, 2));
    else if (action === "config") out(`\n✓ ${request.metadata.name} v${deployed.version} already runs this code: updated its configuration only (no deploy used).`);
    else out(`\n✓ Nothing to deploy: ${request.metadata.name} v${deployed.version} already runs this code${request.config !== undefined ? " and configuration" : ""}. Pass --force to deploy anyway.`);
    return 0;
  }

  const res = await api<DeployResponse>(creds!, "/v1/actuators/deploy", { method: "POST", body: JSON.stringify(request) });
  if (opts.json) {
    out(JSON.stringify({ ...summary, deployedNow: true, version: res.version, urls: res.urls, warnings: res.warnings ?? [] }, null, 2));
    return 0;
  }
  for (const w of res.warnings ?? []) out(`warn  ${w}`);
  const used = account.facts.deploysThisMonth;
  out(`
✓ Deployed ${res.name} v${res.version}

  Webhook   ${res.urls.webhook}
  MCP       ${res.urls.mcp}
  OpenAPI   ${res.urls.openapi}
  Dashboard ${res.urls.dashboard}
${used !== undefined ? `\n  Deploys this month: ${(used + 1).toLocaleString("en")} of ${resolved.plan.limits.deploysPerMonth.toLocaleString("en")}\n` : ""}`);
  return 0;
}
