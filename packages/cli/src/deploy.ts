import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { api, readCredentials } from "./api.js";
import { checkSource, formatDiagnostic } from "./check.js";
import { bundleActuator, describeActuator, loadActuator, type ActuatorMetadata } from "./load.js";

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

export async function prepareDeploy(file: string, cwd: string, withConfig: boolean): Promise<DeployRequest> {
  const abs = resolve(cwd, file);
  const diagnostics = checkSource(file, readFileSync(abs, "utf8"));
  for (const d of diagnostics) console.log(formatDiagnostic(d));
  if (diagnostics.some((d) => d.severity === "error")) throw new Error("Fix the errors above before deploying.");

  const [code, actuator] = await Promise.all([bundleActuator(abs), loadActuator(abs, join(cwd, ".actuate", "tmp"))]);
  const request: DeployRequest = {
    metadata: describeActuator(actuator),
    code,
    codeHash: createHash("sha256").update(code).digest("hex"),
  };
  if (withConfig) {
    try {
      request.config = JSON.parse(readFileSync(join(cwd, "actuate.config.json"), "utf8"));
    } catch {
      /* no config file */
    }
  }
  return request;
}

export async function deploy(file: string, cwd: string, opts: { config: boolean; dryRun: boolean }): Promise<void> {
  const creds = opts.dryRun ? null : readCredentials();
  if (!opts.dryRun && !creds) throw new Error("Not logged in. Run `actuate login` (or set ACTUATE_API_TOKEN) first, or use --dry-run.");
  const request = await prepareDeploy(file, cwd, opts.config);
  const kb = (Buffer.byteLength(request.code) / 1024).toFixed(1);
  console.log(`Bundled ${request.metadata.name}: ${kb} KiB, sha256 ${request.codeHash.slice(0, 12)}`);
  if (opts.dryRun) {
    console.log(JSON.stringify(request.metadata, null, 2));
    return;
  }
  const res = await api<DeployResponse>(creds!, "/v1/actuators/deploy", { method: "POST", body: JSON.stringify(request) });
  for (const w of res.warnings ?? []) console.warn(`warn  ${w}`);
  console.log(`
✓ Deployed ${res.name} v${res.version}

  Webhook   ${res.urls.webhook}
  MCP       ${res.urls.mcp}
  OpenAPI   ${res.urls.openapi}
  Dashboard ${res.urls.dashboard}
`);
}
