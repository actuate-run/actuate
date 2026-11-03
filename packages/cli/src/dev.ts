import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { context } from "esbuild";
import { CliError, describePlan, type ResolvedPlan } from "./account.js";
import { checkSource, formatDiagnostic } from "./check.js";
import { readConfigFile, formatIssue } from "./deploy.js";
import { cliResolve, describeActuator, loadActuator, ownModule, packageDir, workerBuildOptions } from "./load.js";
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
export function devEntry(actuatorPath: string, port: number, plan: PlanId | null = null): string {
  return `import { createDevRuntime } from ${JSON.stringify(ownModule("dev-runtime"))};
import { devProviders } from ${JSON.stringify(cliResolve("@actuate/runtime"))};
import { providersFromEnv, parseProviderWebhookFromEnv } from ${JSON.stringify(cliResolve("@actuate/providers"))};
import actuator from ${JSON.stringify(actuatorPath)};

// Real providers where .dev.vars selects them (ACTUATE_MESSAGING=telegram, ...); console and fake payments otherwise.
const runtime = createDevRuntime(actuator, {
  plan: ${JSON.stringify(plan)},
  providers: (env, publicUrl) => {
    const base = publicUrl || "http://localhost:${port}";
    return { ...devProviders(base), ...providersFromEnv(env, base) };
  },
  providerWebhook: (kind, request, env) => parseProviderWebhookFromEnv(env, kind, request),
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
  const config = readConfigFile(options.cwd);
  for (const i of platformChecks({ metadata: meta, actuator, plan: options.plan.plan, ...(config ? { config } : {}) })) console.log(`deploy check  ${formatIssue(i)}`);
  const guardsOn = options.guards !== false;
  const vars: Record<string, string> = {};
  for (const envFile of [".env", ".dev.vars"]) {
    const p = join(options.cwd, envFile);
    if (existsSync(p)) Object.assign(vars, parseEnvFile(readFileSync(p, "utf8")));
  }
  const configFile = join(options.cwd, "actuate.config.json");
  if (existsSync(configFile)) vars.ACTUATE_CONFIG = readFileSync(configFile, "utf8");
  vars.ACTUATE_DEV = "1"; // local only: admin routes and webhooks work without secrets

  writeFileSync(join(outDir, "entry.ts"), devEntry(file, options.port, guardsOn ? options.plan.plan.id : null));
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
  const guards = guardsOn ? `on, ${describePlan(options.plan)}. --no-guards turns them off` : "off (--no-guards)";
  console.log(`
  ${meta.name} running at http://localhost:${options.port}

  Start a run:     npx actuate run '{...}' ${local}
  Runs and rows:   npx actuate logs [runId] ${local}
  Post an event:   npx actuate event <key> '{}' ${local}
  Tables:          curl localhost:${options.port}/tables
  Platform guards: ${guards}
  ${meta.capabilities.filter((c) => c !== "http").length ? "Providers not set in .dev.vars print to this console (see `actuate providers`)." : ""}
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
