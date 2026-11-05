import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineActuator, z, type Actuator, type OwnerNotification, type OwnerNotifier } from "@actuate/sdk";
import { RunManager, executePass, nodeSqlite } from "../src/index.js";

function harness(actuator: Actuator, owner?: OwnerNotifier, runId?: string) {
  let now = Date.parse("2026-11-02T00:00:00Z");
  const manager = new RunManager({
    sql: nodeSqlite(new DatabaseSync(":memory:")),
    approvalSecret: "test-secret",
    approvalUrl: "https://example.test/approve",
    now: () => now,
    consoleLogs: false,
    invoke: (request, journal) => executePass(actuator, request, { journal, config: {}, ...(owner ? { owner } : {}) }),
  });
  return {
    manager,
    start: (input: unknown = {}) => manager.start({ input: input as never, trigger: { kind: "api" }, ...(runId ? { runId } : {}) }),
    advance: async (ms: number) => {
      now += ms;
      await manager.alarm();
    },
  };
}

/** Records every message; answers with `reply` (sent by default). */
function recorder(reply: (m: OwnerNotification) => { sent: boolean; reason?: string } = () => ({ sent: true })) {
  const sent: OwnerNotification[] = [];
  return { sent, owner: { notify: async (m: OwnerNotification) => (sent.push(m), reply(m)) } satisfies OwnerNotifier };
}

const notifying = (body: (ctx: Parameters<Actuator["run"]>[0], input: { text?: string; subject?: string }) => Promise<unknown>) =>
  defineActuator({
    name: "notifier",
    description: "test",
    input: z.object({ text: z.string().optional(), subject: z.string().optional() }),
    run: (ctx, input) => body(ctx as never, input),
  });

describe("ctx.notifyOwner", () => {
  it("hands the notifier the message, with keys derived per call like provider calls", async () => {
    const r = recorder();
    const act = notifying(async (ctx) =>
      ctx.step.do("tell", async () => [await ctx.notifyOwner("first", { subject: "Heads up" }), await ctx.notifyOwner("second")]),
    );
    const { run } = await harness(act, r.owner, "run_abc").start();
    expect(run.status).toBe("COMPLETED");
    expect(run.output).toEqual([{ sent: true }, { sent: true }]);
    expect(r.sent).toEqual([
      { text: "first", subject: "Heads up", runId: "run_abc", actuator: "notifier", idempotencyKey: "run_abc:tell:notifyOwner:0" },
      { text: "second", runId: "run_abc", actuator: "notifier", idempotencyKey: "run_abc:tell:notifyOwner:1" },
    ]);
  });

  it("gives a retried step the same keys, and never calls the notifier again once the step completed", async () => {
    const r = recorder();
    let attempts = 0;
    const act = notifying(async (ctx) => {
      await ctx.step.do("tell", { retries: 2, backoff: "1 second" }, async () => {
        await ctx.notifyOwner("hello");
        if (++attempts < 2) throw new Error("flaky");
      });
      await ctx.step.sleep("1 minute");
      return "done";
    });
    const h = harness(act, r.owner, "run_retry");
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    await h.advance(1_000); // the retry
    await h.advance(60_000); // the sleep; "tell" replays from the journal
    expect(h.manager.getRun(run.runId)!.status).toBe("COMPLETED");
    expect(r.sent.map((m) => m.idempotencyKey)).toEqual(["run_retry:tell:notifyOwner:0", "run_retry:tell:notifyOwner:0"]);
  });

  it("keeps a derived key within 255 characters for a very long run ID", async () => {
    const r = recorder();
    const act = notifying(async (ctx) => ctx.step.do("tell", () => ctx.notifyOwner("x")));
    await harness(act, r.owner, `run_${"x".repeat(240)}`).start();
    expect(r.sent[0]!.idempotencyKey).toHaveLength(223);
    expect(r.sent[0]!.idempotencyKey).toMatch(/~[0-9a-f]{32}$/);
  });

  it("must be called inside a step", async () => {
    const r = recorder();
    const act = notifying(async (ctx) => ctx.notifyOwner("outside"));
    const { run } = await harness(act, r.owner).start();
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatchObject({ name: "ActuatorError", message: "ctx.notifyOwner() must be called inside ctx.step.do(...); otherwise it repeats on every replay." });
    expect(r.sent).toEqual([]);
  });

  it.each([
    [{ text: "" }, "ctx.notifyOwner() needs the message text."],
    [{ text: "   " }, "ctx.notifyOwner() needs the message text."],
    [{ text: "x".repeat(4_001) }, "ctx.notifyOwner(): the text is 4001 characters; at most 4,000 are allowed."],
    [{ text: "ok", subject: "s".repeat(201) }, "ctx.notifyOwner(): the subject is 201 characters; at most 200 are allowed."],
    [{ text: "ok", subject: "Hi\r\nBcc: someone@example.com" }, "ctx.notifyOwner(): the subject must be one line, without control characters."],
    [{ text: "ok", subject: "tab\there" }, "ctx.notifyOwner(): the subject must be one line, without control characters."],
  ])("refuses %j before the notifier sees it", async (input, message) => {
    const r = recorder();
    const act = notifying(async (ctx, i) => ctx.step.do("tell", () => ctx.notifyOwner(i.text!, i.subject === undefined ? undefined : { subject: i.subject })));
    const { run } = await harness(act, r.owner).start(input);
    expect(run.status).toBe("FAILED");
    expect(run.error!.message).toBe(message);
    expect(r.sent).toEqual([]);
  });

  it("accepts the longest text and subject", async () => {
    const r = recorder();
    const act = notifying(async (ctx, i) => ctx.step.do("tell", () => ctx.notifyOwner(i.text!, { subject: i.subject! })));
    const { run } = await harness(act, r.owner).start({ text: "x".repeat(4_000), subject: "s".repeat(200) });
    expect(run.status).toBe("COMPLETED");
    expect(r.sent[0]!.text).toHaveLength(4_000);
  });

  it("without a notifier, logs the message and resolves to sent: false", async () => {
    const act = notifying(async (ctx) => ctx.step.do("tell", async () => [await ctx.notifyOwner("Refund #12 is stuck", { subject: "Refunds" }), await ctx.notifyOwner("plain")]));
    const h = harness(act);
    const { run } = await h.start();
    expect(run.output).toEqual([
      { sent: false, reason: "No owner notifier is configured; the message was logged." },
      { sent: false, reason: "No owner notifier is configured; the message was logged." },
    ]);
    expect(h.manager.getLogs(run.runId).map((l) => [l.level, l.message])).toEqual([
      ["info", "Owner notification: Refunds: Refund #12 is stuck"],
      ["info", "Owner notification: plain"],
    ]);
  });

  it("passes on a refusal (a cap) without failing the step, and logs a warning", async () => {
    const r = recorder(() => ({ sent: false, reason: "The daily limit of 20 alert emails is reached." }));
    const act = notifying(async (ctx) => ctx.step.do("tell", () => ctx.notifyOwner("hello")));
    const h = harness(act, r.owner);
    const { run } = await h.start();
    expect(run).toMatchObject({ status: "COMPLETED", output: { sent: false, reason: "The daily limit of 20 alert emails is reached." } });
    expect(h.manager.getLogs(run.runId)).toMatchObject([{ level: "warn", message: "Owner notification not sent: The daily limit of 20 alert emails is reached." }]);
  });

  it("lets a notifier failure fail the step attempt, so it can retry", async () => {
    let calls = 0;
    const owner: OwnerNotifier = {
      notify: async () => {
        if (++calls === 1) throw new Error("mail server down");
        return { sent: true };
      },
    };
    const act = notifying(async (ctx) => ctx.step.do("tell", { retries: 1 }, () => ctx.notifyOwner("hello")));
    const h = harness(act, owner);
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    await h.advance(1_000);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { sent: true } });
  });
});
