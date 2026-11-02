#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { scaffold } from "create-actuate";
import { DEFAULT_API_URL, api, readCredentials, writeCredentials, type Credentials } from "./api.js";
import { checkSource, formatDiagnostic } from "./check.js";
import { deploy } from "./deploy.js";
import { dev } from "./dev.js";

const HELP = `actuate: durable TypeScript actuators with SQLite and MCP

Usage
  actuate init [dir] [--template <name>]   Create a new actuator project
  actuate dev [file] [--port 8787]         Run locally on workerd (messages print to the console)
  actuate check [file]                     Lint for replay-safety (side effects outside ctx.step.do)
  actuate deploy [file] [--no-config]      Deploy to Actuate (sends actuate.config.json unless --no-config)
  actuate run '<json>' [--local]           Start a run with this input
  actuate logs [runId] [--local]           List recent runs, or show one run's steps and logs
  actuate login [--token <t>] [--api <url>]

  [file] defaults to actuator.ts. --local targets \`actuate dev\` on localhost:8787.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    template: { type: "string", short: "t" },
    port: { type: "string", default: "8787" },
    token: { type: "string" },
    api: { type: "string" },
    local: { type: "boolean" },
    "no-config": { type: "boolean" },
    "dry-run": { type: "boolean" },
    name: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...args] = positionals;
const cwd = process.cwd();

function actuatorName(): string {
  if (values.name) return values.name;
  const source = readFileSync("actuator.ts", "utf8");
  const m = /name:\s*["'`]([a-z][a-z0-9_]*)["'`]/.exec(source);
  if (!m) throw new Error("Could not find the actuator name in actuator.ts; pass --name.");
  return m[1]!;
}

/** Base for run APIs: the local dev runtime, or the hosted actuator. */
function target(): Credentials & { base: string } {
  if (values.local) return { apiUrl: `http://localhost:${values.port}`, token: "", base: "" };
  const creds = readCredentials();
  if (!creds) throw new Error("Not logged in. Run `actuate login`, or pass --local.");
  return { ...creds, base: `/v1/actuators/${actuatorName()}` };
}

async function main(): Promise<void> {
  if (values.help || !command || command === "help") {
    console.log(HELP);
    return;
  }
  switch (command) {
    case "init": {
      await scaffold({ dir: args[0] ?? ".", ...(values.template ? { template: values.template } : {}) });
      console.log("\nNext: npm install && npx actuate dev");
      return;
    }
    case "dev":
      return dev({ file: args[0] ?? "actuator.ts", port: Number(values.port), cwd });
    case "check": {
      const file = args[0] ?? "actuator.ts";
      const diagnostics = checkSource(file, readFileSync(file, "utf8"));
      for (const d of diagnostics) console.log(formatDiagnostic(d));
      const errors = diagnostics.filter((d) => d.severity === "error").length;
      console.log(diagnostics.length ? `\n${errors} error(s), ${diagnostics.length - errors} warning(s)` : "✓ No replay-safety problems found");
      if (errors) process.exitCode = 1;
      return;
    }
    case "deploy":
      return deploy(args[0] ?? "actuator.ts", cwd, { config: !values["no-config"], dryRun: Boolean(values["dry-run"]) });
    case "login": {
      let token = values.token;
      if (!token) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        token = (await rl.question("Paste an API token from https://actuate.run/dashboard/settings: ")).trim();
        rl.close();
      }
      if (!token) throw new Error("No token given.");
      const path = writeCredentials({ apiUrl: values.api ?? DEFAULT_API_URL, token });
      console.log(`✓ Saved credentials to ${path}`);
      return;
    }
    case "run": {
      const t = target();
      const input = args[0] ? JSON.parse(args[0]) : {};
      console.log(JSON.stringify(await api(t, `${t.base}/run`, { method: "POST", body: JSON.stringify(input) }), null, 2));
      return;
    }
    case "logs": {
      const t = target();
      if (args[0]) {
        const run = await api<{ status: string; steps: Array<Record<string, unknown>>; logs: Array<Record<string, unknown>> } & Record<string, unknown>>(
          t,
          `${t.base}/runs/${encodeURIComponent(args[0])}`,
        );
        console.log(`${run.runId}  ${run.status}`);
        for (const s of run.steps) console.log(`  step  ${String(s.status).padEnd(16)} ${s.name}${s.error ? `  (${s.error})` : ""}`);
        for (const l of run.logs) console.log(`  ${new Date(Number(l.ts)).toISOString()}  ${String(l.level).padEnd(5)} ${l.message}`);
        if (run.error) console.log(`  error ${JSON.stringify(run.error)}`);
        return;
      }
      const runs = await api<Array<Record<string, unknown>>>(t, `${t.base}/runs?limit=20`);
      for (const r of runs) console.log(`${r.runId}  ${String(r.status).padEnd(10)} ${new Date(Number(r.createdAt)).toISOString()}  ${(r.trigger as { kind: string }).kind}`);
      if (!runs.length) console.log("No runs yet.");
      return;
    }
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
