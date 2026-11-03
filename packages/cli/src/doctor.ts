import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configuredFromEnv, envVarsFor } from "@actuate/providers";
import { describePlan, resolvePlan } from "./account.js";
import { credentialsPath, readCredentials } from "./api.js";
import { checkSource } from "./check.js";
import { readConfigFile } from "./deploy.js";
import { parseEnvFile } from "./dev.js";
import { cliResolve, describeActuator, findPackage, loadActuator } from "./load.js";
import { platformChecks } from "./platform-checks.js";
import { findTestFiles } from "./test-runner.js";

export type DoctorStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorResult {
  check: string;
  status: DoctorStatus;
  message: string;
  /** What to do about it. */
  fix?: string;
}

function ownVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

/**
 * `actuate doctor`: everything that commonly stops `dev`, `test` or `deploy`,
 * checked in one go. Read-only; the only network call is `GET /v1/me` when a
 * token is saved, and `offline` skips it.
 */
export async function doctor(cwd: string, file = "actuator.ts", opts: { offline?: boolean; plan?: string } = {}): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  const add = (check: string, status: DoctorStatus, message: string, fix?: string) => void results.push({ check, status, message, ...(fix ? { fix } : {}) });

  // Node
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22) add("node", "fail", `Node.js ${process.versions.node}: Actuate needs Node.js 22 or later.`, "Install Node.js 22 LTS or later.");
  else if (major === 22 && minor < 13) add("node", "warn", `Node.js ${process.versions.node}: node:sqlite needs a flag before 22.13 (actuate test adds it).`, "Upgrade to Node.js 22.13 or later.");
  else add("node", "ok", `Node.js ${process.versions.node}`);

  const cliVersion = ownVersion();
  add("cli", "ok", `@actuate/cli ${cliVersion}`);
  try {
    const wrangler = JSON.parse(readFileSync(cliResolve("wrangler/package.json"), "utf8")) as { version: string };
    add("wrangler", "ok", `wrangler ${wrangler.version} (used by actuate dev)`);
  } catch {
    add("wrangler", "fail", "wrangler is missing, so actuate dev can't start.", "Reinstall @actuate/cli: npm install -D @actuate/cli");
  }

  // Project
  const abs = join(cwd, file);
  const hasPackage = existsSync(join(cwd, "package.json"));
  if (!existsSync(abs)) {
    add("project", "fail", `No ${file} in ${cwd}.`, "Run this in your project folder, or create a project with `npx @actuate/cli init my-actuator`.");
  } else {
    add("project", "ok", file);
  }
  if (!hasPackage) add("package", "warn", "No package.json here.", "Create the project with `actuate init` so it has one.");
  else {
    const sdkDir = findPackage(cwd, "@actuate/sdk");
    if (sdkDir) {
      const sdk = (JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")) as { version: string }).version;
      if (sdk.split(".").slice(0, 2).join(".") !== cliVersion.split(".").slice(0, 2).join(".")) {
        add("sdk", "warn", `@actuate/sdk ${sdk} with @actuate/cli ${cliVersion}: they are released together; keep them on one version.`, `npm install @actuate/sdk@${cliVersion} -D @actuate/cli@${cliVersion}`);
      } else add("sdk", "ok", `@actuate/sdk ${sdk}`);
    } else {
      add("sdk", "fail", "@actuate/sdk is not installed.", "npm install");
    }
  }

  // The actuator itself
  let loaded: Awaited<ReturnType<typeof loadActuator>> | undefined;
  if (existsSync(abs)) {
    const diagnostics = checkSource(file, readFileSync(abs, "utf8"));
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    if (errors) add("replay-safety", "fail", `${errors} replay-safety error(s).`, "Run `actuate check` to see them.");
    else if (diagnostics.length) add("replay-safety", "warn", `${diagnostics.length} replay-safety warning(s).`, "Run `actuate check` to see them.");
    else add("replay-safety", "ok", "No replay-safety problems");
    try {
      loaded = await loadActuator(abs, join(cwd, ".actuate", "tmp"));
      add("load", "ok", `${file} loads: actuator "${loaded.name}"`);
    } catch (err) {
      add("load", "fail", `${file} does not load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Login and plan
  const creds = (() => {
    try {
      return readCredentials();
    } catch (err) {
      add("login", "fail", (err as Error).message, "actuate login");
      return undefined;
    }
  })();
  if (creds === null) add("login", "info", "Not logged in: fine for dev and test; deploy needs it.", "actuate login");
  const resolved = await resolvePlan(opts.plan, { online: !opts.offline && Boolean(creds), creds: creds ?? null });
  if (creds) {
    if (resolved.me) {
      const deploys = resolved.me.usage?.deploys;
      add(
        "login",
        "ok",
        `Logged in${resolved.me.email ? ` as ${resolved.me.email}` : ""}, ${resolved.plan.name} plan${deploys !== undefined ? `, ${deploys} of ${resolved.plan.limits.deploysPerMonth} deploys used this month` : ""}`,
      );
    } else if (opts.offline) add("login", "info", `Token saved (${process.env.ACTUATE_API_TOKEN ? "ACTUATE_API_TOKEN" : credentialsPath()}); not checked (--offline).`);
    else if (/^401\b|Unauthorized/i.test(resolved.meError ?? "")) add("login", "fail", "The saved token was rejected.", "Create a full token in the dashboard and run `actuate login` again.");
    else add("login", "warn", `Could not check the token: ${resolved.meError}`);
  }

  // Configuration and deploy checks
  if (loaded) {
    const config = readConfigFile(cwd);
    const issues = platformChecks({ metadata: describeActuator(loaded), actuator: loaded, plan: resolved.plan, ...(config ? { config } : {}) });
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length) add("deploy-checks", "fail", `${errors.length} deploy check(s) fail: ${errors.map((e) => e.rule).join(", ")}. Checked for the ${describePlan(resolved)}.`, "Run `actuate check --platform` to see them.");
    else if (issues.length) add("deploy-checks", "warn", `Deploy checks pass with ${issues.length} warning(s), for the ${describePlan(resolved)}.`, "Run `actuate check --platform` to see them.");
    else add("deploy-checks", "ok", `Passes the platform's deploy checks, for the ${describePlan(resolved)}`);
  }

  // Providers for actuate dev
  const vars: Record<string, string> = {};
  for (const f of [".env", ".dev.vars"]) if (existsSync(join(cwd, f))) Object.assign(vars, parseEnvFile(readFileSync(join(cwd, f), "utf8")));
  if (loaded) {
    const declared = [...(loaded.capabilities ?? []), ...(loaded.optionalCapabilities ?? [])].filter((c) => c !== "http");
    let configured: ReturnType<typeof configuredFromEnv> = [];
    try {
      configured = configuredFromEnv(vars);
    } catch (err) {
      add("providers", "fail", `.dev.vars: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, "Run `actuate providers` for the variables each provider reads.");
    }
    for (const cap of declared) {
      const kinds = configured.filter((p) => p.capability === cap).map((p) => p.definition.kind);
      if (kinds.length) {
        add(`provider:${cap}`, "ok", `${cap}: ${kinds.join(", ")} (from .dev.vars)`);
        continue;
      }
      const chosen = vars[`ACTUATE_${cap.toUpperCase()}`];
      if (chosen) continue; // configuredFromEnv already reported the problem
      if (cap === "llm") add(`provider:${cap}`, "warn", "llm: no provider in .dev.vars, so ctx.llm calls fail under actuate dev.", "Set ACTUATE_LLM and its key in .dev.vars (see `actuate providers`).");
      else add(`provider:${cap}`, "info", `${cap}: none in .dev.vars; actuate dev uses a local stand-in (${cap === "messaging" ? "messages print to the console" : "a fake payment provider"}).`);
    }
    for (const p of configured) {
      const missing = envVarsFor(p.definition.kind).filter((v) => !v.optional && !vars[v.name]).map((v) => v.name);
      if (missing.length) add(`provider:${p.definition.kind}`, "fail", `${p.definition.kind}: missing ${missing.join(", ")} in .dev.vars.`);
    }
  }

  // Secrets stay out of git
  const gitignore = existsSync(join(cwd, ".gitignore")) ? readFileSync(join(cwd, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim()) : [];
  const leaks = [".dev.vars", ".env"].filter((f) => existsSync(join(cwd, f)) && !gitignore.some((l) => l === f || l === `/${f}`));
  if (leaks.length) add("gitignore", "warn", `${leaks.join(" and ")} ${leaks.length === 1 ? "holds" : "hold"} secrets but ${leaks.length === 1 ? "isn't" : "aren't"} in .gitignore.`, `Add ${leaks.join(", ")} to .gitignore.`);

  // Tests
  try {
    const tests = findTestFiles(cwd);
    if (tests.length) add("tests", "ok", `${tests.length} test file(s): run \`actuate test\``);
    else add("tests", "warn", "No tests.", "Add actuator.test.ts (`actuate test` prints an example).");
  } catch {
    /* unreadable folder: not worth a line */
  }
  return results;
}

const ICON: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

export function formatDoctor(results: DoctorResult[]): string {
  const lines = results.map((r) => `${ICON[r.status]} ${r.message}${r.fix ? `\n    → ${r.fix}` : ""}`);
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  lines.push("", fails ? `${fails} problem(s) to fix${warns ? `, ${warns} warning(s)` : ""}.` : warns ? `No problems; ${warns} warning(s).` : "Everything looks good.");
  return lines.join("\n");
}

