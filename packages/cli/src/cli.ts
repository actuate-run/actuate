/**
 * The `actuate` command: argument parsing, help, and one handler per command.
 * Heavy modules (TypeScript, esbuild, wrangler) load only in the commands that
 * need them, so `actuate --help` and `actuate logs` start fast.
 *
 * Exit codes: 0 success; 1 the command ran and failed (check errors, failed
 * tests, a refused deploy, a run that ended FAILED); 2 wrong usage.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CliError } from "./account.js";
import { ApiError, DEFAULT_API_URL, api, readCredentials, type Credentials } from "./api.js";
import { formatRun, formatRunList, type RunJson } from "./format.js";

type OptionSpec = { type: "string" | "boolean"; short?: string; arg?: string; help: string; multiple?: boolean };
type Values = Record<string, string | boolean | string[] | undefined>;

interface Command {
  name: string;
  usage: string;
  summary: string;
  description?: string;
  options: Record<string, OptionSpec>;
  examples?: string[];
  run(ctx: { args: string[]; values: Values; cwd: string; out: (line: string) => void }): Promise<number | void>;
}

const DOCS = "https://actuate.run/docs/reference/cli/";

const JSON_OPT: Record<string, OptionSpec> = { json: { type: "boolean", help: "Print JSON instead of text (for scripts and agents)" } };
const PLAN_OPT: Record<string, OptionSpec> = {
  plan: {
    type: "string",
    arg: "<plan>",
    help: "sandbox, maker or agency. Default: ACTUATE_PLAN, else your account's (asked of the API when logged in, or the plan saved at login if it can't be reached), else sandbox",
  },
};
const OFFLINE_OPT: Record<string, OptionSpec> = {
  offline: { type: "boolean", help: "Don't call the API: use --plan, ACTUATE_PLAN or the plan saved at login, and skip the account checks" },
};
const PORT_OPT: Record<string, OptionSpec> = { port: { type: "string", short: "p", arg: "<port>", help: "Port of `actuate dev` (default 8787)" } };
const TARGET_OPTS: Record<string, OptionSpec> = {
  local: { type: "boolean", help: "Talk to `actuate dev` on localhost instead of the deployed actuator" },
  ...PORT_OPT,
  name: { type: "string", arg: "<actuator>", help: "The deployed actuator's name (default: read from actuator.ts)" },
};

function str(values: Values, key: string): string | undefined {
  const v = values[key];
  return typeof v === "string" ? v : undefined;
}

function port(values: Values): number {
  const raw = str(values, "port") ?? "8787";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError(`--port must be a port number, got "${raw}".`, 2);
  return n;
}

function parseJsonArg(text: string | undefined, what: string, example: string): unknown {
  if (text === undefined) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${what} must be JSON, in single quotes: ${example}`, 2);
  }
}

/** The actuator name for hosted calls: --name, else `name:` in actuator.ts. */
function actuatorName(values: Values, cwd: string): string {
  const given = str(values, "name");
  if (given) return given;
  let source: string;
  try {
    source = readFileSync(join(cwd, "actuator.ts"), "utf8");
  } catch {
    throw new CliError("No actuator.ts here to read the actuator's name from. Pass --name <actuator>, or --local for `actuate dev`.", 2);
  }
  const m = /name:\s*["'`]([a-z][a-z0-9_]*)["'`]/.exec(source);
  if (!m) throw new CliError("Could not find the actuator name in actuator.ts; pass --name <actuator>.", 2);
  return m[1]!;
}

interface Target {
  creds: Credentials;
  base: string;
  /** Flags to repeat in suggested commands. */
  flags: string;
  local: boolean;
}

/** Where run commands go: `actuate dev` on localhost (--local), or the deployed actuator. */
function target(values: Values, cwd: string): Target {
  if (values.local) {
    const p = port(values);
    return { creds: { apiUrl: `http://localhost:${p}`, token: "" }, base: "", flags: p === 8787 ? " --local" : ` --local --port ${p}`, local: true };
  }
  const creds = readCredentials();
  if (!creds) throw new CliError("Not logged in. Run `actuate login` to reach the deployed actuator, or pass --local to use `actuate dev`.");
  const name = actuatorName(values, cwd);
  return { creds, base: `/v1/actuators/${encodeURIComponent(name)}`, flags: values.name ? ` --name ${name}` : "", local: false };
}

/** Explain the errors people actually hit when they talk to a run API. */
async function call<T>(t: Target, path: string, init?: RequestInit): Promise<T> {
  try {
    return await api<T>(t.creds, `${t.base}${path}`, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && !t.local && /actuator not found/i.test(err.message)) {
      throw new CliError(`${err.message}. Deploy it first (\`actuate deploy\`), check --name, or pass --local for \`actuate dev\`.`);
    }
    if (err instanceof ApiError && err.status === 401) {
      throw new CliError(`${err.message}. ${t.local ? "Set ACTUATE_TOKEN in .dev.vars? Then this needs it too." : "Run `actuate login` with a Full token."}`);
    }
    throw err;
  }
}

async function showRun(t: Target, runId: string, out: (line: string) => void, json: boolean): Promise<RunJson> {
  const run = await call<RunJson>(t, `/runs/${encodeURIComponent(runId)}`);
  out(json ? JSON.stringify(run, null, 2) : formatRun(run, t.flags));
  return run;
}

/** The step a decision is for: --step, else the one step of that kind the run waits at. */
async function waitingStep(t: Target, runId: string, status: "WAITING_APPROVAL" | "WAITING_INPUT", given: string | undefined): Promise<string> {
  if (given) return given;
  const run = await call<RunJson>(t, `/runs/${encodeURIComponent(runId)}`);
  const waiting = (run.steps ?? []).filter((s) => s.status === status).map((s) => s.name);
  const what = status === "WAITING_INPUT" ? "question" : "approval";
  if (waiting.length === 1) return waiting[0]!;
  if (!waiting.length) throw new CliError(`${runId} is ${run.status} and waits for no ${what}.`);
  throw new CliError(`${runId} waits for ${waiting.length} ${what}s (${waiting.join(", ")}). Pass --step <name>.`, 2);
}

const COMMANDS: Command[] = [
  {
    name: "init",
    usage: "actuate init [dir] [--template <name>] [--ref <git-ref>]",
    summary: "Create a project: an actuator, an example test, package.json and tsconfig",
    description: "The folder must be empty (a .git folder is fine). Templates come from https://github.com/actuate-run/templates.",
    options: {
      template: { type: "string", short: "t", arg: "<name>", help: "Start from a template, e.g. refund-order or deposit-reminder" },
      ref: { type: "string", arg: "<git-ref>", help: "Branch or tag of the templates repository (default main)" },
    },
    examples: ["actuate init my-actuator", "actuate init my-refunds --template refund-order"],
    async run({ args, values, out }) {
      const { scaffold } = await import("create-actuate");
      const dir = args[0] ?? ".";
      try {
        await scaffold({ dir, log: out, ...(str(values, "template") ? { template: str(values, "template")! } : {}), ...(str(values, "ref") ? { ref: str(values, "ref")! } : {}) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(/not empty/.test(message) ? `${message} Pick a new folder: actuate init my-actuator` : message);
      }
      out(`
Next:
${dir === "." ? "" : `  cd ${dir}\n`}  npm install
  npx actuate dev       run it locally, with the platform's guards
  npx actuate test      run actuator.test.ts
  npx actuate doctor    check Node, providers and login

Docs: https://actuate.run/docs/getting-started/quickstart/`);
    },
  },
  {
    name: "dev",
    usage: "actuate dev [file] [--port 8787] [--plan <plan>] [--no-guards]",
    summary: "Run locally on workerd with real SQLite and alarms, and the platform's guards",
    description: `Rebuilds on save. Prints messages and approval links to the console unless .dev.vars picks real providers.

The hosted platform's guards apply, for a plan: per pass at most 1,000 ctx.db statements, 1,000 steps, 20,000 rows written, 5,000,000 rows read, 50 ctx.http requests and 30 s; step results at most 1 MiB; no recursive queries, PRAGMA, ATTACH, printf, randomblob and the like; the plan's longest wait (7 days on Sandbox) and passes per run (200 on Sandbox). A guard fails the pass with the platform's message. Rows are metered with Cloudflare's own counters and shown by \`actuate logs --local\`.`,
    options: {
      ...PORT_OPT,
      ...PLAN_OPT,
      ...OFFLINE_OPT,
      "no-guards": { type: "boolean", help: "Don't apply the platform's guards" },
    },
    examples: ["actuate dev", "actuate dev --plan maker", "actuate dev --port 8790 --no-guards"],
    async run({ args, values, cwd }) {
      const [{ dev }, { resolvePlan }] = await Promise.all([import("./dev.js"), import("./account.js")]);
      const plan = await resolvePlan(str(values, "plan"), { online: !values.offline });
      await dev({ file: args[0] ?? "actuator.ts", port: port(values), cwd, plan, guards: !values["no-guards"] });
    },
  },
  {
    name: "test",
    usage: "actuate test [files or folders...] [--watch] [--grep <pattern>] [--plan <plan>]",
    summary: "Run the project's tests (Vitest if they use it, otherwise node:test)",
    description: `Finds *.test.ts and *.spec.ts files outside node_modules. Files that import vitest run with the project's Vitest; the rest run with node --test, TypeScript included, no setup needed.

Write tests with @actuate/cli/testing: testActuator(actuator) gives the real step engine on node:sqlite, a clock you move (t.advance("1 day")), recording fakes for messaging, payment, llm and http, t.approve() / t.answer() / t.event() / t.pay(), t.rows(table), and rows read and written per run (t.usage(runId)). The platform's guards apply for --plan, passed to tests as ACTUATE_PLAN; a test can pick its own with testActuator(actuator, { plan }).

Alongside the tests, actuator.ts's deploy checks run locally (no network, not in --watch) and print after them, only if they find something; they never fail the tests. With no test files, actuate test exits 1 so an empty suite doesn't look green in CI; --pass-with-no-tests exits 0.`,
    options: {
      watch: { type: "boolean", short: "w", help: "Re-run on changes (Vitest and node:test files side by side when both kinds exist)" },
      grep: { type: "string", short: "g", arg: "<pattern>", help: "Only tests whose name matches" },
      ...PLAN_OPT,
      ...OFFLINE_OPT,
      "no-checks": { type: "boolean", help: "Skip the deploy checks reported after the tests" },
      "pass-with-no-tests": { type: "boolean", help: "Exit 0 when there are no test files" },
    },
    examples: ["actuate test", "actuate test actuator.test.ts --watch", "actuate test --grep refund --plan maker"],
    async run({ args, values, cwd }) {
      const [{ runTests }, { resolvePlan }] = await Promise.all([import("./test-runner.js"), import("./account.js")]);
      const plan = await resolvePlan(str(values, "plan"), { online: !values.offline });
      return runTests({
        cwd,
        paths: args,
        watch: Boolean(values.watch),
        plan,
        checks: !values["no-checks"],
        passWithNoTests: Boolean(values["pass-with-no-tests"]),
        ...(str(values, "grep") ? { grep: str(values, "grep")! } : {}),
      });
    },
  },
  {
    name: "check",
    usage: "actuate check [file] [--platform] [--plan <plan>] [--json]",
    summary: "Lint for replay safety; with --platform, also run the platform's deploy checks",
    description: `Replay safety: side effects and non-determinism outside ctx.step.do (fetch, provider calls, Date.now(), new Date(), Math.random(), crypto.randomUUID(); writes through ctx.db as warnings).

--platform also bundles the actuator and runs the hosted platform's deploy checks locally, so a deploy that would be refused (and still count against your deploy budget) stops here: bundle size, cron count and frequency for the plan, the cron input, http.allow, regexes in the input schema, capabilities on the plan, actuate.config.json against the config schema; logged in, also providers set up, actuator count and deploys left this month. They mirror the platform's rules; the platform has the final say.`,
    options: {
      platform: { type: "boolean", help: "Also run the platform's deploy checks (bundles the actuator)" },
      ...PLAN_OPT,
      ...OFFLINE_OPT,
      ...JSON_OPT,
    },
    examples: ["actuate check", "actuate check --platform", "actuate check --platform --plan sandbox --json"],
    async run({ args, values, cwd, out }) {
      const file = args[0] ?? "actuator.ts";
      const json = Boolean(values.json);
      const { checkSource, formatDiagnostic } = await import("./check.js");
      let source: string;
      try {
        source = readFileSync(resolve(cwd, file), "utf8");
      } catch {
        throw new CliError(`${file} not found. Run this in your project folder, or pass the actuator file.`);
      }
      const diagnostics = checkSource(file, source);
      let errors = diagnostics.filter((d) => d.severity === "error").length;
      let warnings = diagnostics.length - errors;
      // --plan only means something for the deploy checks, so it implies --platform.
      if (!values.platform && values.plan === undefined && !values.offline) {
        if (json) out(JSON.stringify({ ok: errors === 0, file, diagnostics, errors, warnings }, null, 2));
        else {
          for (const d of diagnostics) out(formatDiagnostic(d));
          out(diagnostics.length ? `\n${errors} error(s), ${warnings} warning(s)` : "✓ No replay-safety problems found");
          out("  (`actuate check --platform` also runs the hosted platform's deploy checks.)");
        }
        return errors ? 1 : 0;
      }
      if (!json) for (const d of diagnostics) out(formatDiagnostic(d));
      if (!json && !diagnostics.length) out("✓ No replay-safety problems found");
      const { deployChecks } = await import("./deploy.js");
      const checked = await deployChecks(file, cwd, { withConfig: true, ...(str(values, "plan") ? { plan: str(values, "plan")! } : {}), log: json ? () => {} : out, stopOnLintErrors: false, offline: Boolean(values.offline) });
      errors += checked.issues.filter((i) => i.severity === "error").length;
      warnings += checked.issues.filter((i) => i.severity === "warning").length;
      if (json) {
        out(
          JSON.stringify(
            {
              ok: errors === 0,
              file,
              diagnostics,
              platform: { plan: checked.resolved.plan.id, planSource: checked.resolved.source, issues: checked.issues, skipped: checked.account.notes },
              errors,
              warnings,
            },
            null,
            2,
          ),
        );
      } else out(`\n${errors} error(s), ${warnings} warning(s)`);
      return errors ? 1 : 0;
    },
  },
  {
    name: "deploy",
    usage: "actuate deploy [file] [--dry-run] [--no-config] [--plan <plan>] [--force] [--json]",
    summary: "Check, bundle and deploy to Actuate",
    description: `1. Runs actuate check and stops on errors.
2. Bundles the actuator and runs the platform's deploy checks locally (see \`actuate check --help\`), and, logged in, the account's: providers set up, actuator count, deploys left this month. Stops on errors: a refused deploy still counts against the deploy budget.
3. If the deployed version already runs this exact code, updates only the configuration (no deploy used), or does nothing.
4. Uploads the bundle with actuate.config.json and prints the URLs.

--dry-run stops before step 3 and prints the metadata. It uploads nothing and doesn't count as a deploy; logged in, it still reads your account to run its checks.`,
    options: {
      "dry-run": { type: "boolean", help: "Check and bundle; print the metadata; upload nothing" },
      "no-config": { type: "boolean", help: "Don't send actuate.config.json" },
      ...PLAN_OPT,
      force: { type: "boolean", help: "Deploy even if the local checks find errors or nothing changed" },
      ...JSON_OPT,
    },
    examples: ["actuate deploy --dry-run", "actuate deploy", "ACTUATE_API_TOKEN=ak_... actuate deploy --json"],
    async run({ args, values, cwd, out }) {
      const { deploy } = await import("./deploy.js");
      return deploy(args[0] ?? "actuator.ts", cwd, {
        log: out,
        config: !values["no-config"],
        dryRun: Boolean(values["dry-run"]),
        force: Boolean(values.force),
        json: Boolean(values.json),
        ...(str(values, "plan") ? { plan: str(values, "plan")! } : {}),
      });
    },
  },
  {
    name: "run",
    usage: "actuate run ['<json>'] [--local] [--idempotency-key <key>] [--json]",
    summary: "Start a run with this input and show where it got to",
    description:
      "Prints the run's status, passes (and, under actuate dev, rows), steps and what to do next. Exits 1 if the run ended FAILED.\n\n--json prints the run record as POST /run returns it (runId, status, output, error, passes, and usage under actuate dev), whatever its status; `actuate logs <runId> --json` gives the run with its steps and logs.",
    options: { ...TARGET_OPTS, "idempotency-key": { type: "string", arg: "<key>", help: "A retry with the same key returns the first run" }, ...JSON_OPT },
    examples: [`actuate run '{"name":"Aina"}' --local`, `actuate run '{"orderId":"A-1001"}' --idempotency-key refund-A-1001`],
    async run({ args, values, cwd, out }) {
      const input = parseJsonArg(args[0], "The input", `actuate run '{"name":"Aina"}'`);
      const t = target(values, cwd);
      const key = str(values, "idempotency-key");
      const started = await call<RunJson>(t, "/run", { method: "POST", body: JSON.stringify(input), ...(key ? { headers: { "idempotency-key": key } } : {}) });
      if (values.json) {
        // Always the run record POST /run returned; `actuate logs <runId> --json` adds steps and logs.
        out(JSON.stringify(started, null, 2));
        return started.status === "FAILED" ? 1 : 0;
      }
      // Steps (and what the run waits for) come with the full run.
      const run = started.status === "WAITING" || started.status === "RUNNING" ? await call<RunJson>(t, `/runs/${encodeURIComponent(started.runId)}`) : started;
      out(`${formatRun(run, t.flags)}\n\nLogs: actuate logs ${run.runId}${t.flags}`);
      return run.status === "FAILED" ? 1 : 0;
    },
  },
  {
    name: "logs",
    usage: "actuate logs [runId] [--local] [--status <status>] [--limit <n>] [--json]",
    summary: "List recent runs, or show one run's steps, logs, passes and rows",
    description: "Rows read and written per run are shown under actuate dev (--local), metered with Cloudflare's own counters. The hosted API doesn't report them per run yet.",
    options: {
      ...TARGET_OPTS,
      status: { type: "string", arg: "<status>", help: "Only runs with this status: RUNNING, WAITING, COMPLETED, FAILED or CANCELLED" },
      limit: { type: "string", arg: "<n>", help: "How many runs to list (default 20, at most 500)" },
      ...JSON_OPT,
    },
    examples: ["actuate logs --local", "actuate logs run_0190f3c2a1b2... --local", "actuate logs --status FAILED --json"],
    async run({ args, values, cwd, out }) {
      const t = target(values, cwd);
      if (args[0]) {
        const run = await showRun(t, args[0], out, Boolean(values.json));
        return run.status === "FAILED" ? 1 : 0;
      }
      const status = str(values, "status")?.toUpperCase();
      if (status && !["RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED"].includes(status)) {
        throw new CliError(`--status must be RUNNING, WAITING, COMPLETED, FAILED or CANCELLED, got "${str(values, "status")}".`, 2);
      }
      const limit = Number(str(values, "limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1) throw new CliError("--limit must be a positive whole number.", 2);
      const runs = await call<RunJson[]>(t, `/runs?limit=${Math.min(limit, 500)}${status ? `&status=${status}` : ""}`);
      out(values.json ? JSON.stringify(runs, null, 2) : formatRunList(runs));
    },
  },
  {
    name: "event",
    usage: "actuate event <key> ['<json>'] [--local] [--json]",
    summary: "Post an event: resumes runs waiting for it, or buffers it",
    description: "A dev payment is paid with the event payment.<referenceId>, e.g. actuate event payment.run_0190... '{\"status\":\"paid\"}' --local.",
    options: { ...TARGET_OPTS, ...JSON_OPT },
    examples: [`actuate event payment.A-1001 '{"status":"paid"}' --local`, "actuate event order.shipped.A-1001"],
    async run({ args, values, cwd, out }) {
      const key = args[0];
      if (!key) throw new CliError("Which event? actuate event <key> ['<json>']", 2);
      const payload = parseJsonArg(args[1], "The payload", `actuate event ${key} '{"status":"paid"}'`);
      const t = target(values, cwd);
      const res = await call<{ resumed: string[]; buffered: boolean }>(t, `/events/${encodeURIComponent(key)}`, { method: "POST", body: JSON.stringify(payload) });
      if (values.json) out(JSON.stringify(res, null, 2));
      else if (res.resumed.length) out(`✓ ${key}: resumed ${res.resumed.join(", ")}\n\nSee where ${res.resumed.length === 1 ? "it" : "they"} got to: actuate logs ${res.resumed[0]}${t.flags}`);
      else out(`No run is waiting for ${key}: buffered, so a run that waits for it later gets it at once.`);
    },
  },
  ...(["approve", "reject"] as const).map(
    (decision): Command => ({
      name: decision,
      usage: `actuate ${decision} <runId> [--step <name>] [--note <text>] [--local] [--json]`,
      summary: decision === "approve" ? "Approve a run waiting in waitForApproval" : "Reject a run waiting in waitForApproval",
      description: "--step defaults to the one approval the run waits for. The decision is recorded as made through the API, by the owner.",
      options: {
        step: { type: "string", arg: "<name>", help: "The waiting step (needed when a run waits at several)" },
        note: { type: "string", arg: "<text>", help: "A note the run receives in ApprovalResult.note" },
        ...TARGET_OPTS,
        ...JSON_OPT,
      },
      examples: [`actuate ${decision} run_0190f3c2a1b2... --local`, `actuate ${decision} run_0190f3c2a1b2... --step manager-ok --note "${decision === "approve" ? "ok, refund it" : "not this one"}"`],
      async run({ args, values, cwd, out }) {
        const runId = args[0];
        if (!runId) throw new CliError(`Which run? actuate ${decision} <runId>  (actuate logs${values.local ? " --local" : ""} --status WAITING lists them)`, 2);
        const t = target(values, cwd);
        const step = await waitingStep(t, runId, "WAITING_APPROVAL", str(values, "step"));
        const note = str(values, "note");
        const res = await call<{ ok: boolean; reason?: string }>(t, `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(step)}/${decision}`, {
          method: "POST",
          body: JSON.stringify(note ? { note } : {}),
        });
        if (!res.ok) throw new CliError(res.reason ?? `Could not ${decision} "${step}".`);
        if (!values.json) out(`✓ ${decision === "approve" ? "Approved" : "Rejected"} "${step}"\n`);
        const run = await showRun(t, runId, out, Boolean(values.json));
        return run.status === "FAILED" ? 1 : 0;
      },
    }),
  ),
  {
    name: "answer",
    usage: "actuate answer <runId> <text> [--step <name>] [--local] [--json]",
    summary: "Answer a run waiting in waitForInput",
    options: { step: { type: "string", arg: "<name>", help: "The waiting step (needed when a run waits at several)" }, ...TARGET_OPTS, ...JSON_OPT },
    examples: [`actuate answer run_0190f3c2a1b2... "Tell them it ships Monday" --local`],
    async run({ args, values, cwd, out }) {
      const [runId, text] = args;
      if (!runId || text === undefined) throw new CliError('Usage: actuate answer <runId> "<text>"', 2);
      const t = target(values, cwd);
      const step = await waitingStep(t, runId, "WAITING_INPUT", str(values, "step"));
      const res = await call<{ ok: boolean; reason?: string }>(t, `/runs/${encodeURIComponent(runId)}/inputs/${encodeURIComponent(step)}`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new CliError(res.reason ?? `Could not answer "${step}".`);
      if (!values.json) out(`✓ Answered "${step}"\n`);
      const run = await showRun(t, runId, out, Boolean(values.json));
      return run.status === "FAILED" ? 1 : 0;
    },
  },
  {
    name: "cancel",
    usage: "actuate cancel <runId> [--local] [--json]",
    summary: "Cancel a running or waiting run",
    options: { ...TARGET_OPTS, ...JSON_OPT },
    examples: ["actuate cancel run_0190f3c2a1b2... --local"],
    async run({ args, values, cwd, out }) {
      const runId = args[0];
      if (!runId) throw new CliError("Which run? actuate cancel <runId>", 2);
      const t = target(values, cwd);
      const res = await call<{ cancelled: boolean }>(t, `/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
      if (values.json) out(JSON.stringify(res, null, 2));
      else out(res.cancelled ? `✓ Cancelled ${runId}` : `${runId} was not running or waiting, so there was nothing to cancel.`);
      return res.cancelled ? 0 : 1;
    },
  },
  {
    name: "login",
    usage: "actuate login [--token <token>] [--api <url>]",
    summary: "Save an API token for deploy, run and logs",
    description: "Create a Full token in the dashboard (Settings → API tokens). The token is checked against the API and saved with mode 0600.",
    options: {
      token: { type: "string", arg: "<token>", help: "The token (otherwise you are asked for it)" },
      api: { type: "string", arg: "<url>", help: `API URL (default ${DEFAULT_API_URL})` },
    },
    examples: ["actuate login", "actuate login --token ak_..."],
    async run({ values, out }) {
      const { writeCredentials, fetchMe } = await import("./api.js");
      let token = str(values, "token");
      if (!token) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        token = (await rl.question("Paste an API token from https://app.actuate.run/settings/tokens (a full token): ")).trim();
        rl.close();
      }
      if (!token) throw new CliError("No token given.", 2);
      const creds: Credentials = { apiUrl: str(values, "api") ?? DEFAULT_API_URL, token };
      let who = "";
      try {
        const me = await fetchMe(creds);
        if (typeof me.plan === "string") creds.plan = me.plan;
        if (me.email) creds.email = me.email;
        who = ` as ${me.email ?? "your account"}${typeof me.plan === "string" ? ` (${me.plan} plan)` : ""}`;
        // Agent (run-scoped) tokens can read /v1/me but nothing else the CLI needs.
        await api(creds, "/v1/tokens").catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 403) {
            throw new CliError("That is an agent (run-scoped) token: it can only start and read runs. Create a Full token for the CLI.");
          }
        });
      } catch (err) {
        if (err instanceof CliError) throw err;
        if (err instanceof ApiError && err.status === 401) throw new CliError("That token was rejected. Copy a Full token from Settings → API tokens.");
        out(`warn  Could not check the token (${err instanceof Error ? err.message : String(err)}); saving it anyway.`);
      }
      const path = writeCredentials(creds);
      out(`✓ Logged in${who}. Saved to ${path}`);
    },
  },
  {
    name: "doctor",
    usage: "actuate doctor [file] [--offline] [--plan <plan>] [--json]",
    summary: "Check Node, the project, its deploy checks, providers in .dev.vars, and login",
    options: { ...OFFLINE_OPT, ...PLAN_OPT, ...JSON_OPT },
    examples: ["actuate doctor", "actuate doctor --json"],
    async run({ args, values, cwd, out }) {
      const { doctor, formatDoctor } = await import("./doctor.js");
      const results = await doctor(cwd, args[0] ?? "actuator.ts", { offline: Boolean(values.offline), ...(str(values, "plan") ? { plan: str(values, "plan")! } : {}) });
      out(values.json ? JSON.stringify(results, null, 2) : formatDoctor(results));
      return results.some((r) => r.status === "fail") ? 1 : 0;
    },
  },
  {
    name: "providers",
    usage: "actuate providers [--json]",
    summary: "List providers and the .dev.vars entries each one reads",
    options: { ...JSON_OPT },
    async run({ values, out }) {
      const { PROVIDERS, envVarsFor } = await import("@actuate/providers");
      if (values.json) {
        out(JSON.stringify(Object.values(PROVIDERS).map((p) => ({ kind: p.kind, capability: p.capability, label: p.label, env: envVarsFor(p.kind) })), null, 2));
        return;
      }
      out("Select a provider per capability in .dev.vars (local) and set its credentials:\n");
      for (const cap of ["messaging", "payment", "llm"] as const) {
        out(`ACTUATE_${cap.toUpperCase()}=<${Object.values(PROVIDERS).filter((p) => p.capability === cap).map((p) => p.kind).join(" | ")}>`);
      }
      out("Messaging can list several, e.g. ACTUATE_MESSAGING=whatsapp,slack: the first is the default, others are picked with send(..., { channel }).");
      for (const p of Object.values(PROVIDERS)) {
        out(`\n${p.label} (ACTUATE_${p.capability.toUpperCase()}=${p.kind})`);
        for (const v of envVarsFor(p.kind)) out(`  ${v.name}${v.optional ? "  (optional)" : ""}  ${v.label}`);
      }
      out("\nOn the hosted platform, set providers in the dashboard instead (Settings → Providers).");
    },
  },
];

const GROUPS: Array<[string, string[]]> = [
  ["Start", ["init", "doctor"]],
  ["Develop", ["dev", "test", "check"]],
  ["Runs (with --local: actuate dev; otherwise the deployed actuator)", ["run", "logs", "event", "approve", "reject", "answer", "cancel"]],
  ["Deploy", ["deploy", "login", "providers"]],
];

export function mainHelp(): string {
  const lines = ["actuate: durable TypeScript actuators with SQLite, served over MCP when deployed to Actuate", "", "Usage: actuate <command> [options]"];
  for (const [title, names] of GROUPS) {
    lines.push("", title);
    for (const n of names) {
      const c = COMMANDS.find((x) => x.name === n)!;
      lines.push(`  ${n.padEnd(10)} ${c.summary}`);
    }
  }
  lines.push(
    "",
    "Run `actuate <command> --help` for its options and examples. [file] defaults to actuator.ts.",
    "A typical loop: actuate check && actuate test, then actuate dev, then actuate deploy --dry-run && actuate deploy.",
    "Exit codes: 0 success, 1 failure (errors found, tests failed, deploy refused, run FAILED), 2 wrong usage.",
    `Docs: ${DOCS}`,
  );
  return lines.join("\n");
}

export function commandHelp(c: Command): string {
  const lines = [`Usage: ${c.usage}`, "", c.summary + "."];
  if (c.description) lines.push("", c.description);
  const opts = Object.entries({ ...c.options, help: { type: "boolean", short: "h", help: "Show this help" } as OptionSpec });
  lines.push("", "Options");
  const labels = opts.map(([name, o]) => `${o.short ? `-${o.short}, ` : "    "}--${name}${o.arg ? ` ${o.arg}` : ""}`);
  const width = Math.max(...labels.map((l) => l.length));
  opts.forEach(([, o], i) => lines.push(`  ${labels[i]!.padEnd(width)}  ${o.help}`));
  if (c.examples?.length) lines.push("", "Examples", ...c.examples.map((e) => `  ${e}`));
  lines.push("", `Docs: ${DOCS}#actuate-${c.name}`);
  return lines.join("\n");
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length]![b.length]!;
}

export function suggest(name: string): string | null {
  const best = COMMANDS.map((c) => ({ name: c.name, d: distance(name, c.name) })).sort((x, y) => x.d - y.d)[0];
  return best && best.d <= 2 ? best.name : null;
}

function version(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

/** Run the CLI with these arguments. Resolves to the exit code; never throws. */
export async function main(argv: string[], io: { out?: (line: string) => void; err?: (line: string) => void; cwd?: string } = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  const cwd = io.cwd ?? process.cwd();
  const [first, ...rest] = argv;
  if (!first || first === "--help" || first === "-h") {
    out(mainHelp());
    return 0;
  }
  if (first === "--version" || first === "-v") {
    out(version());
    return 0;
  }
  if (first === "help") {
    const c = COMMANDS.find((x) => x.name === rest[0]);
    out(c ? commandHelp(c) : mainHelp());
    return c || !rest[0] ? 0 : 2;
  }
  const command = COMMANDS.find((c) => c.name === first);
  if (!command) {
    const guess = suggest(first);
    err(`✗ Unknown command "${first}".${guess ? ` Did you mean \`actuate ${guess}\`?` : ""} Run \`actuate --help\` for the list.`);
    return 2;
  }
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { ...Object.fromEntries(Object.entries(command.options).map(([k, o]) => [k, { type: o.type, ...(o.short ? { short: o.short } : {}) }])), help: { type: "boolean", short: "h" } },
    }) as { values: Values; positionals: string[] };
  } catch (e) {
    err(`✗ ${(e as Error).message.replace(/\. To specify a positional argument.*$/s, ".")}\n  Run \`actuate ${command.name} --help\` for its options.`);
    return 2;
  }
  if (parsed.values.help) {
    out(commandHelp(command));
    return 0;
  }
  try {
    const code = await command.run({ args: parsed.positionals, values: parsed.values, cwd, out });
    return typeof code === "number" ? code : 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // With --json, stdout always carries one JSON object, failures included.
    if (parsed.values.json) out(JSON.stringify({ ok: false, error: message, ...(e instanceof CliError ? e.details : {}) }, null, 2));
    err(`✗ ${message}`);
    if (!(e instanceof CliError) && !(e instanceof ApiError) && process.env.ACTUATE_DEBUG && e instanceof Error && e.stack) err(e.stack);
    return e instanceof CliError ? e.exitCode : 1;
  }
}
