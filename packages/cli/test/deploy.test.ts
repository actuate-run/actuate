import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configChanged, deploy, prepareDeploy } from "../src/deploy.js";
import { fakeServer, runCli } from "./helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/project", import.meta.url));
const quiet = () => {};
const secretFixture = fileURLToPath(new URL("./fixtures/secret-project", import.meta.url));

/** A copy of the secret-project fixture with this actuate.config.json, next to it (so @actuate/sdk resolves). Remove it after. */
export function secretProject(config: unknown): string {
  const dir = mkdtempSync(join(fileURLToPath(new URL("./fixtures", import.meta.url)), ".tmp-"));
  copyFileSync(join(secretFixture, "actuator.ts"), join(dir, "actuator.ts"));
  writeFileSync(join(dir, "actuate.config.json"), JSON.stringify(config));
  return dir;
}

const me = (deploys = 3, plan = "maker") => ({ email: "a@b.test", plan, usage: { deploys } });
const deployed = { id: "act_1", name: "fixture_greeter", version: 4, urls: { api: "a", webhook: "w", mcp: "m", openapi: "o", dashboard: "d" } };

describe("actuate deploy", () => {
  beforeEach(() => {
    vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "cli-")));
    vi.stubEnv("ACTUATE_API_TOKEN", "");
    vi.stubEnv("ACTUATE_PLAN", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  const login = (url: string) => {
    vi.stubEnv("ACTUATE_API_TOKEN", "ak_test");
    vi.stubEnv("ACTUATE_API_URL", url);
  };

  it("says you are not logged in before it bundles anything", async () => {
    // The file does not exist: a bundle attempt would fail with a different error.
    await expect(deploy("missing.ts", tmpdir(), { config: true, dryRun: false })).rejects.toThrow(/Not logged in/);
  });

  it("--dry-run runs the deploy checks without logging in, and exits 1 when they fail", async () => {
    const out: string[] = [];
    expect(await deploy("actuator.ts", fixture, { config: true, dryRun: true, json: true, plan: "maker", log: (l) => out.push(l) })).toBe(0);
    const result = JSON.parse(out.join("\n"));
    expect(result).toMatchObject({ dryRun: true, name: "fixture_greeter", plan: { id: "maker", source: "--plan" }, issues: [], metadata: { capabilities: ["messaging"] } });
    expect(result.bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await deploy("actuator.ts", fixture, { config: true, dryRun: true, plan: "sandbox", log: quiet })).toBe(1);
  });

  it("stops before uploading when the account can't take the deploy", async () => {
    const srv = await fakeServer({
      "GET /v1/me": me(),
      "GET /v1/providers": [],
      "GET /v1/actuators/fixture_greeter": [404, { error: "Actuator not found" }],
      "GET /v1/actuators": [],
    });
    login(srv.url);
    try {
      const res = await runCli(["deploy"], fixture);
      expect(res.code).toBe(1);
      expect(res.out).toContain("Deploy checks for the Maker plan (from your account).");
      expect(res.out).toContain("No provider configured for: messaging. Add one in the dashboard (Settings → Providers) first.  (provider-missing)");
      expect(res.err).toContain("a refused deploy still counts against your deploy budget");
      expect(srv.requests.some((r) => r.path === "/v1/actuators/deploy")).toBe(false);
      const json = await runCli(["deploy", "--json"], fixture);
      expect(json.code).toBe(1);
      expect(JSON.parse(json.out)).toMatchObject({ ok: false, error: expect.stringContaining("would refuse"), issues: [{ rule: "provider-missing" }], plan: { id: "maker" } });
    } finally {
      await srv.close();
    }
  });

  it("deploys, and says how many deploys this month have been used", async () => {
    const srv = await fakeServer({
      "GET /v1/me": me(3),
      "GET /v1/providers": [{ capability: "messaging", kind: "telegram" }],
      "GET /v1/actuators/fixture_greeter": { version: 4, versions: [{ version: 4, code_hash: "old" }] },
      "POST /v1/actuators/deploy": [201, { ...deployed, version: 5 }],
    });
    login(srv.url);
    try {
      const res = await runCli(["deploy"], fixture);
      expect(res.code).toBe(0);
      expect(res.out).toContain("✓ Deployed fixture_greeter v5");
      expect(res.out).toContain("Deploys this month: 4 of 2,000");
      const sent = srv.requests.find((r) => r.path === "/v1/actuators/deploy")?.body as { config: unknown; metadata: { name: string } };
      expect(sent).toMatchObject({ config: { greeting: "Hi" }, metadata: { name: "fixture_greeter" } });
    } finally {
      await srv.close();
    }
  });

  it("updates only the configuration when the deployed version already runs this code", async () => {
    const { codeHash } = await prepareDeploy("actuator.ts", fixture, true, quiet);
    const routes = (config: unknown) => ({
      "GET /v1/me": me(),
      "GET /v1/providers": [{ capability: "messaging", kind: "telegram" }],
      "GET /v1/actuators/fixture_greeter": { version: 4, versions: [{ version: 4, code_hash: codeHash }] },
      "GET /v1/actuators/fixture_greeter/config": { config },
      "PUT /v1/actuators/fixture_greeter/config": { ok: true },
    });
    const changed = await fakeServer(routes({ greeting: "Hello" }));
    login(changed.url);
    try {
      const res = await runCli(["deploy"], fixture);
      expect(res).toMatchObject({ code: 0, out: expect.stringContaining("already runs this code: updated its configuration only (no deploy used)") });
      expect(changed.requests.find((r) => r.method === "PUT")?.body).toEqual({ config: { greeting: "Hi" } });
      expect(changed.requests.some((r) => r.path === "/v1/actuators/deploy")).toBe(false);
    } finally {
      await changed.close();
    }
    const same = await fakeServer(routes({ greeting: "Hi" }));
    login(same.url);
    try {
      expect((await runCli(["deploy"], fixture)).out).toContain("Nothing to deploy: fixture_greeter v4 already runs this code and configuration");
      expect(same.requests.some((r) => r.method === "PUT" || r.path === "/v1/actuators/deploy")).toBe(false);
    } finally {
      await same.close();
    }
  });

  it("compares the configuration without its secret fields, and sends a secret the file holds", async () => {
    const project = secretProject({ greeting: "Hi" });
    try {
      const { codeHash } = await prepareDeploy("actuator.ts", project, true, quiet);
      const routes = (config: unknown) => ({
        "GET /v1/me": me(),
        "GET /v1/providers": [],
        "GET /v1/actuators/fixture_secret": { version: 2, versions: [{ version: 2, code_hash: codeHash }] },
        "GET /v1/actuators/fixture_secret/config": { config },
        "PUT /v1/actuators/fixture_secret/config": { ok: true },
      });
      // The platform shows stored secrets as null: that is not a change.
      const masked = await fakeServer(routes({ greeting: "Hi", apiKey: null, webhook: { token: null } }));
      login(masked.url);
      try {
        expect((await runCli(["deploy"], project)).out).toContain("Nothing to deploy: fixture_secret v2 already runs this code and configuration");
        expect(masked.requests.some((r) => r.method === "PUT")).toBe(false);
      } finally {
        await masked.close();
      }
      // A change elsewhere is sent, with the secrets left out as the file leaves them out (the platform keeps them).
      const changed = await fakeServer(routes({ greeting: "Hello", apiKey: null }));
      login(changed.url);
      try {
        expect((await runCli(["deploy"], project)).out).toContain("updated its configuration only");
        expect(changed.requests.find((r) => r.method === "PUT")?.body).toEqual({ config: { greeting: "Hi" } });
      } finally {
        await changed.close();
      }
      // A secret in the file can't be compared with a masked one: it is always sent.
      writeFileSync(join(project, "actuate.config.json"), JSON.stringify({ greeting: "Hi", webhook: { token: "whk_file_token" } }));
      const withSecret = await fakeServer(routes({ greeting: "Hi", apiKey: null, webhook: { token: null } }));
      login(withSecret.url);
      try {
        expect((await runCli(["deploy"], project)).code).toBe(0);
        expect(withSecret.requests.find((r) => r.method === "PUT")?.body).toEqual({ config: { greeting: "Hi", webhook: { token: "whk_file_token" } } });
      } finally {
        await withSecret.close();
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("configChanged ignores secret fields on both sides", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, k: { type: "string", writeOnly: true } } };
    expect(configChanged(schema, { a: "x", k: null }, { a: "x" })).toBe(false);
    expect(configChanged(schema, { a: "x", k: null }, { a: "y" })).toBe(true);
    expect(configChanged(schema, { a: "x", k: null }, { a: "x", k: "" })).toBe(false);
    expect(configChanged(schema, { a: "x", k: null }, { a: "x", k: "new-key" })).toBe(true);
  });

  it("--force deploys anyway, and account lookups that fail only skip their checks", async () => {
    const srv = await fakeServer({
      "GET /v1/me": [500, { error: "Internal error" }],
      "GET /v1/providers": [500, { error: "Internal error" }],
      "GET /v1/actuators/fixture_greeter": [500, { error: "Internal error" }],
      "POST /v1/actuators/deploy": [201, { ...deployed, warnings: ["careful"] }],
    });
    login(srv.url);
    try {
      const res = await runCli(["deploy", "--force", "--json"], fixture);
      expect(res.code).toBe(0);
      // Without the account, the plan falls back to Sandbox, whose capability check fails: --force goes ahead.
      expect(JSON.parse(res.out)).toMatchObject({ deployedNow: true, version: 4, warnings: ["careful"], plan: { id: "sandbox" } });
    } finally {
      await srv.close();
    }
  });
});
