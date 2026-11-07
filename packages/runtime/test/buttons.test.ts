import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineActuator, z, type Actuator } from "@actuate/sdk";
import {
  LOCAL_BUTTON_ROUTE,
  RunManager,
  chatApproverLabel,
  executePass,
  newButtonNonce,
  nodeSqlite,
  type ApprovalRequest,
  type Invoke,
  type RunManagerOptions,
} from "../src/index.js";

const T0 = Date.parse("2026-11-07T14:00:00Z");
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

/** Waits for one approval and returns what the resumed pass saw. */
const gate = defineActuator({
  name: "gate",
  description: "test",
  input: z.object({ notify: z.any().optional(), kind: z.enum(["approval", "input"]).default("approval") }),
  async run(ctx, input) {
    if (input.kind === "input") return (await ctx.step.waitForInput("why", { prompt: "Why?", notify: input.notify }))?.text ?? null;
    const decision = await ctx.step.waitForApproval("ok", { message: "Refund RM 20?", notify: input.notify ?? "boss", timeout: "1 hour" });
    return decision;
  },
});

function harness(actuator: Actuator = gate, opts: Partial<RunManagerOptions> & { db?: DatabaseSync } = {}) {
  let now = T0;
  const approvals: ApprovalRequest[] = [];
  const wakes: Array<number | null> = [];
  let passes = 0;
  const db = opts.db ?? new DatabaseSync(":memory:");
  const invoke: Invoke = (request, journal) => (passes++, executePass(actuator, request, { journal, config: {} }));
  const manager = new RunManager({
    sql: nodeSqlite(db),
    approvalSecret: "test-secret",
    approvalUrl: "https://example.test/approve",
    now: () => now,
    consoleLogs: false,
    buttonRoute: LOCAL_BUTTON_ROUTE,
    notifyApproval: async (r) => void approvals.push(r),
    scheduleWake: (w) => void wakes.push(w),
    invoke,
    ...opts,
  });
  return {
    db,
    manager,
    approvals,
    wakes,
    passes: () => passes,
    setNow: (t: number) => (now = t),
    advance: async (ms: number) => {
      now += ms;
      await manager.alarm();
    },
    start: (input: unknown = {}) => manager.start({ input: input as never, trigger: { kind: "api" } }),
  };
}

describe("button nonces", () => {
  it("come with approvals that notify someone, never with questions", async () => {
    const h = harness();
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    const req = h.approvals[0]!;
    expect(req.buttons).toEqual({ route: "local", nonce: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) });
    expect(h.db.prepare(`SELECT run_id, step, expires_at, used_at FROM _actuate_approval_buttons`).all()).toEqual([
      { run_id: run.runId, step: "ok", expires_at: T0 + 3_600_000, used_at: null },
    ]);
    await h.start({ kind: "input", notify: "boss" });
    expect(h.approvals[1]).toMatchObject({ kind: "input" });
    expect(h.approvals[1]).not.toHaveProperty("buttons");
  });

  it("are not made without a buttonRoute, and the route is checked", async () => {
    const h = harness(gate, { buttonRoute: undefined });
    await h.start();
    expect(h.approvals[0]).not.toHaveProperty("buttons");
    expect(() => harness(gate, { buttonRoute: "has space" })).toThrow(/buttonRoute/);
    expect(() => harness(gate, { buttonRoute: "x".repeat(25) })).toThrow(/buttonRoute/);
    expect(() => harness(gate, { buttonRoute: "act_0123456789abcdef" })).not.toThrow();
  });

  it("are random", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newButtonNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(n).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("label the approver as <channel>:<id> (<name>)", () => {
    expect(chatApproverLabel("telegram", { id: "123456789", name: "Alice" })).toBe("telegram:123456789 (Alice)");
    expect(chatApproverLabel("slack", { id: "U0123ABCD" })).toBe("slack:U0123ABCD");
    expect(chatApproverLabel("discord", { id: " 1 2 ", name: " Bo\nBoss  " })).toBe("discord:12 (Bo Boss)");
    expect(chatApproverLabel("discord", { id: "1", name: "x".repeat(200) }).length).toBeLessThanOrEqual(120);
  });
});

describe("decideByButton", () => {
  const by = "telegram:123456789 (Alice)";

  it("decides without running the pass, and the alarm resumes the run with via chat", async () => {
    const h = harness();
    const { run } = await h.start();
    const nonce = h.approvals[0]!.buttons!.nonce;
    const before = h.passes();
    h.setNow(T0 + 60_000);
    const outcome = h.manager.decideByButton(nonce, "approve", { by });
    // Synchronous: a plain object, not a promise, and no pass ran.
    expect(outcome).toEqual({ status: "decided", decision: "approved", by, at: "2026-11-07T14:01:00.000Z" });
    expect(h.passes()).toBe(before);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "WAITING", wakeAt: T0 + 60_000 });
    expect(h.wakes.at(-1)).toBe(T0 + 60_000);
    expect(h.db.prepare(`SELECT used_at, used_by, decision FROM _actuate_approval_buttons`).get()).toEqual({ used_at: T0 + 60_000, used_by: by, decision: "approved" });

    await h.advance(0);
    expect(h.manager.getRun(run.runId)).toMatchObject({
      status: "COMPLETED",
      output: { approved: true, at: "2026-11-07T14:01:00.000Z", by, via: "chat" },
    });
  });

  it("rejects, and a second click (either button) is 'already' with the first decision", async () => {
    const h = harness();
    await h.start();
    const nonce = h.approvals[0]!.buttons!.nonce;
    expect(h.manager.decideByButton(nonce, "reject", { by })).toMatchObject({ status: "decided", decision: "rejected" });
    for (const action of ["approve", "reject"] as const) {
      expect(h.manager.decideByButton(nonce, action, { by: "telegram:2 (Bob)" })).toEqual({ status: "already", decision: "rejected", by, at: new Date(T0).toISOString() });
    }
    await h.advance(0);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "COMPLETED", output: { approved: false, via: "chat", by } });
    // Still "already" once the run has completed.
    expect(h.manager.decideByButton(nonce, "approve", { by })).toMatchObject({ status: "already", decision: "rejected" });
  });

  it("gives 'already' to two clicks racing the first", async () => {
    const h = harness();
    await h.start();
    const nonce = h.approvals[0]!.buttons!.nonce;
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => h.manager.decideByButton(nonce, "approve", { by: "slack:U1 (A)" })),
      Promise.resolve().then(() => h.manager.decideByButton(nonce, "reject", { by: "slack:U2 (B)" })),
    ]);
    expect([a!.status, b!.status]).toEqual(["decided", "already"]);
    expect(b).toMatchObject({ decision: "approved", by: "slack:U1 (A)" });
  });

  it("reports a decision made through a link or the dashboard as 'already'", async () => {
    const h = harness();
    await h.start();
    await h.manager.decide(tokenOf(h.approvals[0]!.rejectUrl!), { by: "Aina" });
    expect(h.manager.decideByButton(h.approvals[0]!.buttons!.nonce, "approve", { by })).toEqual({
      status: "already",
      decision: "rejected",
      by: "Aina",
      at: new Date(T0).toISOString(),
    });
    // A link decision with no name typed.
    await h.start();
    await h.manager.decide(tokenOf(h.approvals[1]!.approveUrl!));
    expect(h.manager.decideByButton(h.approvals[1]!.buttons!.nonce, "reject", { by })).toMatchObject({ status: "already", decision: "approved", by: "someone via link" });
    // The dashboard.
    const { run } = await h.start();
    await h.manager.decideDirect(run.runId, "ok", true, undefined, { by: "owner@example.com", via: "dashboard" });
    expect(h.manager.decideByButton(h.approvals[2]!.buttons!.nonce, "reject", { by })).toMatchObject({ status: "already", decision: "approved", by: "owner@example.com" });
  });

  it("is 'expired' past the expiry, before and after the wait times out", async () => {
    const h = harness();
    const { run } = await h.start();
    const nonce = h.approvals[0]!.buttons!.nonce;
    h.setNow(T0 + 3_600_000);
    expect(h.manager.decideByButton(nonce, "approve", { by })).toEqual({ status: "expired" });
    await h.advance(0);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: null });
    expect(h.manager.decideByButton(nonce, "approve", { by })).toEqual({ status: "expired" });
  });

  it("is 'unknown' for another nonce, a bad one, and a run that stopped waiting", async () => {
    const h = harness();
    const { run } = await h.start();
    expect(h.manager.decideByButton(newButtonNonce(), "approve", { by })).toEqual({ status: "unknown" });
    for (const bad of ["", "short", `${h.approvals[0]!.buttons!.nonce}x`, 42 as never]) {
      expect(h.manager.decideByButton(bad, "approve", { by })).toEqual({ status: "unknown" });
    }
    expect(h.manager.decideByButton(h.approvals[0]!.buttons!.nonce, "maybe" as never, { by })).toEqual({ status: "unknown" });
    h.manager.cancel(run.runId);
    expect(h.manager.decideByButton(h.approvals[0]!.buttons!.nonce, "approve", { by })).toEqual({ status: "unknown" });
    expect(h.db.prepare(`SELECT used_at FROM _actuate_approval_buttons`).get()).toEqual({ used_at: null });
  });

  it("never awaits the pass: without an alarm it starts it in the background", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let pass = 0;
    const approvals: ApprovalRequest[] = [];
    const manager = new RunManager({
      sql: nodeSqlite(new DatabaseSync(":memory:")),
      approvalSecret: "s",
      approvalUrl: "https://example.test/approve",
      consoleLogs: false,
      buttonRoute: "local",
      notifyApproval: async (r) => void approvals.push(r),
      invoke: async (request, journal) => {
        if (++pass === 2) await held; // the resumed pass hangs until released
        return executePass(gate, request, { journal, config: {} });
      },
    });
    const { run } = await manager.start({ input: {}, trigger: { kind: "api" } });
    const outcome = manager.decideByButton(approvals[0]!.buttons!.nonce, "approve", { by });
    expect(outcome).toMatchObject({ status: "decided" });
    await new Promise((r) => setTimeout(r, 10));
    expect(pass).toBe(2);
    expect(manager.getRun(run.runId)!.status).toBe("WAITING");
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { approved: true, via: "chat", by } });
  });

  it("queues another pass when one is in flight, so the decision is not lost", async () => {
    let release!: () => void;
    let hold = false;
    const approvals: ApprovalRequest[] = [];
    const manager = new RunManager({
      sql: nodeSqlite(new DatabaseSync(":memory:")),
      approvalSecret: "s",
      approvalUrl: "https://example.test/approve",
      consoleLogs: false,
      buttonRoute: "local",
      notifyApproval: async (r) => void approvals.push(r),
      scheduleWake: () => {},
      invoke: async (request, journal) => {
        // This pass reads the steps, then stalls: it still sees the approval waiting.
        const steps = await journal.loadSteps();
        if (hold) await new Promise<void>((r) => (release = r));
        return executePass(gate, request, { journal: { ...journal, loadSteps: async () => steps }, config: {} });
      },
    });
    const { run } = await manager.start({ input: {}, trigger: { kind: "api" } });
    hold = true;
    const inFlight = manager.resume(run.runId);
    await new Promise((r) => setTimeout(r, 5));
    hold = false;
    expect(manager.decideByButton(approvals[0]!.buttons!.nonce, "approve", { by })).toMatchObject({ status: "decided" });
    release();
    await inFlight;
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { approved: true, via: "chat", by } });
  });
});

describe("agent-visible output", () => {
  it("never holds a nonce: run, steps, logs, the approval queue, the journal call", async () => {
    let returned: unknown = "unset";
    const h = harness(gate, {
      invoke: (request, journal) =>
        executePass(gate, request, {
          journal: { ...journal, requestApproval: async (s, o) => void (returned = await journal.requestApproval(s, o)) },
          config: {},
        }),
      // A notifier whose error echoes the button payload.
      notifyApproval: async (r) => {
        h2.approvals.push(r);
        throw new Error(`Bad Request: callback_data ap1:local:${r.buttons!.nonce}:a rejected for ${r.approveUrl}`);
      },
    });
    const h2 = { approvals: [] as ApprovalRequest[] };
    const { run } = await h.start();
    const nonce = h2.approvals[0]!.buttons!.nonce;
    expect(returned).toBeUndefined();
    const visible = JSON.stringify([run, h.manager.getRun(run.runId), h.manager.getSteps(run.runId), h.manager.getLogs(run.runId), h.manager.pendingApprovals()]);
    expect(visible).not.toContain(nonce);
    expect(visible).toContain("[nonce]");
    expect(visible).not.toMatch(/token=/);
    h.manager.decideByButton(nonce, "approve", { by: "telegram:1 (A)" });
    await h.advance(0);
    const after = JSON.stringify([h.manager.getRun(run.runId), h.manager.getSteps(run.runId), h.manager.getLogs(run.runId)]);
    expect(after).not.toContain(nonce);
  });
});

describe("actuator code", () => {
  it("can't send buttons of its own, or read the nonce table", async () => {
    const seen: unknown[] = [];
    const sneaky = defineActuator({
      name: "sneaky",
      description: "test",
      input: z.object({}),
      capabilities: ["messaging"],
      async run(ctx) {
        const approval = { kind: "approval" as const, actuator: "x", step: "s", expiresAt: 0, buttons: { route: "local", nonce: "AAAAAAAAAAAAAAAA" } };
        await ctx.step.do("send", () => ctx.messaging.send("boss", "Approve?", { approval }));
        return ctx.step.do("read", async () => {
          try {
            await ctx.db.query(`SELECT nonce FROM _actuate_approval_buttons`);
            return "read";
          } catch (err) {
            return (err as Error).message;
          }
        });
      },
    });
    const manager = new RunManager({
      sql: nodeSqlite(new DatabaseSync(":memory:")),
      approvalSecret: "s",
      approvalUrl: "https://example.test/approve",
      consoleLogs: false,
      buttonRoute: "local",
      invoke: (request, journal) =>
        executePass(sneaky, request, { journal, config: {}, providers: { messaging: { send: async (_to, _text, o) => (seen.push(o), { id: "1", channel: "t" }) } } }),
    });
    const { run } = await manager.start({ input: {}, trigger: { kind: "api" } });
    expect(run.output).toMatch(/reserved/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("approval");
  });
});

describe("notify: { to, channel }", () => {
  it("passes the channel to the notifier, apart from the recipient", async () => {
    const h = harness();
    await h.start({ notify: { to: "C0123", channel: "slack" } });
    await h.start({ notify: { to: "C0123" } });
    await h.start({ kind: "input", notify: { to: "42", channel: " telegram " } });
    expect(h.approvals.map((r) => [r.kind, r.notify, r.channel])).toEqual([
      ["approval", "C0123", "slack"],
      ["approval", "C0123", undefined],
      ["input", "42", "telegram"],
    ]);
    expect(h.approvals[0]!.buttons).toBeDefined();
  });

  it("fails the step's call for a notify it can't use", async () => {
    const h = harness();
    for (const [notify, error] of [
      [{ to: "owner" }, 'notify: { to: "owner" } is not allowed; use notify: "owner"'],
      [{ to: "owner", channel: "slack" }, 'use notify: "owner"'],
      [{ to: "" }, "notify.to must be a non-empty string"],
      [{ channel: "slack" }, "notify.to must be a non-empty string"],
      [{ to: "x", channel: "no spaces" }, "notify.channel must be a channel name"],
      [{ to: "x", channel: 7 }, "notify.channel must be a channel name"],
      [42, "notify must be a string or { to, channel }"],
      [["x"], "notify must be a string or { to, channel }"],
    ] as const) {
      const { run } = await h.start({ notify });
      expect(run.status, JSON.stringify(notify)).toBe("FAILED");
      expect(run.error?.message).toContain(error);
    }
    expect(h.approvals).toHaveLength(0);
  });

  it("logs a channel the messaging provider refuses like any delivery error, without links or the nonce", async () => {
    const h = harness(gate, {
      notifyApproval: async () => {
        throw new Error('No "slack" messaging channel is configured. Configured: telegram.');
      },
    });
    const { run } = await h.start({ notify: { to: "C1", channel: "slack" } });
    expect(run.status).toBe("WAITING");
    expect(h.manager.getLogs(run.runId).at(-1)).toMatchObject({
      level: "error",
      message: 'Could not deliver approval link for "ok"',
      data: { error: 'No "slack" messaging channel is configured. Configured: telegram.' },
    });
  });
});

describe("the _actuate_approval_buttons table", () => {
  it("is added to an existing database, whose waiting approvals keep working by link", async () => {
    const db = new DatabaseSync(":memory:");
    const old = harness(gate, { db, buttonRoute: undefined });
    const { run } = await old.start();
    db.exec(`DROP TABLE _actuate_approval_buttons`); // as a 0.4.x database has it
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = '_actuate_approval_buttons'`).all()).toEqual([]);

    const h = harness(gate, { db });
    harness(gate, { db }); // opening it again changes nothing
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '_actuate_approval_buttons%' ORDER BY name`).all()).toEqual([
      { name: "_actuate_approval_buttons" },
      { name: "_actuate_approval_buttons_run" },
    ]);
    expect(h.manager.getRun(run.runId)!.status).toBe("WAITING");
    expect(await h.manager.decide(tokenOf(old.approvals[0]!.approveUrl!))).toMatchObject({ ok: true });
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { approved: true, via: "link" } });
    await h.start();
    expect(h.approvals[0]!.buttons).toBeDefined();
  });

  it("is pruned with its runs, and of expired rows", async () => {
    const h = harness();
    const a = await h.start();
    h.manager.decideByButton(h.approvals[0]!.buttons!.nonce, "approve", { by: "telegram:1" });
    await h.advance(0);
    expect(h.manager.getRun(a.run.runId)!.status).toBe("COMPLETED");
    await h.start(); // still waiting, expires at T0 + 1 hour
    const count = () => Number((h.db.prepare(`SELECT count(*) AS n FROM _actuate_approval_buttons`).get() as { n: number }).n);
    expect(count()).toBe(2);
    expect(h.manager.pruneRuns(T0 + 1)).toBe(1);
    expect(count()).toBe(1);
    h.setNow(T0 + 2 * 3_600_000);
    h.manager.pruneRuns(T0);
    expect(count()).toBe(1); // not yet expired as of `before`
    h.manager.pruneRuns(T0 + 2 * 3_600_000);
    expect(count()).toBe(0);
  });
});
