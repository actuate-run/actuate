import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deploy } from "../src/deploy.js";

describe("actuate deploy", () => {
  beforeEach(() => {
    vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "cli-")));
    vi.stubEnv("ACTUATE_API_TOKEN", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("says you are not logged in before it bundles anything", async () => {
    // The file does not exist: a bundle attempt would fail with a different error.
    await expect(deploy("missing.ts", tmpdir(), { config: true, dryRun: false })).rejects.toThrow(/Not logged in/);
  });
});
