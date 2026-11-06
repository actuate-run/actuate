import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineActuator, z, type Actuator, type NotifyOwnerResult } from "@actuate/sdk";
import { RunManager, executePass, nodeSqlite, type ApprovalRequest } from "../src/index.js";

function harness(actuator: Actuator, notify: (r: ApprovalRequest) => Promise<void | NotifyOwnerResult>) {
  const manager = new RunManager({
    sql: nodeSqlite(new DatabaseSync(":memory:")),
    approvalSecret: "test-secret",
    approvalUrl: "https://example.test/approve",
    now: () => Date.parse("2026-11-02T00:00:00Z"),
    consoleLogs: false,
    notifyApproval: notify,
    invoke: (request, journal) => executePass(actuator, request, { journal, config: {} }),
  });
  return { manager };
}

describe("approval notices that can't go out", () => {
  const ask = defineActuator({
    name: "ask",
    description: "test",
    input: z.object({ kind: z.enum(["approval", "input"]) }),
    async run(ctx, input) {
      if (input.kind === "input") return (await ctx.step.waitForInput("why", { prompt: "Why?", notify: "owner" }))?.text ?? null;
      return (await ctx.step.waitForApproval("ok", { message: "Refund?", notify: "owner" }))?.approved ?? null;
    },
  });

  it("logs the reason as a warning, without the links, and the step still waits", async () => {
    const seen: ApprovalRequest[] = [];
    const h = harness(ask, async (r) => (seen.push(r), { sent: false, reason: "daily email cap reached" }));
    const approval = await h.manager.start({ input: { kind: "approval" }, trigger: { kind: "api" } });
    const input = await h.manager.start({ input: { kind: "input" }, trigger: { kind: "api" } });
    expect(seen.map((r) => [r.kind, r.notify])).toEqual([["approval", "owner"], ["input", "owner"]]);
    expect(approval.run.status).toBe("WAITING");
    expect(h.manager.getLogs(approval.run.runId).map((l) => [l.level, l.message])).toEqual([
      ["info", 'Approval requested for "ok"'],
      ["warn", 'Approval links for "ok" not sent: daily email cap reached'],
    ]);
    expect(h.manager.getLogs(input.run.runId).at(-1)).toMatchObject({ level: "warn", message: 'Input link for "why" not sent: daily email cap reached' });
    expect(JSON.stringify(h.manager.getLogs(approval.run.runId))).not.toContain("token=");
    expect(h.manager.pendingApprovals()).toHaveLength(2);
  });

  it("never lets a notifier's reason or error carry the links into the log", async () => {
    let n = 0;
    const leaky = [
      async (r: ApprovalRequest) => ({ sent: false, reason: `provider said: bad body ${r.approveUrl ?? r.answerUrl} / ${r.rejectUrl ?? ""}` }),
      async (r: ApprovalRequest) => ({ sent: false, reason: `token ${new URL(r.answerUrl ?? r.approveUrl!).searchParams.get("token")} refused` }),
      async (r: ApprovalRequest) => {
        throw new Error(`POST failed for body: ${JSON.stringify({ url: r.approveUrl ?? r.answerUrl })} (see https://other.test/x?a=1&token=abc)`);
      },
    ];
    for (const notify of leaky) {
      for (const kind of ["approval", "input"] as const) {
        const h = harness(ask, notify);
        const { run } = await h.manager.start({ input: { kind }, trigger: { kind: "api" } });
        const logs = h.manager.getLogs(run.runId);
        const text = JSON.stringify(logs);
        expect(text).not.toMatch(/token=|approve\?/);
        expect(text).toContain("[link]");
        expect(logs.at(-1)!.level).toBe(n++ < 4 ? "warn" : "error");
      }
    }
  });

  it("logs nothing more when the notice went out", async () => {
    for (const reply of [undefined, { sent: true }]) {
      const h = harness(ask, async () => reply);
      const { run } = await h.manager.start({ input: { kind: "approval" }, trigger: { kind: "api" } });
      expect(h.manager.getLogs(run.runId).map((l) => l.level)).toEqual(["info"]);
    }
  });
});

describe("MessagingSendOptions.approval", () => {
  it("is removed from sends made by actuator code, leaving the caller's options alone", async () => {
    const seen: unknown[] = [];
    const approval = { kind: "approval" as const, actuator: "x", step: "s", approveUrl: "https://evil.example/a", rejectUrl: "https://evil.example/r", expiresAt: 0 };
    const options = { subject: "Hi", approval };
    const act = defineActuator({
      name: "faker",
      description: "test",
      input: z.object({}),
      capabilities: ["messaging"],
      async run(ctx) {
        await ctx.step.do("send", () => ctx.messaging.send("boss", "Approve?", options));
        await ctx.step.do("keyed", () => ctx.messaging.send("boss", "Again", { ...options, idempotencyKey: "mine" }));
        // A Proxy that hides `approval` from `in` but still hands it out when read.
        const sneaky = new Proxy({ subject: "Hi", idempotencyKey: "p", approval } as Record<string, unknown>, { has: (t, k) => k !== "approval" && k in t });
        await ctx.step.do("proxy", () => ctx.messaging.send("boss", "Sneaky", sneaky as never));
        return options.approval === approval;
      },
    });
    const manager = new RunManager({
      sql: nodeSqlite(new DatabaseSync(":memory:")),
      approvalSecret: "s",
      approvalUrl: "https://example.test/approve",
      consoleLogs: false,
      invoke: (request, journal) =>
        executePass(act, request, { journal, config: {}, providers: { messaging: { send: async (_to, _text, o) => (seen.push(o), { id: "1", channel: "test" }) } } }),
    });
    const { run } = await manager.start({ input: {}, trigger: { kind: "api" } });
    expect(run).toMatchObject({ status: "COMPLETED", output: true });
    expect(seen).toEqual([
      { subject: "Hi", idempotencyKey: expect.stringMatching(/:send:send:0$/) },
      { subject: "Hi", idempotencyKey: "mine" },
      { subject: "Hi", idempotencyKey: "p" },
    ]);
    for (const o of seen) expect(Object.keys(o as object)).not.toContain("approval");
  });
});
