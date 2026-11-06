import assert from "node:assert/strict";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { defineActuator, secret, z, type Actuator } from "@actuate/sdk";
import { deriveInputKey } from "@actuate/runtime";
import { TEST_START, testActuator, type ActuatorTest, type TestActuatorOptions } from "../src/testing.js";

const open: Array<() => void> = [];
const make = <A extends Actuator>(actuator: A, options?: TestActuatorOptions): ActuatorTest<A> => {
  const t = testActuator(actuator, options);
  open.push(() => t.close());
  return t;
};
afterEach(() => {
  for (const close of open.splice(0)) close();
});

const refund = defineActuator({
  name: "refund",
  description: "Asks a manager, then refunds and tells the customer.",
  config: z.object({ manager: z.string().default("mgr") }),
  input: z.object({ billId: z.string(), amount: z.number().positive(), phone: z.string() }),
  capabilities: ["payment", "messaging"],
  async run(ctx, input, config) {
    await ctx.db.migrate(["CREATE TABLE refunds (run_id TEXT PRIMARY KEY, status TEXT NOT NULL)"]);
    await ctx.step.do("record", () => ctx.db.sql`INSERT INTO refunds VALUES (${ctx.runId}, 'PENDING')`);
    const decision = await ctx.step.waitForApproval("manager", { message: `Refund ${input.amount}?`, notify: config.manager, timeout: "1 day" });
    if (!decision?.approved) {
      await ctx.step.do("mark", () => ctx.db.sql`UPDATE refunds SET status = 'REJECTED' WHERE run_id = ${ctx.runId}`);
      return { status: decision ? "REJECTED" : "EXPIRED", note: decision?.note ?? null };
    }
    const refund = await ctx.step.do("refund", (info) => ctx.payment.refund!({ billId: input.billId, amount: input.amount, idempotencyKey: info.idempotencyKey }));
    await ctx.step.do("tell", () => ctx.messaging.send(input.phone, "Refunded"));
    await ctx.step.do("done", () => ctx.db.sql`UPDATE refunds SET status = 'REFUNDED' WHERE run_id = ${ctx.runId}`);
    return { status: "REFUNDED", refundId: refund.id };
  },
});

const order = { billId: "bill-9", amount: 20, phone: "+60123" };

describe("testActuator", () => {
  it("runs a typical approval test in a few lines", async () => {
    const t = make(refund);
    const run = await t.start(order);
    expect(run.status).toBe("WAITING");
    expect(t.approvals[0]).toMatchObject({ notify: "mgr", message: "Refund 20?", kind: "approval" });
    await t.approve();
    expect(t.run(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "REFUNDED", refundId: "refund-1" }, passes: 2 });
    expect(t.refunds).toEqual([{ billId: "bill-9", amount: 20, idempotencyKey: `${run.runId}:refund` }]);
    // The runtime gives each provider call in a step its own idempotency key (runId:step:method:n).
    expect(t.messages).toEqual([{ to: "+60123", text: "Refunded", options: { idempotencyKey: `${run.runId}:tell:send:0` } }]);
    expect(t.rows("refunds")).toEqual([{ run_id: run.runId, status: "REFUNDED" }]);
    // Plain objects, so node:assert/strict compares them as written.
    assert.deepEqual(t.rows("refunds"), [{ run_id: run.runId, status: "REFUNDED" }]);
    assert.deepEqual(t.query("SELECT status FROM refunds"), [{ status: "REFUNDED" }]);
    const usage = t.usage(run.runId);
    expect(usage.passes).toBe(2);
    expect(usage.rowsWritten).toBeGreaterThan(5);
    expect(usage.rowsWritten).toBeLessThan(40);
    expect(t.usage()).toMatchObject({ rowsWritten: usage.rowsWritten, passes: 2 });
  });

  it("types outputs from the actuator, and keeps approval messages strings", async () => {
    const t = make(refund);
    const run = await t.start(order);
    const output = t.run(run.runId).output;
    expectTypeOf(output).not.toBeUnknown();
    expectTypeOf<NonNullable<typeof output>["status"]>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<typeof run.output>["status"]>().toEqualTypeOf<string>();
    expectTypeOf(t.approvals[0]!.message).toEqualTypeOf<string>();
    expect(t.approvals[0]!.message).toBe("Refund 20?");
    expectTypeOf(t.run<{ custom: true }>(run.runId).output).toEqualTypeOf<{ custom: true } | null>();
  });

  it("records ctx.notifyOwner messages", async () => {
    const act = defineActuator({
      name: "teller",
      description: "test",
      input: z.object({}),
      run: (ctx) => ctx.step.do("tell", () => ctx.notifyOwner("Look at this", { subject: "FYI" })),
    });
    const t = make(act);
    const run = await t.start();
    expect(run.output).toEqual({ sent: true });
    expect(t.ownerNotifications).toEqual([{ text: "Look at this", subject: "FYI", runId: run.runId, actuator: "teller", idempotencyKey: `${run.runId}:tell:notifyOwner:0` }]);
  });

  it("follows a signed link and reports a refusal instead of throwing", async () => {
    const t = make(refund);
    const run = await t.start(order);
    const request = t.approvals[0]!;
    await t.advance("2 days"); // the approval times out after 1 day
    expect(await t.followLink(request.approveUrl!)).toEqual({ ok: false, reason: "This link is invalid or has expired." });
    expect(t.run(run.runId).output).toEqual({ status: "EXPIRED", note: null });

    const fresh = await t.start(order);
    const link = t.approvals.at(-1)!;
    expect(await t.followLink(link.rejectUrl!, { note: "no" })).toMatchObject({ ok: true, approved: false });
    expect(await t.followLink(link.approveUrl!)).toEqual({ ok: false, reason: "This approval has already been decided or has expired." });
    expect(t.run(fresh.runId).output).toEqual({ status: "REJECTED", note: "no" });
  });

  it("deduplicates bills and refunds by idempotency key, as real providers do", async () => {
    const act = defineActuator({
      name: "twice",
      description: "test",
      input: z.object({}),
      capabilities: ["payment"],
      async run(ctx) {
        return ctx.step.do("pay", async () => {
          const a = await ctx.payment.createBill({ amount: 5, referenceId: "r", idempotencyKey: "k" });
          const b = await ctx.payment.createBill({ amount: 5, referenceId: "r", idempotencyKey: "k" });
          const c = await ctx.payment.refund!({ billId: a.id, idempotencyKey: "rk" });
          const d = await ctx.payment.refund!({ billId: a.id, idempotencyKey: "rk" });
          return [a.id, b.id, c.id, d.id];
        });
      },
    });
    const t = make(act);
    expect((await t.start()).output).toEqual(["bill-1", "bill-1", "refund-1", "refund-1"]);
    expect([t.bills.length, t.refunds.length]).toEqual([1, 1]);
  });

  it("rejects with a note, and times out when the clock passes the deadline", async () => {
    const t = make(refund);
    const a = await t.start(order);
    await t.reject("manager", { note: "not this one" });
    expect(t.run(a.runId).output).toEqual({ status: "REJECTED", note: "not this one" });

    const b = await t.start(order);
    await t.advance("23 hours");
    expect(t.run(b.runId).status).toBe("WAITING");
    await t.advance("1 hour");
    expect(t.run(b.runId).output).toEqual({ status: "EXPIRED", note: null });
    expect(t.refunds).toHaveLength(0);
  });

  it("says what is waiting when there is nothing to approve", async () => {
    const t = make(refund);
    await expect(t.approve()).rejects.toThrow("No approval (waitForApproval) is waiting. Waiting: nothing.");
    const run = await t.start(order);
    await expect(t.approve("other")).rejects.toThrow(`No approval (waitForApproval) is waiting at step "other". Waiting: "manager" (approval, ${run.runId}).`);
    await expect(t.answer("hi")).rejects.toThrow(/No question \(waitForInput\)/);
  });

  it("validates input and config with the actuator's schemas", async () => {
    const t = make(refund);
    await expect(t.start({ ...order, amount: -1 })).rejects.toThrow(/Invalid input:\n {2}amount: /);
    expect(() => make(refund, { config: { manager: 5 } })).toThrow(/invalid config:\n {2}manager: /);
  });

  it("answers waitForInput, delivers events and pays bills filled in from the bill", async () => {
    const act = defineActuator({
      name: "deposit",
      description: "test",
      input: z.object({}),
      capabilities: ["payment"],
      async run(ctx) {
        const bill = await ctx.step.do("bill", () => ctx.payment.createBill({ amount: 50, referenceId: ctx.runId }));
        const paid = await ctx.step.waitForEvent<{ status: string; billId: string; amount: number }>("paid", { event: `payment.${ctx.runId}` });
        const shipped = await ctx.step.waitForEvent<{ by: string }>("shipped", { event: "shipped" });
        const note = await ctx.step.waitForInput("note", { prompt: "Note?" });
        return { url: bill.url, paid, shipped, note: note?.text };
      },
    });
    const t = make(act);
    const run = await t.start();
    await t.pay(run.runId);
    await t.event("shipped", { by: "courier" });
    await t.answer("Thanks!", { by: "Aina" });
    expect(t.run(run.runId).output).toEqual({
      url: `https://pay.test/${run.runId}`,
      paid: { provider: "test", status: "paid", referenceId: run.runId, billId: "bill-1", amount: 50, currency: "MYR" },
      shipped: { by: "courier" },
      note: "Thanks!",
    });
  });

  it("fires every alarm inside an advance, in order", async () => {
    const act = defineActuator({
      name: "ticks",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        const times: string[] = [];
        for (let i = 0; i < 3; i++) {
          await ctx.step.sleep(`wait-${i}`, "1 hour");
          times.push(await ctx.step.do(`tick-${i}`, () => new Date().toISOString()));
        }
        return times;
      },
    });
    const t = make(act);
    const run = await t.start();
    await t.advance("1 day");
    expect(t.run(run.runId).output).toEqual(["2026-01-05T01:00:00.000Z", "2026-01-05T02:00:00.000Z", "2026-01-05T03:00:00.000Z"]);
    expect(t.now()).toBe(TEST_START + 86_400_000);
    expect(Date.now()).toBe(t.now());
  });

  it("serves llm replies from a queue and http through the real allow-list", async () => {
    const act = defineActuator({
      name: "summarise",
      description: "test",
      input: z.object({ url: z.string() }),
      capabilities: ["llm", "http"],
      http: { allow: ["api.example.com"] },
      async run(ctx, input) {
        const page = await ctx.step.do("fetch", async () => (await ctx.http.fetch(input.url)).json() as Promise<{ text: string }>);
        return ctx.step.do("summarise", async () => (await ctx.llm.complete({ prompt: page.text })).text);
      },
    });
    const t = make(act, { llm: ["short"], http: async (req) => ({ text: `body of ${new URL(req.url).pathname}` }) });
    const ok = await t.start({ url: "https://api.example.com/a" });
    expect(t.run(ok.runId).output).toBe("short");
    expect(t.prompts).toEqual([{ prompt: "body of /a" }]);
    expect(t.requests.map((r) => r.url)).toEqual(["https://api.example.com/a"]);

    const refused = await t.start({ url: "https://evil.example.org/" });
    expect(t.run(refused.runId).error?.message).toMatch(/evil\.example\.org is not in this actuator's http\.allow list/);
    const noReply = await t.start({ url: "https://api.example.com/b" });
    expect(t.run(noReply.runId).error?.message).toMatch(/no reply queued/);
  });

  it("starts cron runs with the input {}", async () => {
    const act = defineActuator({
      name: "daily",
      description: "test",
      input: z.object({ day: z.string().default("today") }),
      cron: ["0 9 * * *"],
      run: (ctx, input) => ({ trigger: ctx.trigger, day: input.day }),
    });
    const t = make(act);
    expect((await t.cron()).output).toEqual({ trigger: { kind: "cron", cron: "0 9 * * *" }, day: "today" });
    const strict = make(defineActuator({ name: "strict", description: "t", input: z.object({ id: z.string() }), run: () => 1 }));
    await expect(strict.cron("0 * * * *")).rejects.toThrow(/Cron runs start with the input \{\}/);
  });

  it("derives the run key from idempotencyKey as the platform and the self-hosted runtime do", async () => {
    let n = 0;
    const act = defineActuator({
      name: "one_per_order",
      description: "test",
      // A default lets cron runs start here; the deploy checks would refuse it (idempotency-key).
      input: z.object({ orderId: z.string().default("daily"), fail: z.boolean().default(false) }),
      idempotencyKey: ["orderId"],
      cron: ["0 9 * * *"],
      async run(ctx, input) {
        const count = await ctx.step.do("count", () => ++n);
        if (input.fail) throw new Error("boom");
        return count;
      },
    });
    const t = make(act);
    const first = await t.start({ orderId: "A-1" });
    // Same order, other fields, field order: the first run. Over MCP too.
    expect((await t.start({ fail: false, orderId: "A-1" })).runId).toBe(first.runId);
    expect((await t.start({ orderId: "A-1" }, { trigger: "mcp" })).runId).toBe(first.runId);
    // The stored key is the one the hosts compute from the input as sent.
    expect(t.query("SELECT input_key FROM _actuate_runs WHERE run_id = ?", [first.runId])).toEqual([{ input_key: await deriveInputKey(["orderId"], { orderId: "A-1" }) }]);
    // A key of the caller's own forces a new run; webhooks and cron never derive one.
    expect((await t.start({ orderId: "A-1" }, { idempotencyKey: "again" })).runId).not.toBe(first.runId);
    const hooks = [await t.start({ orderId: "A-1" }, { trigger: "webhook" }), await t.start({ orderId: "A-1" }, { trigger: "webhook" })];
    expect(new Set([first.runId, ...hooks.map((r) => r.runId)]).size).toBe(3);
    expect((await t.cron()).runId).not.toBe((await t.cron()).runId);
    // A failed run never blocks a retry; a completed one matches for 24 hours.
    const failed = await t.start({ orderId: "B-1", fail: true });
    expect(failed.status).toBe("FAILED");
    expect((await t.start({ orderId: "B-1" })).status).toBe("COMPLETED");
    await t.advance("24 hours");
    await t.advance("1 second");
    const later = await t.start({ orderId: "A-1" });
    expect(later.runId).not.toBe(first.runId);
    expect(later.output).toBe(n);
  });

  it("redacts secret config values only with redactSecrets, and replays still see the real value", async () => {
    const act = defineActuator({
      name: "keyed",
      description: "test",
      config: z.object({ apiKey: secret(z.string()) }),
      input: z.object({}),
      async run(ctx, _input, config) {
        const used = await ctx.step.do("use", () => `key=${config.apiKey}`);
        await ctx.step.sleep("pause", "1 minute");
        ctx.log.info(`used ${used}`);
        await ctx.step.do("tell", () => ctx.notifyOwner(`your key is ${config.apiKey}`));
        // After the sleep this is a replay: the stored step value must still be the real one.
        return { used, same: used === `key=${config.apiKey}` };
      },
    });
    const key = "sk_test_9f8e7d6c";
    const red = make(act, { config: { apiKey: key }, redactSecrets: true });
    const run = await red.start({});
    await red.advance("1 minute");
    const done = red.run(run.runId);
    expect(done.output).toEqual({ used: "key=[secret]", same: true });
    expect(JSON.stringify(red.steps(run.runId))).not.toContain(key);
    expect(JSON.stringify(red.logs(run.runId))).not.toContain(key);
    expect(red.ownerNotifications[0]!.text).toBe("your key is [secret]");

    const plain = make(act, { config: { apiKey: key } });
    const raw = await plain.start({});
    await plain.advance("1 minute");
    expect(plain.run(raw.runId).output).toEqual({ used: `key=${key}`, same: true });
    expect(plain.ownerNotifications[0]!.text).toBe(`your key is ${key}`);
  });

  it("types the agent that started a run on ctx.trigger, without a cast", async () => {
    const act = defineActuator({
      name: "who",
      description: "test",
      input: z.object({}),
      // No cast: `agent` is declared on Trigger.
      run: (ctx) => ({ agent: ctx.trigger.agent?.name ?? null }),
    });
    const t = make(act);
    const byAgent = await t.start({}, { trigger: { kind: "mcp", agent: { id: "tok_1", name: "support-bot" } } });
    expect(byAgent.output).toEqual({ agent: "support-bot" });
    expect((await t.start({})).output).toEqual({ agent: null });
  });

  it("leaves an optional capability undefined when its provider is removed", async () => {
    const act = defineActuator({
      name: "maybe",
      description: "test",
      input: z.object({}),
      optionalCapabilities: ["messaging"],
      run: (ctx) => ({ has: ctx.messaging !== undefined }),
    });
    expect((await make(act).start()).output).toEqual({ has: true });
    expect((await make(act, { providers: { messaging: undefined } }).start()).output).toEqual({ has: false });
  });
});

describe("testActuator guards", () => {
  const sqlActuator = (sql: string) =>
    defineActuator({
      name: "sql",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        await ctx.db.query(sql);
        return "ran";
      },
    });

  it("refuses the SQL the platform refuses, with its message", async () => {
    for (const [sql, message] of [
      ["PRAGMA table_info(x)", "PRAGMA, ATTACH, DETACH, VACUUM and REINDEX are not allowed."],
      ["WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n LIMIT 5) SELECT * FROM n", "Recursive queries are not allowed."],
      ["SELECT randomblob(10)", "That SQL function is not allowed."],
    ]) {
      const t = make(sqlActuator(sql!));
      expect(t.run((await t.start()).runId).error?.message).toBe(message);
    }
    // The runtime's own refusal of _actuate_ tables comes first, as on the platform.
    const t = make(sqlActuator("SELECT * FROM _actuate_runs"));
    expect(t.run((await t.start()).runId).error?.message).toBe("Tables starting with _actuate_ are reserved for the runtime.");
  });

  it("fails a step result over 1 MiB without retrying it", async () => {
    let attempts = 0;
    const act = defineActuator({
      name: "big",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        return ctx.step.do("big", { retries: 3 }, () => {
          attempts++;
          return "x".repeat(1024 * 1024);
        });
      },
    });
    const t = make(act);
    const run = await t.start();
    expect(t.run(run.runId)).toMatchObject({ status: "FAILED", error: { message: "A step's result may be at most 1024 KiB of JSON." } });
    expect(attempts).toBe(1);
    // With the guards off, it goes through.
    const off = make(act, { plan: false });
    expect(off.run((await off.start()).runId).status).toBe("COMPLETED");
  });

  it("caps statements per pass", async () => {
    const act = defineActuator({
      name: "chatty",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        for (let i = 0; i < 1_001; i++) await ctx.db.query("SELECT 1");
      },
    });
    const t = make(act);
    expect(t.run((await t.start()).runId).error?.message).toBe("A single pass may run at most 1000 database statements.");
  });

  it("applies the plan's longest wait and passes per run", async () => {
    const sleeper = defineActuator({
      name: "sleeper",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        await ctx.step.sleep("long", "30 days");
        return "woke";
      },
    });
    const sandbox = make(sleeper, { plan: "sandbox" });
    expect(sandbox.run((await sandbox.start()).runId).error?.message).toBe('Step "long" sleeps 2592000s, longer than this plan allows (604800s).');
    const maker = make(sleeper, { plan: "maker" });
    const run = await maker.start();
    await maker.advance("30 days");
    expect(maker.run(run.runId).output).toBe("woke");

    const looper = defineActuator({
      name: "looper",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        for (let i = 0; i < 300; i++) await ctx.step.sleep(`s${i}`, "1 minute");
      },
    });
    const t = make(looper);
    const loop = await t.start();
    await t.advance("1 day");
    expect(t.run(loop.runId)).toMatchObject({ status: "FAILED", error: { message: "Run exceeded 200 passes" } });
  });

  it("reads the plan from ACTUATE_PLAN, as `actuate test --plan` sets it", () => {
    const before = process.env.ACTUATE_PLAN;
    process.env.ACTUATE_PLAN = "agency";
    try {
      expect(make(refund).plan).toBe("agency");
      expect(make(refund, { plan: "maker" }).plan).toBe("maker");
    } finally {
      if (before === undefined) delete process.env.ACTUATE_PLAN;
      else process.env.ACTUATE_PLAN = before;
    }
    expect(make(refund).plan).toBe("sandbox");
  });

  it("gives Date back when the last test closes", async () => {
    const realNow = Date.now();
    const t = testActuator(refund);
    expect(Date.now()).toBe(TEST_START);
    t.close();
    expect(Math.abs(Date.now() - realNow)).toBeLessThan(60_000);
    await expect(t.start(order)).rejects.toThrow("This test actuator is closed.");
  });
});

describe("atomic writes under the local guards", () => {
  const ledger = defineActuator({
    name: "ledger",
    description: "Writes with ctx.db.batch and ctx.db.commitWithStep.",
    input: z.object({ mode: z.enum(["ok", "pragma"]) }),
    async run(ctx, input) {
      await ctx.db.migrate(["CREATE TABLE entries (id TEXT PRIMARY KEY, amount INTEGER NOT NULL)"]);
      if (input.mode === "pragma") {
        return ctx.step.do("bad", () => ctx.db.batch([ctx.db.statement`INSERT INTO entries VALUES ('a', 1)`, { sql: "PRAGMA writable_schema = 1", params: [] }]));
      }
      const rows = await ctx.step.do("pair", async () => {
        const [, sum] = await ctx.db.batch<{ total: number }>([
          ctx.db.statement`INSERT INTO entries VALUES (${`${ctx.runId}:a`}, ${5})`,
          { sql: "SELECT SUM(amount) AS total FROM entries", params: [] },
        ]);
        return sum![0]!.total;
      });
      await ctx.step.do("later", () => {
        ctx.db.commitWithStep([ctx.db.statement`INSERT INTO entries VALUES (${`${ctx.runId}:b`}, ${7})`]);
        return true;
      });
      return { total: rows };
    },
  });

  it("keeps ctx.db.statement synchronous, and checks every statement of a batch like the platform", async () => {
    const t = make(ledger);
    const ok = await t.start({ mode: "ok" });
    expect(t.run(ok.runId)).toMatchObject({ status: "COMPLETED", output: { total: 5 } });
    expect(t.rows("entries")).toHaveLength(2);
    const bad = await t.start({ mode: "pragma" });
    expect(t.run(bad.runId)).toMatchObject({ status: "FAILED" });
    expect(t.run(bad.runId)!.error?.message).toMatch(/PRAGMA/);
    // Refused before it ran: nothing of the batch was written.
    expect(t.rows("entries")).toHaveLength(2);
  });

  it("counts commitWithStep's writes in the run's usage, like a batch's", async () => {
    const many = (n: number) =>
      defineActuator({
        name: `many${n}`,
        description: "Ten inserts, by batch or commitWithStep.",
        input: z.object({ how: z.enum(["batch", "commit"]) }),
        async run(ctx, input) {
          await ctx.db.migrate(["CREATE TABLE r (id TEXT PRIMARY KEY)"]);
          const statements = Array.from({ length: 10 }, (_, i) => ctx.db.statement`INSERT INTO r VALUES (${`${ctx.runId}:${i}`})`);
          if (input.how === "batch") await ctx.step.do("w", () => ctx.db.batch(statements));
          else await ctx.step.do("w", () => (ctx.db.commitWithStep(statements), true));
          return true;
        },
      });
    const a = make(many(1));
    const viaBatch = a.usage((await a.start({ how: "batch" })).runId).rowsWritten;
    const b = make(many(2));
    const viaCommit = b.usage((await b.start({ how: "commit" })).runId).rowsWritten;
    expect(viaCommit).toBe(viaBatch);
  });

  it("attributes a commit's queued writes to its run even when they name the run, and leaves other runs alone", async () => {
    const named = defineActuator({
      name: "named",
      description: "Queued writes that carry the run ID as a parameter.",
      input: z.object({}),
      async run(ctx) {
        await ctx.db.migrate(["CREATE TABLE log (run_id TEXT NOT NULL, n INTEGER NOT NULL)"]);
        await ctx.step.do("w", () => {
          ctx.db.commitWithStep(Array.from({ length: 5 }, (_, i) => ctx.db.statement`INSERT INTO log VALUES (${ctx.runId}, ${i})`));
          return true;
        });
        return true;
      },
    });
    const t = make(named);
    await t.start({}); // the first run also applies the migration
    const second = (await t.start({})).runId;
    const third = (await t.start({})).runId;
    // Same work, same count (5 queued inserts plus the journal): nothing leaks from one run into the next.
    expect(t.usage(second).rowsWritten).toBe(t.usage(third).rowsWritten);
    expect(t.usage(second).rowsWritten).toBeGreaterThanOrEqual(5);
    expect(t.rows("log")).toHaveLength(15);
  });
});
