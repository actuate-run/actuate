import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { context } from "esbuild";
import { CliError, describePlan, planHint, type ResolvedPlan } from "./account.js";
import { checkSource, formatDiagnostic } from "./check.js";
import { readConfigFile, formatIssue } from "./deploy.js";
import { bundleActuator, cliResolve, describeActuator, loadActuator, ownModule, packageDir, workerBuildOptions } from "./load.js";
import type { PlanId } from "./plans.js";
import { platformChecks } from "./platform-checks.js";

export interface DevOptions {
  file: string;
  port: number;
  cwd: string;
  /** The plan whose deploy checks and guards apply. */
  plan: ResolvedPlan;
  /** Apply the platform's guards (default true). */
  guards?: boolean;
}


/** Parse a .dev.vars / .env file: KEY=value lines, # comments, optional quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    vars[m[1]!] = value;
  }
  return vars;
}

export interface DevConfig {
  /** The configuration as the deploy checks see it; undefined when there is none. */
  config?: { value: unknown } | { error: string };
  /** What ACTUATE_CONFIG becomes; undefined leaves whatever .env or .dev.vars set. */
  text?: string;
  /** Where it came from, in order of precedence (lowest first). */
  sources: string[];
}

const DEV_VARS_SOURCE = "ACTUATE_CONFIG in .dev.vars";

/** Objects merge key by key; anything else from `over` replaces `base`. */
export function mergeConfig(base: unknown, over: unknown): unknown {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(base) || !isObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    // defineProperty: a "__proto__" key from JSON stays a plain key instead of changing the prototype.
    Object.defineProperty(out, key, { value: Object.hasOwn(base, key) ? mergeConfig(base[key], value) : value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * The configuration `actuate dev` runs with: actuate.config.json, with ACTUATE_CONFIG from the git-ignored
 * .dev.vars (a JSON object) deep-merged over it, so local secrets stay out of the committed file. Without
 * ACTUATE_CONFIG in .dev.vars, the file alone, as before.
 */
export function devConfig(cwd: string): DevConfig {
  const file = readConfigFile(cwd);
  const devVars = join(cwd, ".dev.vars");
  const local = existsSync(devVars) ? parseEnvFile(readFileSync(devVars, "utf8")).ACTUATE_CONFIG : undefined;
  if (local === undefined) {
    return file ? { config: file, text: readFileSync(join(cwd, "actuate.config.json"), "utf8"), sources: ["actuate.config.json"] } : { sources: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(local);
  } catch (err) {
    throw new CliError(`ACTUATE_CONFIG in .dev.vars is not valid JSON: ${(err as Error).message}. Write the object on one line: ACTUATE_CONFIG={"apiKey":"sk_test_..."}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(`ACTUATE_CONFIG in .dev.vars must be a JSON object, like {"apiKey":"sk_test_..."}; it is merged over actuate.config.json.`);
  }
  if (file && "error" in file) throw new CliError(`${file.error}. Fix it: ACTUATE_CONFIG in .dev.vars is merged over it.`);
  const merged = file ? mergeConfig(file.value, value) : value;
  return { config: { value: merged }, text: JSON.stringify(merged), sources: file ? ["actuate.config.json", DEV_VARS_SOURCE] : [DEV_VARS_SOURCE] };
}

/** The banner line saying where the configuration came from, when .dev.vars contributed to it. */
export function configBannerLine(sources: readonly string[]): string | null {
  if (!sources.includes(DEV_VARS_SOURCE)) return null;
  return sources.length > 1 ? `actuate.config.json, with ${DEV_VARS_SOURCE} merged over it` : DEV_VARS_SOURCE;
}

export function wranglerConfig(meta: { name: string; cron: string[] }, vars: Record<string, string>): object {
  return {
    $schema: "https://unpkg.com/wrangler/config-schema.json",
    name: `actuate-dev-${meta.name.replace(/_/g, "-")}`,
    main: "build/worker.js",
    no_bundle: true,
    compatibility_date: "2025-09-01",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: { bindings: [{ name: "ACTUATOR", class_name: "ActuatorObject" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ActuatorObject"] }],
    ...(meta.cron.length ? { triggers: { crons: meta.cron } } : {}),
    vars,
  };
}

/** The worker `actuate dev` runs. `plan` picks the platform guards; null turns them off. */
export function devEntry(actuatorPath: string, port: number, plan: PlanId | null = null, opts: { refuseCapabilities?: boolean } = {}): string {
  return `import { createDevRuntime } from ${JSON.stringify(ownModule("dev-runtime"))};
import { consoleOwnerNotifier, devProviders } from ${JSON.stringify(cliResolve("@actuate/runtime"))};
import { providersFromEnv, parseProviderWebhookFromEnv } from ${JSON.stringify(cliResolve("@actuate/providers"))};
import actuator from ${JSON.stringify(actuatorPath)};

// Real providers where .dev.vars selects them (ACTUATE_MESSAGING=telegram, ...); console and fake payments otherwise.
const runtime = createDevRuntime(actuator, {
  plan: ${JSON.stringify(plan)},
  refuseCapabilities: ${JSON.stringify(opts.refuseCapabilities ?? plan !== null)},
  providers: (env, publicUrl) => {
    const base = publicUrl || "http://localhost:${port}";
    return { ...devProviders(base), ...providersFromEnv(env, base) };
  },
  providerWebhook: (kind, request, env) => parseProviderWebhookFromEnv(env, kind, request),
  // ctx.notifyOwner prints here; the hosted platform emails the account.
  notifyOwner: () => consoleOwnerNotifier(),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
`;
}

export async function dev(options: DevOptions): Promise<void> {
  const file = resolve(options.cwd, options.file);
  if (!existsSync(file)) throw new CliError(`${options.file} not found. Run \`actuate init\` to create a project, or pass the actuator file.`);
  const outDir = join(options.cwd, ".actuate");
  mkdirSync(outDir, { recursive: true });

  for (const d of checkSource(options.file, readFileSync(file, "utf8"))) console.log(formatDiagnostic(d));

  const actuator = await loadActuator(file, join(outDir, "tmp"));
  const meta = describeActuator(actuator);
  // The deploy checks, as warnings: better to hear about them now than at deploy time.
  const configured = devConfig(options.cwd);
  const config = configured.config;
  const guardsOn = options.guards !== false;
  const bundleBytes = Buffer.byteLength(await bundleActuator(file));
  const defaulted = options.plan.source === "default";
  const issues = platformChecks({ metadata: meta, actuator, plan: options.plan.plan, planDefaulted: defaulted, bundleBytes, ...(config ? { config } : {}) });
  const missing = meta.capabilities.filter((c) => !options.plan.plan.capabilities.includes(c as never));
  for (const i of issues) if (!(missing.length && i.rule === "plan-capability" && i.severity !== "warning")) console.log(`deploy check  ${formatIssue(i)}`);
  // Capabilities the plan lacks are refused only for a plan someone chose: a guessed Sandbox mustn't break a fresh template.
  const refuseCapabilities = guardsOn && !defaulted;
  if (missing.length && !defaulted) {
    const what = missing.map((c) => `ctx.${c}`).join(" and ");
    console.warn(`
⚠  The ${describePlan(options.plan)} has no ${missing.join(" or ")}: the platform will refuse to deploy this actuator.
   ${refuseCapabilities ? `With the guards on, calls on ${what} fail here too, with the platform's message.` : `With --no-guards, ${what} still works here, but not once deployed on this plan.`}
   Develop for another plan with --plan maker.
`);
  }
  const vars: Record<string, string> = {};
  for (const envFile of [".env", ".dev.vars"]) {
    const p = join(options.cwd, envFile);
    if (existsSync(p)) Object.assign(vars, parseEnvFile(readFileSync(p, "utf8")));
  }
  if (configured.text !== undefined) vars.ACTUATE_CONFIG = configured.text;
  vars.ACTUATE_DEV = "1"; // local only: admin routes and webhooks work without secrets

  writeFileSync(join(outDir, "entry.ts"), devEntry(file, options.port, guardsOn ? options.plan.plan.id : null, { refuseCapabilities }));
  writeFileSync(join(outDir, "wrangler.json"), JSON.stringify(wranglerConfig(meta, vars), null, 2));

  const ctx = await context({
    ...workerBuildOptions,
    entryPoints: [join(outDir, "entry.ts")],
    outfile: join(outDir, "build", "worker.js"),
    plugins: [
      {
        name: "actuate-rebuild-log",
        setup(b) {
          b.onEnd((r) => {
            if (r.errors.length) console.error(`✗ build failed: ${r.errors.map((e) => e.text).join("; ")}`);
            else console.log("✓ actuator built");
          });
        },
      },
    ],
  });
  await ctx.rebuild();
  await ctx.watch();

  const local = options.port === 8787 ? "--local" : `--local --port ${options.port}`;
  const guards = guardsOn ? `on, for the ${describePlan(options.plan)}. --no-guards turns them off.${planHint(options.plan) ? ` ${planHint(options.plan)}` : ""}` : "off (--no-guards)";
  console.log(`
  ${meta.name} running at http://localhost:${options.port}

  Start a run:     npx actuate run '{...}' ${local}
  Runs and rows:   npx actuate logs [runId] ${local}
  Post an event:   npx actuate event <key> '{}' ${local}
  Tables:          curl localhost:${options.port}/tables
  Platform guards: ${guards}
${configBannerLine(configured.sources) ? `  Config:          ${configBannerLine(configured.sources)}\n` : ""}  ${meta.capabilities.filter((c) => c !== "http").length ? "Providers not set in .dev.vars print to this console (see `actuate providers`)." : ""}
`);

  const wrangler = join(packageDir("wrangler"), "bin", "wrangler.js");
  const child = spawn(
    process.execPath,
    [wrangler, "dev", "--config", join(outDir, "wrangler.json"), "--port", String(options.port), "--persist-to", join(outDir, "state"), "--test-scheduled"],
    { stdio: "inherit", cwd: outDir, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const stop = () => {
    child.kill("SIGINT");
    void ctx.dispose();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>((done) => child.on("exit", () => done()));
  await ctx.dispose();
}
