import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findTestFiles, findVitest, nodeFlags, runnerFor } from "../src/test-runner.js";

describe("actuate test", () => {
  it("finds test files outside node_modules, build output and dot-folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "tests-"));
    for (const f of ["actuator.test.ts", "test/a.spec.ts", "test/helpers.ts", "node_modules/x/y.test.ts", ".actuate/z.test.ts", "dist/d.test.js", "src/b.test.mts"]) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "");
    }
    expect(findTestFiles(dir)).toEqual(["actuator.test.ts", "src/b.test.mts", "test/a.spec.ts"]);
    expect(findTestFiles(dir, ["test"])).toEqual(["test/a.spec.ts"]);
    expect(findTestFiles(dir, ["test/helpers.ts"])).toEqual(["test/helpers.ts"]);
    expect(() => findTestFiles(dir, ["missing"])).toThrow("missing not found.");
  });

  it("picks Vitest for files that import it, node:test otherwise", () => {
    expect(runnerFor(`import { describe, it } from "vitest";`)).toBe("vitest");
    expect(runnerFor(`import { test } from 'node:test';`)).toBe("node");
    expect(runnerFor(`// mentions vitest in a comment`)).toBe("node");
  });

  it("finds the project's own Vitest, walking up from the project", () => {
    expect(findVitest(process.cwd())).toMatch(/vitest\.mjs$/);
    expect(findVitest(tmpdir())).toBeNull();
  });

  it("adds --experimental-sqlite only where node:sqlite needs it", () => {
    expect(nodeFlags("22.12.0")).toEqual(["--experimental-sqlite"]);
    expect(nodeFlags("22.13.0")).toEqual([]);
    expect(nodeFlags("24.1.0")).toEqual([]);
  });
});
