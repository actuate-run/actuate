import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "./account.js";
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
  /** Environment for the test processes (ACTUATE_PLAN, ...). */
  env: Record<string, string>;
  log?: (line: string) => void;
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
  const files = findTestFiles(opts.cwd, opts.paths);
  if (!files.length) {
    log(NO_TESTS_HELP);
    return 1;
  }
  const byRunner = { vitest: [] as string[], node: [] as string[] };
  for (const f of files) byRunner[runnerFor(readFileSync(resolve(opts.cwd, f), "utf8"))].push(f);
  const env = { ...opts.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim() };
  if (opts.watch && byRunner.vitest.length && byRunner.node.length) {
    throw new CliError("--watch runs one runner at a time: these tests mix Vitest and node:test. Pass the files to watch.", 2);
  }

  let code = 0;
  if (byRunner.vitest.length) {
    const vitest = findVitest(opts.cwd);
    if (!vitest) {
      throw new CliError(`${byRunner.vitest.join(", ")} ${byRunner.vitest.length === 1 ? "imports" : "import"} vitest, which isn't installed here. Run \`npm install -D vitest\`, or write the tests with node:test.`);
    }
    const args = [vitest, opts.watch ? "watch" : "run", ...(opts.grep ? ["-t", opts.grep] : []), ...byRunner.vitest];
    code = Math.max(code, await exec(process.execPath, args, opts.cwd, env));
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
    code = Math.max(code, await exec(process.execPath, args, opts.cwd, env));
  }
  return code;
}
