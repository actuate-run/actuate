import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { NonRetryableError, defineActuator, z, type Actuator, type Providers } from "@actuate/sdk";
import { RunManager, executePass, nodeSqlite, type ApprovalRequest } from "../src/index.js";

function harness(
  actuator: Actuator,
  opts: { providers?: Partial<Providers>; config?: unknown; manager?: Partial<ConstructorParameters<typeof RunManager>[0]> } = {},
) {
  let now = Date.parse("2026-11-02T00:00:00Z");
  const approvals: ApprovalRequest[] = [];
  const wakes: Array<number | null> = [];
  const config = (actuator.config ?? z.object({})).parse(opts.config ?? {});
  const manager = new RunManager({
    sql: nodeSqlite(new DatabaseSync(":memory:")),
    approvalSecret: "test-secret",
    approvalUrl: "https://example.test/approve",
    now: () => now,
    consoleLogs: false,
    notifyApproval: async (r) => void approvals.push(r),
    scheduleWake: (w) => void wakes.push(w),
    invoke: (request, journal) => executePass(actuator, request, { journal, config, ...(opts.providers ? { providers: opts.providers } : {}) }),
    ...opts.manager,
  });
  return {
    manager,
    approvals,
    wakes,
    advance: async (ms: number) => {
      now += ms;
      await manager.alarm();
    },
    start: (input: unknown = {}, idempotencyKey?: string) =>
      manager.start({ input: input as never, trigger: { kind: "api" }, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  };
}

const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

describe("step.do", () => {
  it("memoizes completed steps across replays", async () => {
    const calls = { a: 0, b: 0 };
    const act = defineActuator({
      name: "memo",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        const a = await ctx.step.do("a", () => ++calls.a);
        await ctx.step.sleep("1 hour");
        const b = await ctx.step.do("b", () => ++calls.b);
        return { a, b };
      },
    });
    const h = harness(act);
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    expect(run.wakeAt).toBe(Date.parse("2026-11-02T01:00:00Z"));
    expect(h.wakes.at(-1)).toBe(run.wakeAt);

    await h.advance(30 * 60_000);
    expect(h.manager.getRun(run.runId)!.status).toBe("WAITING");

    await h.advance(30 * 60_000);
    const done = h.manager.getRun(run.runId)!;
    expect(done.status).toBe("COMPLETED");
    expect(done.output).toEqual({ a: 1, b: 1 });
    expect(calls).toEqual({ a: 1, b: 1 });
    expect(h.manager.getSteps(run.runId).map((s) => [s.name, s.status])).toEqual([
      ["a", "COMPLETED"],
      ["sleep#1", "COMPLETED"],
      ["b", "COMPLETED"],
    ]);
    expect(h.wakes.at(-1)).toBeNull();
  });

  it("returns the JSON round-trip on the first pass too", async () => {
    const act = defineActuator({
      name: "roundtrip",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        const v = await ctx.step.do("d", () => ({ when: new Date(0), gone: undefined as unknown }));
        return { type: typeof v.when, hasGone: "gone" in v };
      },
    });
    const { run } = await harness(act).start();
    expect(run.output).toEqual({ type: "string", hasGone: false });
  });

  it("retries with exponential backoff, then succeeds", async () => {
    let attempts = 0;
    const act = defineActuator({
      name: "retry",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        return ctx.step.do("flaky", { retries: 3, backoff: "10s" }, ({ attempt }) => {
          attempts++;
          if (attempt < 3) throw new Error(`boom ${attempt}`);
          return attempt;
        });
      },
    });
    const h = harness(act);
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    await h.advance(10_000); // retry 1 after 10s
    expect(h.manager.getRun(run.runId)!.status).toBe("WAITING");
    await h.advance(10_000); // retry 2 is due 20s after its failure
    expect(h.manager.getRun(run.runId)!.status).toBe("WAITING");
    await h.advance(10_000);
    expect(h.manager.getRun(run.runId)!).toMatchObject({ status: "COMPLETED", output: 3 });
    expect(attempts).toBe(3);
  });

  it("fails the run when retries are exhausted or the error is non-retryable", async () => {
    const act = defineActuator({
      name: "fail",
      description: "test",
      input: z.object({ hard: z.boolean() }),
      async run(ctx, input) {
        return ctx.step.do("x", { retries: 5 }, () => {
          throw input.hard ? new NonRetryableError("card declined") : new Error("soft");
        });
      },
    });
    const { run } = await harness(act).start({ hard: true });
    expect(run.status).toBe("FAILED");
    expect(run.error?.message).toBe("card declined");
  });

  it("lets user code catch a step failure, and replays the failure deterministically", async () => {
    const act = defineActuator({
      name: "catcher",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        let fallback = false;
        try {
          await ctx.step.do("bad", () => {
            throw new Error("nope");
          });
        } catch {
          fallback = true;
        }
        await ctx.step.sleep("1s");
        return { fallback };
      },
    });
    const h = harness(act);
    const { run } = await h.start();
    await h.advance(1000);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { fallback: true } });
  });

  it("rejects duplicate and nested step names", async () => {
    const dup = defineActuator({
      name: "dup",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        await ctx.step.do("same", () => 1);
        await ctx.step.do("same", () => 2);
      },
    });
    expect((await harness(dup).start()).run.error?.message).toMatch(/used twice/);

    const nested = defineActuator({
      name: "nested",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        await ctx.step.do("outer", () => ctx.step.do("inner", () => 1));
      },
    });
    expect((await harness(nested).start()).run.error?.message).toMatch(/cannot be nested/);
  });
});

describe("waits", () => {
  const waiter = defineActuator({
    name: "waiter",
    description: "test",
    input: z.object({ id: z.string() }),
    async run(ctx, input) {
      const paid = await ctx.step.waitForEvent("payment", { event: `payment.${input.id}`, timeout: "2 hours" });
      return { paid };
    },
  });

  it("resumes when the event arrives", async () => {
    const h = harness(waiter);
    const { run } = await h.start({ id: "b1" });
    expect(run.status).toBe("WAITING");
    const res = await h.manager.deliverEvent("payment.b1", { amount: 50 });
    expect(res.resumed).toEqual([run.runId]);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { paid: { amount: 50 } } });
  });

  it("resolves to null after the timeout", async () => {
    const h = harness(waiter);
    const { run } = await h.start({ id: "b2" });
    await h.advance(2 * 3_600_000);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { paid: null } });
    // A late event is buffered, not delivered to the finished run.
    expect((await h.manager.deliverEvent("payment.b2", {})).buffered).toBe(true);
  });

  it("consumes an event that arrived before the wait started", async () => {
    const h = harness(waiter);
    expect((await h.manager.deliverEvent("payment.b3", { early: true })).buffered).toBe(true);
    const { run } = await h.start({ id: "b3" });
    expect(run).toMatchObject({ status: "COMPLETED", output: { paid: { early: true } } });
  });

  it("refuses to post approval events directly", async () => {
    await expect(harness(waiter).manager.deliverEvent("approval:x:y")).rejects.toThrow(/signed link/);
  });
});

describe("waitForApproval", () => {
  const refund = defineActuator({
    name: "refund",
    description: "test",
    input: z.object({ amount: z.number() }),
    async run(ctx, input) {
      const decision = await ctx.step.waitForApproval("manager-ok", { message: `Refund RM${input.amount}?`, notify: "boss", timeout: "1 day" });
      if (!decision?.approved) return { refunded: false, timedOut: decision === null };
      await ctx.step.do("refund", () => true);
      return { refunded: true, timedOut: false };
    },
  });

  it("notifies once with signed links and resumes on approve", async () => {
    const h = harness(refund);
    const { run } = await h.start({ amount: 80 });
    expect(run.status).toBe("WAITING");
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ runId: run.runId, step: "manager-ok", notify: "boss", message: "Refund RM80?" });
    expect(h.manager.pendingApprovals()).toMatchObject([{ step: "manager-ok", message: "Refund RM80?" }]);

    const result = await h.manager.decide(tokenOf(h.approvals[0]!.approveUrl));
    expect(result).toMatchObject({ ok: true, approved: true });
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { refunded: true } });

    // Single use: the reject link no longer works, and nothing re-notifies.
    expect(await h.manager.decide(tokenOf(h.approvals[0]!.rejectUrl))).toMatchObject({ ok: false });
    expect(h.approvals).toHaveLength(1);
    expect(h.manager.pendingApprovals()).toHaveLength(0);
  });

  it("rejects tampered tokens and handles reject and timeout", async () => {
    const h = harness(refund);
    const { run } = await h.start({ amount: 10 });
    const token = tokenOf(h.approvals[0]!.rejectUrl);
    expect(await h.manager.decide(token.slice(0, -2) + "xx")).toMatchObject({ ok: false });
    await h.manager.decide(token);
    expect(h.manager.getRun(run.runId)!.output).toEqual({ refunded: false, timedOut: false });

    const { run: run2 } = await h.start({ amount: 10 });
    await h.advance(86_400_000);
    expect(h.manager.getRun(run2.runId)!.output).toEqual({ refunded: false, timedOut: true });
    expect(await h.manager.decide(tokenOf(h.approvals[1]!.approveUrl))).toMatchObject({ ok: false });
  });
});

describe("runs", () => {
  it("returns the first run for a repeated idempotency key", async () => {
    let n = 0;
    const act = defineActuator({
      name: "idem",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        return ctx.step.do("count", () => ++n);
      },
    });
    const h = harness(act);
    const first = await h.start({}, "key-1");
    const second = await h.start({}, "key-1");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.runId).toBe(first.run.runId);
    expect(n).toBe(1);
  });

  it("still suspends when user code swallows the suspend signal", async () => {
    const act = defineActuator({
      name: "swallow",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        try {
          await ctx.step.sleep("5m");
        } catch {
          /* bad practice */
        }
        return "should not complete on first pass";
      },
    });
    const h = harness(act);
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    await h.advance(5 * 60_000);
    expect(h.manager.getRun(run.runId)!.status).toBe("COMPLETED");
  });

  it("validates output against the output schema", async () => {
    const act = defineActuator({
      name: "outschema",
      description: "test",
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      async run() {
        return { ok: false } as never;
      },
    });
    expect((await harness(act).start()).run).toMatchObject({ status: "FAILED" });
  });

  it("cancels a waiting run", async () => {
    const act = defineActuator({
      name: "cancel",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        await ctx.step.sleep("1h");
      },
    });
    const h = harness(act);
    const { run } = await h.start();
    expect(h.manager.cancel(run.runId)).toBe(true);
    await h.advance(3_600_000);
    expect(h.manager.getRun(run.runId)!.status).toBe("CANCELLED");
  });
});

describe("ctx.db and capabilities", () => {
  it("migrates once, binds parameters and guards reserved tables", async () => {
    const act = defineActuator({
      name: "db",
      description: "test",
      input: z.object({ name: z.string() }),
      async run(ctx, input) {
        await ctx.db.migrate(["CREATE TABLE people (name TEXT)", "ALTER TABLE people ADD COLUMN n INTEGER"]);
        await ctx.step.do("insert", () => ctx.db.sql`INSERT INTO people (name, n) VALUES (${input.name}, ${1})`);
        const rows = await ctx.db.query<{ name: string }>("SELECT name FROM people WHERE name = ?", [input.name]);
        let reserved = "";
        try {
          await ctx.db.query("SELECT * FROM _actuate_steps");
        } catch (e) {
          reserved = (e as Error).message;
        }
        return { rows, reserved };
      },
    });
    const h = harness(act);
    await h.start({ name: "Robert'); DROP TABLE people;--" });
    const { run } = await h.start({ name: "Aina" });
    expect(run.output).toMatchObject({ rows: [{ name: "Aina" }], reserved: expect.stringMatching(/reserved/) });
    expect(h.manager.listTables()).toEqual(["people"]);
    expect(h.manager.readTable("people").rows).toHaveLength(2);
  });

  it("requires provider calls inside steps and configured providers", async () => {
    const send = vi.fn(async () => ({ id: "m1", channel: "test" }));
    const act = defineActuator({
      name: "caps",
      description: "test",
      input: z.object({ inside: z.boolean() }),
      capabilities: ["messaging"],
      async run(ctx, input) {
        if (input.inside) return ctx.step.do("send", () => ctx.messaging.send("+60123456789", "hi"));
        return ctx.messaging.send("+60123456789", "hi");
      },
    });
    const h = harness(act, { providers: { messaging: { send } } });
    expect((await h.start({ inside: false })).run.error?.message).toMatch(/inside ctx.step.do/);
    expect((await h.start({ inside: true })).run).toMatchObject({ status: "COMPLETED", output: { id: "m1" } });
    expect(send).toHaveBeenCalledTimes(1);

    const unconfigured = harness(act);
    expect((await unconfigured.start({ inside: true })).run.error?.message).toMatch(/no messaging provider is configured/);
  });
});

describe("blueprint example: deposit booking", () => {
  const deposit = defineActuator({
    name: "deposit_booking",
    description: "Books a slot, sends a payment link, waits for the webhook or reminds.",
    config: z.object({
      businessName: z.string().default("Klinik Pergigian Senyum"),
      depositAmountRM: z.number().min(10).max(500).default(50),
      reminderDelay: z.enum(["30 minutes", "2 hours", "24 hours"]).default("2 hours"),
    }),
    input: z.object({
      customerName: z.string(),
      phone: z.string().regex(/^\+60\d{9,10}$/),
      appointmentIso: z.string().datetime(),
    }),
    capabilities: ["payment", "messaging"],
    async run(ctx, input, config) {
      await ctx.db.migrate(["CREATE TABLE bookings (id TEXT PRIMARY KEY, name TEXT, phone TEXT, status TEXT)"]);
      const bookingId = await ctx.step.do("save-booking", async () => {
        await ctx.db.query("INSERT INTO bookings (id, name, phone, status) VALUES (?, ?, ?, 'PENDING')", [
          ctx.runId,
          input.customerName,
          input.phone,
        ]);
        return ctx.runId;
      });
      const payUrl = await ctx.step.do("send-link", async () => {
        const bill = await ctx.payment.createBill({ amount: config.depositAmountRM, referenceId: bookingId });
        await ctx.messaging.send(input.phone, `Hi ${input.customerName}, confirm with a RM${config.depositAmountRM} deposit: ${bill.url}`);
        return bill.url;
      });
      const paid = await ctx.step.waitForEvent("payment", { event: `payment.${bookingId}`, timeout: config.reminderDelay });
      if (!paid) {
        await ctx.step.do("remind", () => ctx.messaging.send(input.phone, `Reminder: ${payUrl}`));
        return { status: "REMINDER_SENT", bookingId };
      }
      await ctx.step.do("confirm", () => ctx.db.query("UPDATE bookings SET status='CONFIRMED' WHERE id = ?", [bookingId]));
      return { status: "CONFIRMED", bookingId };
    },
  });

  const providers = () => {
    const sent: string[] = [];
    return {
      sent,
      providers: {
        messaging: { send: async (_to: string, text: string) => (sent.push(text), { id: String(sent.length), channel: "test" }) },
        payment: {
          createBill: async (r: { amount: number; referenceId: string }) => ({
            id: "bill1",
            url: `https://pay.test/${r.referenceId}`,
            status: "pending" as const,
            amount: r.amount,
            currency: "MYR",
            referenceId: r.referenceId,
          }),
          getBill: async () => {
            throw new Error("unused");
          },
        },
      } satisfies Partial<Providers>,
    };
  };
  const input = { customerName: "Aina", phone: "+60123456789", appointmentIso: "2026-11-05T09:00:00Z" };

  it("confirms when paid", async () => {
    const p = providers();
    const h = harness(deposit, { providers: p.providers, config: { depositAmountRM: 80 } });
    const { run } = await h.start(input);
    expect(p.sent).toEqual([`Hi Aina, confirm with a RM80 deposit: https://pay.test/${run.runId}`]);
    await h.manager.deliverEvent(`payment.${run.runId}`, { status: "paid" });
    expect(h.manager.getRun(run.runId)!.output).toEqual({ status: "CONFIRMED", bookingId: run.runId });
    expect(h.manager.readTable("bookings").rows[0]).toMatchObject({ status: "CONFIRMED" });
  });

  it("reminds after the delay", async () => {
    const p = providers();
    const h = harness(deposit, { providers: p.providers });
    const { run } = await h.start(input);
    await h.advance(2 * 3_600_000);
    expect(h.manager.getRun(run.runId)!.output).toEqual({ status: "REMINDER_SENT", bookingId: run.runId });
    expect(p.sent).toHaveLength(2);
  });
});

describe("runaway guards", () => {
  const sleeper = defineActuator({
    name: "sleeper",
    description: "test",
    input: z.object({ ms: z.number() }),
    async run(ctx, input) {
      await ctx.step.sleep("nap", input.ms);
      return "woke";
    },
  });

  it("fails sleeps longer than the plan allows and clamps open-ended waits", async () => {
    const h = harness(sleeper, { manager: { passLimits: { maxWaitMs: 60_000 } } });
    expect((await h.start({ ms: 120_000 })).run.error?.message).toMatch(/longer than this plan allows/);
    expect((await h.start({ ms: 30_000 })).run.status).toBe("WAITING");

    const waiter = defineActuator({
      name: "forever",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        return { got: await ctx.step.waitForEvent("e", { event: "never" }) };
      },
    });
    const w = harness(waiter, { manager: { passLimits: { maxWaitMs: 60_000 } } });
    const { run } = await w.start();
    expect(run.wakeAt).toBe(Date.parse("2026-11-02T00:01:00Z"));
    await w.advance(60_000);
    expect(w.manager.getRun(run.runId)!.output).toEqual({ got: null });
  });

  it("clamps retries", async () => {
    let calls = 0;
    const act = defineActuator({
      name: "manyretries",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        return ctx.step.do("x", { retries: 1_000_000, backoff: "1s" }, () => {
          calls++;
          throw new Error("no");
        });
      },
    });
    const h = harness(act, { manager: { passLimits: { maxRetries: 2 } } });
    const { run } = await h.start();
    await h.advance(1_000);
    await h.advance(2_000);
    expect(h.manager.getRun(run.runId)!.status).toBe("FAILED");
    expect(calls).toBe(3);
  });

  it("defers passes the budget refuses, without losing the run", async () => {
    let open = false;
    const h = harness(sleeper, { manager: { admitPass: () => (open ? null : Date.parse("2026-12-01T00:00:00Z")) } });
    const { run } = await h.start({ ms: 1 });
    expect(run).toMatchObject({ status: "WAITING", wakeAt: Date.parse("2026-12-01T00:00:00Z"), passes: 0 });
    open = true;
    await h.advance(30 * 86_400_000);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "WAITING" }); // now sleeping 1 ms
    await h.advance(1);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: "woke" });
  });

  it("caps buffered events and payload size", async () => {
    const h = harness(sleeper, { manager: { maxBufferedEvents: 3, maxEventBytes: 100 } });
    for (let i = 0; i < 10; i++) await h.manager.deliverEvent(`k${i}`, { i });
    await expect(h.manager.deliverEvent("big", { s: "x".repeat(200) })).rejects.toThrow(/too large/);
    const waiter = defineActuator({
      name: "late",
      description: "test",
      input: z.object({ k: z.string() }),
      async run(ctx, input) {
        return ctx.step.waitForEvent("e", { event: input.k, timeout: "1s" });
      },
    });
    const w = harness(waiter, { manager: { maxBufferedEvents: 3 } });
    for (let i = 0; i < 10; i++) await w.manager.deliverEvent(`k${i}`, { i });
    expect((await w.start({ k: "k9" })).run.output).toEqual({ i: 9 });
    expect((await w.start({ k: "k0" })).run.status).toBe("WAITING"); // dropped
  });

  it("prunes settled runs but keeps waiting ones", async () => {
    const h = harness(sleeper);
    const done = (await h.start({ ms: 0 })).run;
    const waiting = (await h.start({ ms: 3_600_000 })).run;
    expect(done.status).toBe("COMPLETED");
    expect(h.manager.pruneRuns(Date.parse("2026-11-03T00:00:00Z"))).toBe(1);
    expect(h.manager.getRun(done.runId)).toBeNull();
    expect(h.manager.getSteps(done.runId)).toEqual([]);
    expect(h.manager.getRun(waiting.runId)).not.toBeNull();
  });
});

describe("optional capabilities and the step clock", () => {
  const act = defineActuator({
    name: "optional_alert",
    description: "test",
    input: z.object({}),
    optionalCapabilities: ["messaging"],
    async run(ctx) {
      const sent = await ctx.step.do("alert", async ({ now }) => {
        const receipt = await ctx.messaging?.send("ops", `at ${now}`);
        return { sent: Boolean(receipt), now };
      });
      return sent;
    },
  });

  it("is undefined when unconfigured and works when configured", async () => {
    expect((await harness(act).start()).run.output).toEqual({ sent: false, now: Date.parse("2026-11-02T00:00:00Z") });
    const send = vi.fn(async () => ({ id: "1", channel: "t" }));
    const out = (await harness(act, { providers: { messaging: { send } } }).start()).run.output;
    expect(out).toMatchObject({ sent: true });
    expect(send).toHaveBeenCalledWith("ops", `at ${Date.parse("2026-11-02T00:00:00Z")}`);
  });

  it("rejects bad declarations", () => {
    expect(() =>
      defineActuator({ name: "x", description: "x", input: z.object({}), capabilities: ["messaging"], optionalCapabilities: ["messaging"], run() {} }),
    ).toThrow(/both required and optional/);
    expect(() =>
      defineActuator({ name: "x", description: "x", input: z.object({}), optionalCapabilities: ["http"], run() {} }),
    ).toThrow(/cannot be optional/);
  });
});

describe("security", () => {
  it("never writes approval links to run logs, but the owner can fetch them", async () => {
    const act = defineActuator({
      name: "gate",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        return ctx.step.waitForApproval("ok", { timeout: "1 hour" });
      },
    });
    const h = harness(act);
    const { run } = await h.start();
    expect(JSON.stringify(h.manager.getLogs(run.runId))).not.toContain("token=");
    const links = await h.manager.approvalLinks(run.runId, "ok");
    expect(links?.approveUrl).toBe(h.approvals[0]!.approveUrl);
    expect(await h.manager.approvalLinks(run.runId, "nope")).toBeNull();
  });

  it("neutralises spreadsheet formulas in CSV exports", async () => {
    const { toCsv } = await import("../src/index.js");
    expect(toCsv(["a"], [{ a: "=HYPERLINK(\"x\")" }, { a: "-1" }, { a: 5 }])).toBe(`a\r\n"'=HYPERLINK(""x"")"\r\n'-1\r\n5\r\n`);
  });

  it("http refuses its own hosts (any case or trailing dot), blocked platforms and IP literals", async () => {
    const { createHttpProvider } = await import("../src/index.js");
    const http = createHttpProvider({
      allow: ["*.example.com", "run.actuate.test"],
      selfOrigins: ["https://run.actuate.test"],
      blockedHosts: ["actuate.test"],
      fetch: (async () => new Response("ok")) as typeof fetch,
    });
    await expect(http.fetch("https://RUN.actuate.test./a/x/webhook")).rejects.toThrow(/own URL/);
    await expect(http.fetch("https://1.2.3.4/")).rejects.toThrow(/IP addresses/);
    expect((await http.fetch("https://api.example.com/")).status).toBe(200);
  });
});
