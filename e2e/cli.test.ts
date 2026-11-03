/**
 * The built `actuate` binary on a project made by `actuate init`: what a developer (or their coding agent) runs.
 * Needs `pnpm build` first (`pnpm check` does it).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "packages/cli/dist/bin.js");
let project: string;

function actuate(args: string[], cwd = project) {
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, ".config"), ACTUATE_API_TOKEN: "", ACTUATE_PLAN: "", NO_COLOR: "1" },
    timeout: 120_000,
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

beforeAll(() => {
  if (!existsSync(bin)) throw new Error("Build the packages first: pnpm build");
  const parent = mkdtempSync(join(tmpdir(), "actuate-e2e-"));
  const init = actuate(["init", "proj"], parent);
  expect(init.code, init.err).toBe(0);
  project = join(parent, "proj");
  // What `npm install` would give the project: the SDK and CLI from this repo, and Vitest for one test.
  mkdirSync(join(project, "node_modules/@actuate"), { recursive: true });
  symlinkSync(join(root, "packages/sdk"), join(project, "node_modules/@actuate/sdk"));
  symlinkSync(join(root, "packages/cli"), join(project, "node_modules/@actuate/cli"));
  symlinkSync(join(root, "node_modules/vitest"), join(project, "node_modules/vitest"));
});

describe("actuate CLI on a new project", () => {
  it("init prints the next steps", () => {
    const parent = mkdtempSync(join(tmpdir(), "actuate-e2e-"));
    const res = actuate(["init", "again"], parent);
    expect(res.out).toContain("npx actuate test");
    expect(actuate(["init", "again"], parent)).toMatchObject({ code: 1, err: expect.stringContaining("Pick a new folder") });
  });

  it("actuate test runs the scaffolded node:test file with no setup", () => {
    const res = actuate(["test"]);
    expect(res.code, res.out + res.err).toBe(0);
    expect(res.out).toContain("✔ greets, sleeps, then follows up");
    expect(res.err).toContain("Platform guards: Sandbox plan");
    expect(res.err).not.toContain("ExperimentalWarning");
  });

  it("actuate test fails when a test fails, and points at the line", () => {
    writeFileSync(
      join(project, "failing.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

test("budget", async () => {
  const t = testActuator(actuator);
  const run = await t.start({ name: "Aina" });
  assert.ok(t.usage(run.runId).rowsWritten < 2, "too many rows");
});
`,
    );
    const res = actuate(["test", "failing.test.ts"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("too many rows");
    expect(res.out).toMatch(/failing\.test\.ts:9:\d+/);
  });

  it("actuate test uses the project's Vitest for files that import it", () => {
    writeFileSync(
      join(project, "vitest.test.ts"),
      `import { expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

it("greets under vitest", async () => {
  const t = testActuator(actuator, { plan: "maker" });
  const run = await t.start({ name: "Aina" });
  await t.advance("10 seconds");
  expect(t.run(run.runId).status).toBe("COMPLETED");
});
`,
    );
    const res = actuate(["test", "vitest.test.ts", "--grep", "greets"]);
    expect(res.code, res.out + res.err).toBe(0);
    expect(res.out).toMatch(/1 passed/);
  });

  it("check --platform reports the deploy checks as JSON", () => {
    const res = actuate(["check", "--platform", "--json", "--plan", "sandbox"]);
    expect(res.code, res.err).toBe(0);
    expect(JSON.parse(res.out)).toMatchObject({ errors: 0, platform: { plan: "sandbox", issues: [] } });
  });

  it("deploy --dry-run needs no login and uploads nothing", () => {
    const res = actuate(["deploy", "--dry-run"]);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain("Bundled hello:");
    expect(res.out).toContain('"name": "hello"');
  });

  it("doctor checks the project", () => {
    const res = actuate(["doctor", "--offline"]);
    expect(res.out).toContain('✓ actuator.ts loads: actuator "hello"');
    expect(res.out).toContain("test file(s)");
  });
});
