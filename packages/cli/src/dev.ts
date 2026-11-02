import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { context } from "esbuild";
import { checkSource, formatDiagnostic } from "./check.js";
import { cliResolve, describeActuator, loadActuator, packageDir, workerBuildOptions } from "./load.js";

export interface DevOptions {
  file: string;
  port: number;
  cwd: string;
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

export function devEntry(actuatorPath: string, port: number): string {
  return `import { createRuntime } from ${JSON.stringify(cliResolve("@actuate/runtime/worker"))};
import { devProviders } from ${JSON.stringify(cliResolve("@actuate/runtime"))};
import actuator from ${JSON.stringify(actuatorPath)};

const runtime = createRuntime(actuator, {
  providers: (_env, publicUrl) => devProviders(publicUrl || "http://localhost:${port}"),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
`;
}

export async function dev(options: DevOptions): Promise<void> {
  const file = resolve(options.cwd, options.file);
  if (!existsSync(file)) throw new Error(`${options.file} not found. Run \`actuate init\` first.`);
  const outDir = join(options.cwd, ".actuate");
  mkdirSync(outDir, { recursive: true });

  for (const d of checkSource(options.file, readFileSync(file, "utf8"))) console.log(formatDiagnostic(d));

  const meta = describeActuator(await loadActuator(file, join(outDir, "tmp")));
  const vars: Record<string, string> = {};
  for (const envFile of [".env", ".dev.vars"]) {
    const p = join(options.cwd, envFile);
    if (existsSync(p)) Object.assign(vars, parseEnvFile(readFileSync(p, "utf8")));
  }
  const configFile = join(options.cwd, "actuate.config.json");
  if (existsSync(configFile)) vars.ACTUATE_CONFIG = readFileSync(configFile, "utf8");

  writeFileSync(join(outDir, "entry.ts"), devEntry(file, options.port));
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

  console.log(`
  ${meta.name} running at http://localhost:${options.port}

  Start a run:     curl -X POST localhost:${options.port}/run -H 'content-type: application/json' -d '{...}'
  List runs:       curl localhost:${options.port}/runs
  Post an event:   curl -X POST localhost:${options.port}/events/<key> -d '{}'
  Tables:          curl localhost:${options.port}/tables
  Messages and payment links are printed here instead of sent.
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
