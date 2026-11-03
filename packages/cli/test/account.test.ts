import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describePlan, planHint, resolvePlan } from "../src/account.js";
import { writeCredentials } from "../src/api.js";
import { fakeServer } from "./helpers.js";

describe("resolvePlan (what actuate dev and test use)", () => {
  beforeEach(() => {
    vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "cli-")));
    vi.stubEnv("ACTUATE_API_TOKEN", "");
    vi.stubEnv("ACTUATE_PLAN", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to Sandbox when not logged in, and says so", async () => {
    const p = await resolvePlan(undefined);
    expect(describePlan(p)).toBe("Sandbox plan (the default: not logged in)");
    expect(planHint(p)).toContain("--plan maker or agency");
  });

  it("asks the account when ACTUATE_API_TOKEN alone is set", async () => {
    const srv = await fakeServer({ "GET /v1/me": { plan: "agency", email: "a@b.test" } });
    vi.stubEnv("ACTUATE_API_TOKEN", "ak_ci");
    vi.stubEnv("ACTUATE_API_URL", srv.url);
    try {
      const p = await resolvePlan(undefined);
      expect([p.plan.id, describePlan(p), planHint(p)]).toEqual(["agency", "Agency plan (from your account)", ""]);
      // --plan decides without asking.
      const before = srv.requests.length;
      expect((await resolvePlan("maker")).source).toBe("--plan");
      expect(srv.requests.length).toBe(before);
    } finally {
      await srv.close();
    }
  });

  it("falls back to the plan saved at login, and says why, when the API can't be reached", async () => {
    writeCredentials({ apiUrl: "http://127.0.0.1:9", token: "ak_x", plan: "maker" });
    const p = await resolvePlan(undefined, { timeoutMs: 2_000 });
    expect(describePlan(p)).toBe("Maker plan (saved at your last login, as the API couldn't be reached)");
    expect(p.meError).toMatch(/Could not reach/);
  });

  it("reads ACTUATE_PLAN, and rejects unknown plans", async () => {
    vi.stubEnv("ACTUATE_PLAN", "maker");
    expect(describePlan(await resolvePlan(undefined))).toBe("Maker plan (from ACTUATE_PLAN)");
    await expect(resolvePlan("gold")).rejects.toThrow('Unknown plan "gold" in --plan');
  });
});
