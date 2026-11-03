import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError, describePlan, planHint, type ResolvedPlan } from "./account.js";
import { findPackage, ownModule } from "./load.js";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out"]);

/** Test files under `paths` (default: the project), outside node_modules, build output and dot-folders. */
export function findTestFiles(cwd: string, paths: readonly string[] = []): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (TEST_FILE.test(entry.name)) found.add(full);
    }
  };
  for (const p of paths.length ? paths : ["."]) {
    const full = resolve(cwd, p);
    if (!existsSync(full)) throw new CliError(`${p} not found.`, 2);
    if (statSync(full).isDirectory()) walk(full);
    else found.add(full);
  }
  return [...found].map((f) => relative(cwd, f) || f).sort();
}

/** Which runner a test file is written for: Vitest if it imports vitest, otherwise node:test. */
export function runnerFor(source: string): "vitest" | "node" {
  return /\bfrom\s+["']vitest["']|\brequire\(\s*["']vitest["']\s*\)|\bimport\(\s*["']vitest["']\s*\)/.test(source) ? "vitest" : "node";
}

/** The project's own Vitest, if it has one. */
export function findVitest(cwd: string): string | null {
  const dir = findPackage(cwd, "vitest");
  if (!dir) return null;
  const bin = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { bin?: string | Record<string, string> }).bin;
  const rel = typeof bin === "string" ? bin : bin?.vitest;
  return rel ? join(dir, rel) : null;
}

/** node:sqlite needs a flag before Node 22.13. */
export function nodeFlags(version = process.versions.node): string[] {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major === 22 && minor < 13 ? ["--experimental-sqlite"] : [];
}

export interface TestRunOptions {
  cwd: string;
  paths: string[];
  watch: boolean;
  /** Only tests whose name matches this pattern. */
  grep?: string;
  /** The plan passed to the tests as ACTUATE_PLAN (the default for testActuator). */
  plan: ResolvedPlan;
  /** Run actuator.ts's local deploy checks first and print what they find (default true). */
  checks?: boolean;
  /** Exit 0 instead of 1 when there are no test files. */
  passWithNoTests?: boolean;
  /** Extra environment for the test processes. */
  env?: Record<string, string>;
  log?: (line: string) => void;
}

/**
 * actuator.ts's deploy checks, locally and offline, as lines to print after the tests: nothing when
 * they pass, so `npm test` mentions a cron or plan mistake without being noisy. They never fail the tests.
 */
export async function deployCheckHeader(cwd: string, plan: ResolvedPlan): Promise<string[]> {
  const file = join(cwd, "actuator.ts");
  if (!existsSync(file)) return [];
  const [{ loadActuator, describeActuator }, { platformChecks }, { readConfigFile, formatIssue }] = await Promise.all([
    import("./load.js"),
    import("./platform-checks.js"),
    import("./deploy.js"),
  ]);
  let actuator: Awaited<ReturnType<typeof loadActuator>>;
  try {
    actuator = await loadActuator(file, join(cwd, ".actuate", "tmp"));
  } catch (err) {
    return [`Deploy checks skipped: actuator.ts doesn't load (${err instanceof Error ? err.message.split("\n")[0] : String(err)}).`];
  }
  const config = readConfigFile(cwd);
  const issues = platformChecks({ metadata: describeActuator(actuator), actuator, plan: plan.plan, planDefaulted: plan.source === "default", ...(config ? { config } : {}) });
  if (!issues.length) return [];
  const errors = issues.filter((i) => i.severity === "error").length;
  return [
    `Deploy checks for actuator.ts, ${describePlan(plan)}: ${errors} error(s), ${issues.length - errors} warning(s). They don't fail the tests; \`actuate check --platform\` has the details.`,
    ...issues.map((i) => `  ${formatIssue(i)}`),
    "",
  ];
}

export const NO_TESTS_HELP = `No test files found (*.test.ts or *.spec.ts, outside node_modules).

Add one next to your actuator, e.g. actuator.test.ts:

  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { testActuator } from "@actuate/cli/testing";
  import actuator from "./actuator.js";

  test("completes", async () => {
    const t = testActuator(actuator);
    const run = await t.start({ /* input */ });
    await t.advance("1 day");                     // fire sleeps, retries and timeouts
    assert.equal(t.run(run.runId).status, "COMPLETED");
    assert.ok(t.usage(run.runId).rowsWritten < 50); // a budget for rows written
  });

Then run \`actuate test\`. Docs: https://actuate.run/docs/guides/best-practices/#test-before-you-deploy`;

function exec(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", fail);
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

/**
 * `actuate test`: find the project's test files and run them, with the
 * project's Vitest for files that import it and `node --test` (with
 * TypeScript support) for the rest. Resolves to the exit code.
 */
export async function runTests(opts: TestRunOptions): Promise<number> {
  const log = opts.log ?? console.log;
  const note = (line: string) => process.stderr.write(`${line}\n`);
  const files = findTestFiles(opts.cwd, opts.paths);
  if (!files.length) {
    log(NO_TESTS_HELP);
    return opts.passWithNoTests ? 0 : 1;
  }
  const byRunner = { vitest: [] as string[], node: [] as string[] };
  for (const f of files) byRunner[runnerFor(readFileSync(resolve(opts.cwd, f), "utf8"))].push(f);
  const vitest = byRunner.vitest.length ? findVitest(opts.cwd) : null;
  const skipped = vitest ? [] : byRunner.vitest;
  if (skipped.length && !byRunner.node.length) {
    throw new CliError(`${skipped.join(", ")} ${skipped.length === 1 ? "imports" : "import"} vitest, which isn't installed here. Run \`npm install -D vitest\`, or write the tests with node:test.`);
  }

  // The deploy checks run alongside the tests (they take about as long as a small suite) and report after them.
  const checks = opts.checks === false || opts.watch ? Promise.resolve([]) : deployCheckHeader(opts.cwd, opts.plan).catch(() => []);
  // Tests are about to run: say which plan's guards apply, once.
  note(`Platform guards: ${describePlan(opts.plan)}, unless a test passes testActuator(actuator, { plan }).${planHint(opts.plan) ? ` ${planHint(opts.plan)}` : ""}`);

  const env = {
    ...opts.env,
    ACTUATE_PLAN: opts.plan.plan.id,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim(),
  };
  const runs: Array<() => Promise<number>> = [];
  if (vitest) {
    const args = [vitest, opts.watch ? "watch" : "run", ...(opts.grep ? ["-t", opts.grep] : []), ...byRunner.vitest];
    runs.push(() => exec(process.execPath, args, opts.cwd, env));
  }
  if (byRunner.node.length) {
    const args = [
      ...nodeFlags(),
      "--enable-source-maps",
      "--import",
      pathToFileURL(ownModule("test-register")).href,
      "--test",
      // Readable for people and agents alike; node's default off a terminal is TAP.
      "--test-reporter=spec",
      ...(opts.watch ? ["--watch"] : []),
      ...(opts.grep ? [`--test-name-pattern=${opts.grep}`] : []),
      ...byRunner.node,
    ];
    runs.push(() => exec(process.execPath, args, opts.cwd, env));
  }
  let code = 0;
  if (opts.watch && runs.length > 1) {
    // Watching both kinds: run the two watchers side by side (their output interleaves; Ctrl-C stops both).
    note("Watching with Vitest and node --test side by side.");
    code = Math.max(...(await Promise.all(runs.map((r) => r()))));
  } else {
    for (const r of runs) code = Math.max(code, await r());
  }
  const found = await checks;
  if (found.length) note(`\n${found.join("\n").trimEnd()}`);
  if (skipped.length) {
    note(`\n✗ Skipped ${skipped.join(", ")}: ${skipped.length === 1 ? "it imports" : "they import"} vitest, which isn't installed here. Run \`npm install -D vitest\`, or write ${skipped.length === 1 ? "it" : "them"} with node:test.`);
    code = Math.max(code, 1);
  }
  return code;
}
