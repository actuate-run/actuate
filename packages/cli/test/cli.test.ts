import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeServer, runCli } from "./helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/project", import.meta.url));

beforeEach(() => {
  vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "cli-")));
  vi.stubEnv("ACTUATE_API_TOKEN", "");
  vi.stubEnv("ACTUATE_PLAN", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("actuate (usage)", () => {
  it("prints help, per-command help with examples, and the version", async () => {
    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    for (const c of ["init", "doctor", "dev", "test", "check", "run", "logs", "event", "approve", "reject", "answer", "cancel", "deploy", "login", "providers"]) {
      expect(help.out).toMatch(new RegExp(`^  ${c} `, "m"));
    }
    const deploy = await runCli(["deploy", "--help"]);
    expect(deploy.out).toContain("Usage: actuate deploy [file]");
    expect(deploy.out).toContain("--dry-run");
    expect(deploy.out).toContain("Examples\n  actuate deploy --dry-run");
    expect((await runCli(["help", "test"])).out).toContain("@actuate/cli/testing");
    expect((await runCli(["--version"])).out).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exits 2 with a suggestion for an unknown command or option", async () => {
    expect(await runCli(["deplyo"])).toMatchObject({ code: 2, err: expect.stringContaining("Did you mean `actuate deploy`?") });
    expect(await runCli(["logs", "--bogus"])).toMatchObject({ code: 2, err: expect.stringContaining("Unknown option '--bogus'") });
    expect(await runCli(["run", "not json", "--local"])).toMatchObject({ code: 2, err: expect.stringContaining("must be JSON, in single quotes") });
    expect(await runCli(["dev", "--port", "x"])).toMatchObject({ code: 2, err: expect.stringContaining("--port must be a port number") });
    expect(await runCli(["check", "--platform", "--plan", "pro"], fixture)).toMatchObject({ code: 2, err: expect.stringContaining('Unknown plan "pro"') });
  });
});

describe("actuate check", () => {
  it("lints, and with --platform runs the deploy checks for a plan", async () => {
    const lint = await runCli(["check"], fixture);
    expect(lint).toMatchObject({ code: 0, out: expect.stringContaining("✓ No replay-safety problems found") });
    const sandbox = await runCli(["check", "--platform", "--plan", "sandbox", "--json"], fixture);
    expect(sandbox.code).toBe(1);
    expect(JSON.parse(sandbox.out)).toMatchObject({
      errors: 1,
      platform: { plan: "sandbox", planSource: "--plan", issues: [{ rule: "plan-capability", severity: "error" }] },
    });
    const maker = await runCli(["check", "--platform", "--plan", "maker"], fixture);
    expect(maker.code).toBe(0);
    expect(maker.out).toContain("✓ passes the platform's deploy checks");
    expect(maker.out).toContain("not logged in, so the provider, actuator-count and deploy-budget checks were skipped");
  });

  it("exits 1 on replay-safety errors and reports them as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chk-"));
    writeFileSync(join(dir, "actuator.ts"), `import { defineActuator, z } from "@actuate/sdk";
export default defineActuator({ name: "x", description: "x", input: z.object({}), async run(ctx) { return Date.now(); } });`);
    const res = await runCli(["check", "--json"], dir);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.out)).toMatchObject({ errors: 1, diagnostics: [{ rule: "no-nondeterminism-outside-step", line: 2 }] });
    expect(await runCli(["check", "nope.ts"], dir)).toMatchObject({ code: 1, err: expect.stringContaining("nope.ts not found") });
  });
});

describe("run commands against actuate dev (--local)", () => {
  const detail = {
    runId: "run_x",
    status: "WAITING",
    passes: 1,
    trigger: { kind: "api" },
    usage: { statements: 8, rowsRead: 12, rowsWritten: 9 },
    steps: [{ name: "greet", status: "COMPLETED" }, { name: "ok", status: "WAITING_APPROVAL", wakeAt: Date.UTC(2026, 0, 6) }],
    logs: [],
  };

  it("starts a run and shows where it got to, with the next command", async () => {
    const srv = await fakeServer({ "POST /run": [201, { runId: "run_x", status: "WAITING", passes: 1 }], "GET /runs/run_x": detail });
    try {
      const res = await runCli(["run", '{"name":"Aina"}', "--local", "--port", String(srv.port), "--idempotency-key", "k1"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("1 pass · 9 rows written · 12 rows read");
      expect(res.out).toContain(`actuate approve run_x --step ok --local --port ${srv.port}`);
      expect(srv.requests[0]).toMatchObject({ method: "POST", path: "/run", body: { name: "Aina" }, headers: { "idempotency-key": "k1" } });
      const json = await runCli(["run", "--local", "--port", String(srv.port), "--json"]);
      expect(JSON.parse(json.out)).toMatchObject({ runId: "run_x", usage: { rowsWritten: 9 } });
    } finally {
      await srv.close();
    }
  });

  it("exits 1 when the run failed, and explains when actuate dev isn't running", async () => {
    const srv = await fakeServer({ "POST /run": [201, { runId: "run_f", status: "FAILED", passes: 1, error: { name: "Error", message: "boom" } }] });
    try {
      const res = await runCli(["run", "--local", "--port", String(srv.port)]);
      expect(res).toMatchObject({ code: 1, out: expect.stringContaining("error  boom") });
    } finally {
      await srv.close();
    }
    const down = await runCli(["logs", "--local", "--port", String(srv.port)]);
    expect(down).toMatchObject({ code: 1, err: expect.stringContaining("Start `actuate dev` in another terminal first") });
  });

  it("lists runs with filters, and shows one", async () => {
    const srv = await fakeServer({ "GET /runs?limit=5&status=WAITING": [detail], "GET /runs/run_x": detail });
    try {
      const list = await runCli(["logs", "--local", "-p", String(srv.port), "--limit", "5", "--status", "waiting"]);
      expect(list.out).toMatch(/^RUN\s+STATUS\s+PASSES\s+ROWS W\/R/);
      expect(list.out).toContain("9/12");
      const one = await runCli(["logs", "run_x", "--local", "-p", String(srv.port)]);
      expect(one.out).toContain("step  WAITING_APPROVAL ok");
      expect((await runCli(["logs", "--local", "--status", "done"])).code).toBe(2);
    } finally {
      await srv.close();
    }
  });

  it("approves, rejects and answers the waiting step, posts events and cancels", async () => {
    const answered = { ...detail, steps: [{ name: "q", status: "WAITING_INPUT" }] };
    const srv = await fakeServer({
      "GET /runs/run_x": detail,
      "GET /runs/run_q": answered,
      "POST /runs/run_x/approvals/ok/approve": { ok: true, runId: "run_x", step: "ok", approved: true },
      "POST /runs/run_x/approvals/ok/reject": { ok: false, reason: "This approval has already been decided or has expired." },
      "POST /runs/run_q/inputs/q": { ok: true },
      "POST /events/payment.run_x": { resumed: ["run_x"], buffered: false },
      "POST /events/nobody": { resumed: [], buffered: true },
      "POST /runs/run_x/cancel": { cancelled: true },
    });
    const p = ["--local", "--port", String(srv.port)];
    try {
      expect(await runCli(["approve", "run_x", "--note", "fine", ...p])).toMatchObject({ code: 0, out: expect.stringContaining('✓ Approved "ok"') });
      expect(srv.requests.find((r) => r.path.endsWith("/approve"))?.body).toEqual({ note: "fine" });
      expect(await runCli(["reject", "run_x", ...p])).toMatchObject({ code: 1, err: expect.stringContaining("already been decided") });
      expect(await runCli(["answer", "run_q", "Monday", ...p])).toMatchObject({ code: 0, out: expect.stringContaining('✓ Answered "q"') });
      expect(srv.requests.find((r) => r.path.endsWith("/inputs/q"))?.body).toEqual({ text: "Monday" });
      expect(await runCli(["answer", "run_x", "x", ...p])).toMatchObject({ code: 1, err: expect.stringContaining("waits for no question") });
      expect((await runCli(["event", "payment.run_x", '{"status":"paid"}', ...p])).out).toContain("✓ payment.run_x: resumed run_x");
      expect(srv.requests.find((r) => r.path === "/events/payment.run_x")?.body).toEqual({ status: "paid" });
      expect((await runCli(["event", "nobody", ...p])).out).toContain("buffered");
      expect(await runCli(["cancel", "run_x", ...p])).toMatchObject({ code: 0, out: "✓ Cancelled run_x" });
      expect((await runCli(["approve", ...p])).code).toBe(2);
    } finally {
      await srv.close();
    }
  });
});

describe("hosted run commands", () => {
  it("need a login, and read the actuator name from actuator.ts", async () => {
    expect(await runCli(["logs"], fixture)).toMatchObject({ code: 1, err: expect.stringContaining("Not logged in") });
    const srv = await fakeServer({ "GET /v1/actuators/fixture_greeter/runs?limit=20": [], "GET /v1/actuators/other/runs?limit=20": [404, { error: "Actuator not found" }] });
    vi.stubEnv("ACTUATE_API_TOKEN", "ak_test");
    vi.stubEnv("ACTUATE_API_URL", srv.url);
    try {
      expect(await runCli(["logs"], fixture)).toMatchObject({ code: 0, out: "No runs yet." });
      expect(srv.requests[0]?.headers.authorization).toBe("Bearer ak_test");
      expect(await runCli(["logs", "--name", "other"], fixture)).toMatchObject({ code: 1, err: expect.stringContaining("Deploy it first") });
    } finally {
      await srv.close();
    }
  });
});

describe("actuate login", () => {
  it("checks the token, refuses agent tokens, and saves the plan", async () => {
    const srv = await fakeServer({ "GET /v1/me": { email: "a@b.test", plan: "maker" }, "GET /v1/tokens": [] });
    try {
      const res = await runCli(["login", "--token", "ak_full", "--api", srv.url]);
      expect(res).toMatchObject({ code: 0, out: expect.stringContaining("✓ Logged in as a@b.test (maker plan)") });
      const saved = JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME!, "actuate", "credentials.json"), "utf8"));
      expect(saved).toEqual({ apiUrl: srv.url, token: "ak_full", plan: "maker", email: "a@b.test" });
    } finally {
      await srv.close();
    }
    const agent = await fakeServer({ "GET /v1/me": { email: "a@b.test", plan: "maker" }, "GET /v1/tokens": [403, { error: "This token can only start and read runs" }] });
    try {
      expect(await runCli(["login", "--token", "ak_run", "--api", agent.url])).toMatchObject({ code: 1, err: expect.stringContaining("agent (run-scoped) token") });
    } finally {
      await agent.close();
    }
    const rejected = await fakeServer({ "GET /v1/me": [401, { error: "Unauthorized" }] });
    try {
      expect(await runCli(["login", "--token", "nope", "--api", rejected.url])).toMatchObject({ code: 1, err: expect.stringContaining("That token was rejected") });
    } finally {
      await rejected.close();
    }
  });
});

describe("actuate doctor", () => {
  it("reports each check, offline, as JSON", async () => {
    const res = await runCli(["doctor", "--offline", "--plan", "maker", "--json"], fixture);
    const results = JSON.parse(res.out) as Array<{ check: string; status: string; message: string }>;
    const by = Object.fromEntries(results.map((r) => [r.check, r]));
    expect(by.node?.status).toBe("ok");
    expect(by.load).toMatchObject({ status: "ok", message: 'actuator.ts loads: actuator "fixture_greeter"' });
    expect(by["deploy-checks"]?.status).toBe("ok");
    expect(by["provider:messaging"]).toMatchObject({ status: "info" });
    expect(by.login).toMatchObject({ status: "info" });
    expect(by.tests).toMatchObject({ status: "warn" });
    // The fixture has no package.json, so the SDK isn't "installed" there: a failure, exit 1.
    expect(res.code).toBe(results.some((r) => r.status === "fail") ? 1 : 0);
  });
});

describe("actuate providers", () => {
  it("lists providers and their variables as JSON", async () => {
    const res = await runCli(["providers", "--json"]);
    const list = JSON.parse(res.out) as Array<{ kind: string; env: Array<{ name: string }> }>;
    expect(list.find((p) => p.kind === "telegram")?.env.map((e) => e.name)).toContain("TELEGRAM_BOT_TOKEN");
  });
});
