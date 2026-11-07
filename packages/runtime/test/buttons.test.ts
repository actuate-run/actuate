import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineActuator, z, type Actuator } from "@actuate/sdk";
import {
  LOCAL_BUTTON_ROUTE,
  RunManager,
  buttonKindOfChannel,
  chatApproverLabel,
  clickOutcome,
  executePass,
  newButtonNonce,
  nodeSqlite,
  type ApprovalRequest,
  type Invoke,
  type RunManagerOptions,
} from "../src/index.js";

const T0 = Date.parse("2026-11-07T14:00:00Z");
/** The provider every test notifier "delivers" through, and every click comes from unless it says otherwise. */
const kind = "telegram";
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
    notifyApproval: async (r) => {
      approvals.push(r);
      if (r.buttons) manager.bindButtonKind(r.buttons.nonce, kind);
    },
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

  it("are not made for the owner, or while a route getter says none", async () => {
    const h = harness();
    await h.start({ notify: "owner" });
    expect(h.approvals[0]).toMatchObject({ notify: "owner" });
    expect(h.approvals[0]).not.toHaveProperty("buttons");
    let messaging = false;
    const g = harness(gate, { buttonRoute: () => (messaging ? "local" : undefined) });
    await g.start();
    messaging = true;
    await g.start();
    expect(g.approvals.map((r) => r.buttons?.route ?? null)).toEqual([null, "local"]);
    expect(Number((g.db.prepare(`SELECT count(*) AS n FROM _actuate_approval_buttons`).get() as { n: number }).n)).toBe(1);
  });

  it("take a route set after construction, checked the same way", async () => {
    const h = harness(gate, { buttonRoute: undefined });
    await h.start();
    expect(() => h.manager.setButtonRoute("has space")).toThrow(/buttonRoute must be 1-24 characters/);
    expect(() => h.manager.setButtonRoute(42 as never)).toThrow(/buttonRoute must be a string or a function/);
    await h.start();
    h.manager.setButtonRoute("act_0123456789abcdef");
    await h.start();
    h.manager.setButtonRoute(() => "not valid!"); // a getter's answer is checked per approval: no buttons
    await h.start();
    h.manager.setButtonRoute(undefined);
    await h.start();
    expect(h.approvals.map((r) => r.buttons?.route ?? null)).toEqual([null, null, "act_0123456789abcdef", null, null]);
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
    const outcome = h.manager.decideByButton(nonce, "approve", { by, kind });
    // Synchronous: a plain object, not a promise, and no pass ran.
    expect(outcome).toEqual({ status: "decided", decision: "approved", by, at: "2026-11-07T14:01:00.000Z", runId: run.runId, step: "ok" });
    expect(clickOutcome(outcome)).toEqual({ status: "decided", decision: "approved", by, at: "2026-11-07T14:01:00.000Z" });
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
    const { run } = await h.start();
    const nonce = h.approvals[0]!.buttons!.nonce;
    expect(h.manager.decideByButton(nonce, "reject", { by, kind })).toMatchObject({ status: "decided", decision: "rejected" });
    for (const action of ["approve", "reject"] as const) {
      expect(h.manager.decideByButton(nonce, action, { by: "telegram:2 (Bob)", kind })).toEqual({
        status: "already",
        decision: "rejected",
        at: new Date(T0).toISOString(),
        via: "chat",
        by,
        runId: run.runId,
        step: "ok",
      });
    }
    await h.advance(0);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "COMPLETED", output: { approved: false, via: "chat", by } });
    // Still "already" once the run has completed.
    expect(h.manager.decideByButton(nonce, "approve", { by, kind })).toMatchObject({ status: "already", decision: "rejected" });
  });

  it("gives 'already' to two clicks racing the first", async () => {
    const h = harness();
    await h.start();
    const nonce = h.approvals[0]!.buttons!.nonce;
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => h.manager.decideByButton(nonce, "approve", { by: "slack:U1 (A)", kind })),
      Promise.resolve().then(() => h.manager.decideByButton(nonce, "reject", { by: "slack:U2 (B)", kind })),
    ]);
    expect([a!.status, b!.status]).toEqual(["decided", "already"]);
    expect(b).toMatchObject({ decision: "approved", by: "slack:U1 (A)" });
  });

  it("reports a decision made through a link, the dashboard or the API as 'already', without its by", async () => {
    const h = harness();
    const first = await h.start();
    await h.manager.decide(tokenOf(h.approvals[0]!.rejectUrl!), { by: "Aina" });
    expect(h.manager.decideByButton(h.approvals[0]!.buttons!.nonce, "approve", { by, kind })).toEqual({
      status: "already",
      decision: "rejected",
      at: new Date(T0).toISOString(),
      via: "link",
      runId: first.run.runId,
      step: "ok",
    });
    // A link decision with no name typed.
    await h.start();
    await h.manager.decide(tokenOf(h.approvals[1]!.approveUrl!));
    const link = h.manager.decideByButton(h.approvals[1]!.buttons!.nonce, "reject", { by, kind });
    expect(link).toMatchObject({ status: "already", decision: "approved", via: "link" });
    expect(link).not.toHaveProperty("by");
    // The dashboard: the account email stays out of the outcome and the provider's reply.
    const dash = await h.start();
    await h.manager.decideDirect(dash.run.runId, "ok", true, undefined, { by: "owner@example.com", via: "dashboard" });
    const dashboard = h.manager.decideByButton(h.approvals[2]!.buttons!.nonce, "reject", { by, kind });
    expect(dashboard).toMatchObject({ status: "already", decision: "approved", via: "dashboard" });
    expect(dashboard).not.toHaveProperty("by");
    expect(clickOutcome(dashboard)).toEqual({ status: "already", decision: "approved", at: new Date(T0).toISOString(), via: "dashboard" });
    // The API, with a token's name.
    const api = await h.start();
    await h.manager.decideDirect(api.run.runId, "ok", false, undefined, { by: "owner@example.com (ci)", via: "api" });
    const viaApi = h.manager.decideByButton(h.approvals[3]!.buttons!.nonce, "approve", { by, kind });
    expect(clickOutcome(viaApi)).toEqual({ status: "already", decision: "rejected", at: new Date(T0).toISOString(), via: "api" });
  });

  it("keeps by in 'already' for a chat decision", async () => {
    const h = harness();
    await h.start();
    const nonce = h.approvals[0]!.buttons!.nonce;
    h.manager.decideByButton(nonce, "approve", { by, kind });
    expect(clickOutcome(h.manager.decideByButton(nonce, "reject", { by: "telegram:2 (Bob)", kind }))).toEqual({
      status: "already",
      decision: "approved",
      at: new Date(T0).toISOString(),
      via: "chat",
      by,
    });
  });

  it("is 'expired' past the expiry, before and after the wait times out", async () => {
    const h = harness();
    const { run } = await h.start();
    const nonce = h.approvals[0]!.buttons!.nonce;
    h.setNow(T0 + 3_600_000);
    expect(h.manager.decideByButton(nonce, "approve", { by, kind })).toEqual({ status: "expired" });
    await h.advance(0);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: null });
    expect(h.manager.decideByButton(nonce, "approve", { by, kind })).toEqual({ status: "expired" });
  });

  it("is 'unknown' for another nonce, a bad one, and a run that stopped waiting", async () => {
    const h = harness();
    const { run } = await h.start();
    expect(h.manager.decideByButton(newButtonNonce(), "approve", { by, kind })).toEqual({ status: "unknown" });
    for (const bad of ["", "short", `${h.approvals[0]!.buttons!.nonce}x`, 42 as never]) {
      expect(h.manager.decideByButton(bad, "approve", { by, kind })).toEqual({ status: "unknown" });
    }
    expect(h.manager.decideByButton(h.approvals[0]!.buttons!.nonce, "maybe" as never, { by, kind })).toEqual({ status: "unknown" });
    h.manager.cancel(run.runId);
    expect(h.manager.decideByButton(h.approvals[0]!.buttons!.nonce, "approve", { by, kind })).toEqual({ status: "unknown" });
    expect(h.db.prepare(`SELECT used_at FROM _actuate_approval_buttons`).get()).toEqual({ used_at: null });
  });

  it("decides only through the provider that delivered the buttons", async () => {
    const h = harness();
    const { run } = await h.start();
    const nonce = h.approvals[0]!.buttons!.nonce;
    expect(h.db.prepare(`SELECT kind FROM _actuate_approval_buttons`).get()).toEqual({ kind });
    // A nonce from a Telegram message replayed through another provider (say a custom webhook's Reply URL).
    for (const other of ["custom-webhook", "slack", "Telegram", "", undefined as never]) {
      expect(h.manager.decideByButton(nonce, "approve", { by: "custom-webhook:mallory", kind: other })).toEqual({ status: "unknown" });
    }
    expect(h.db.prepare(`SELECT used_at FROM _actuate_approval_buttons`).get()).toEqual({ used_at: null });
    expect(h.manager.decideByButton(nonce, "reject", { by, kind })).toMatchObject({ status: "decided", decision: "rejected" });
    // Even once decided, another provider learns nothing.
    expect(h.manager.decideByButton(nonce, "approve", { by: "slack:U1", kind: "slack" })).toEqual({ status: "unknown" });
    expect(h.manager.decideByButton(nonce, "approve", { by, kind })).toMatchObject({ status: "already", decision: "rejected" });
    expect(h.manager.getRun(run.runId)!.status).toBe("WAITING");
  });

  it("refuses a nonce never bound to a provider (the send failed), and binds each nonce once", async () => {
    const approvals: ApprovalRequest[] = [];
    const h = harness(gate, { notifyApproval: async (r) => void approvals.push(r) });
    await h.start();
    const nonce = approvals[0]!.buttons!.nonce;
    expect(h.manager.decideByButton(nonce, "approve", { by, kind })).toEqual({ status: "unknown" });
    expect(h.manager.bindButtonKind(nonce, "Bad Kind")).toBe(false);
    expect(h.manager.bindButtonKind("short", kind)).toBe(false);
    expect(h.manager.bindButtonKind(newButtonNonce(), kind)).toBe(false);
    expect(h.manager.bindButtonKind(nonce, kind)).toBe(true);
    expect(h.manager.bindButtonKind(nonce, "custom-webhook")).toBe(false); // already bound: never rebound
    expect(h.manager.decideByButton(nonce, "approve", { by: "custom-webhook:x", kind: "custom-webhook" })).toEqual({ status: "unknown" });
    expect(h.manager.decideByButton(nonce, "approve", { by, kind })).toMatchObject({ status: "decided" });
  });

  it("maps a receipt's channel to its provider kind", () => {
    expect(buttonKindOfChannel("telegram")).toBe("telegram");
    expect(buttonKindOfChannel("custom-webhook")).toBe("custom-webhook");
    expect(buttonKindOfChannel(" Email ")).toBe("resend");
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
      notifyApproval: async (r) => {
        approvals.push(r);
        if (r.buttons) manager.bindButtonKind(r.buttons.nonce, kind);
      },
      invoke: async (request, journal) => {
        if (++pass === 2) await held; // the resumed pass hangs until released
        return executePass(gate, request, { journal, config: {} });
      },
    });
    const { run } = await manager.start({ input: {}, trigger: { kind: "api" } });
    const outcome = manager.decideByButton(approvals[0]!.buttons!.nonce, "approve", { by, kind });
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
      notifyApproval: async (r) => {
        approvals.push(r);
        if (r.buttons) manager.bindButtonKind(r.buttons.nonce, kind);
      },
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
    expect(manager.decideByButton(approvals[0]!.buttons!.nonce, "approve", { by, kind })).toMatchObject({ status: "decided" });
    release();
    await inFlight;
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { approved: true, via: "chat", by } });
  });
});

describe("a click while a pass is in flight", () => {
  it("leaves the run due and the alarm set, so it resumes even if the queued pass is lost", async () => {
    let release!: () => void;
    let hold = false;
    let lost = false;
    const approvals: ApprovalRequest[] = [];
    const wakes: Array<number | null> = [];
    const db = new DatabaseSync(":memory:");
    const now = () => T0;
    const manager = new RunManager({
      sql: nodeSqlite(db),
      approvalSecret: "s",
      approvalUrl: "https://example.test/approve",
      consoleLogs: false,
      now,
      buttonRoute: "local",
      notifyApproval: async (r) => {
        approvals.push(r);
        if (r.buttons) manager.bindButtonKind(r.buttons.nonce, kind);
      },
      scheduleWake: (w) => void wakes.push(w),
      invoke: async (request, journal) => {
        if (lost) await new Promise(() => {}); // the isolate went away before the queued pass ran
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
    expect(manager.decideByButton(approvals[0]!.buttons!.nonce, "approve", { by: "telegram:1", kind })).toMatchObject({ status: "decided" });
    lost = true;
    release();
    await inFlight;
    // The in-flight pass settled without the step's wake time, yet the run stays due and the alarm is set for it.
    expect(db.prepare(`SELECT status, wake_at FROM _actuate_runs`).get()).toEqual({ status: "WAITING", wake_at: T0 });
    expect(wakes.at(-1)).toBe(T0);
    // A new isolate on the same storage: its alarm resumes the run.
    const fresh = new RunManager({
      sql: nodeSqlite(db),
      approvalSecret: "s",
      approvalUrl: "https://example.test/approve",
      consoleLogs: false,
      now,
      invoke: (request, journal) => executePass(gate, request, { journal, config: {} }),
    });
    await fresh.alarm();
    expect(fresh.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { approved: true, via: "chat", by: "telegram:1" } });
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
    h.manager.decideByButton(nonce, "approve", { by: "telegram:1 (A)", kind });
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

  it("gains the kind column on a database that has the table without it, whose nonces then decide nothing", async () => {
    const db = new DatabaseSync(":memory:");
    const old = harness(gate, { db });
    const { run } = await old.start();
    const nonce = old.approvals[0]!.buttons!.nonce;
    // As a database made before kinds were recorded has the table.
    db.exec(`DROP TABLE _actuate_approval_buttons`);
    db.exec(`CREATE TABLE _actuate_approval_buttons (nonce TEXT PRIMARY KEY, run_id TEXT NOT NULL, step TEXT NOT NULL,
      expires_at INTEGER NOT NULL, used_at INTEGER, used_by TEXT, decision TEXT) WITHOUT ROWID`);
    db.prepare(`INSERT INTO _actuate_approval_buttons (nonce, run_id, step, expires_at) VALUES (?, ?, 'ok', ?)`).run(nonce, run.runId, T0 + 3_600_000);

    const h = harness(gate, { db });
    harness(gate, { db }); // opening it again changes nothing
    const columns = (db.prepare(`SELECT name FROM pragma_table_info('_actuate_approval_buttons')`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(["nonce", "run_id", "step", "expires_at", "used_at", "used_by", "decision", "kind"]);
    expect(h.manager.decideByButton(nonce, "approve", { by: "telegram:1", kind })).toEqual({ status: "unknown" });
    await h.start();
    expect(h.manager.decideByButton(h.approvals[0]!.buttons!.nonce, "approve", { by: "telegram:1", kind })).toMatchObject({ status: "decided" });
  });

  it("is pruned with its runs, and of expired rows", async () => {
    const h = harness();
    const a = await h.start();
    h.manager.decideByButton(h.approvals[0]!.buttons!.nonce, "approve", { by: "telegram:1", kind });
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
