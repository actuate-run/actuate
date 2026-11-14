import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineActuator, z } from "@actuate/sdk";
import { RunManager, executePass, nodeSqlite } from "../src/index.js";

/**
 * COMPATIBILITY.md: a wait resolves to `null` only when it timed out. An event always resolves it to a value
 * that is not `null`, so `if (!paid)` after `waitForEvent` means "nothing arrived", never "an empty event did".
 */
const waiter = defineActuator({
  name: "waiter",
  description: "test",
  input: z.object({}),
  async run(ctx) {
    const paid = await ctx.step.waitForEvent("payment", { event: "payment.A-1", timeout: "1 hour" });
    return { timedOut: paid === null, paid };
  },
});

function harness() {
  const clock = { now: Date.parse("2026-11-14T00:00:00Z") };
  const manager = new RunManager({
    sql: nodeSqlite(new DatabaseSync(":memory:")),
    approvalSecret: "s",
    approvalUrl: "https://example.test/approve",
    now: () => clock.now,
    consoleLogs: false,
    invoke: (request, journal) => executePass(waiter, request, { journal, config: {} }),
  });
  return { manager, clock, start: () => manager.start({ input: {}, trigger: { kind: "api" } }) };
}

describe("what a wait resolves to", () => {
  it("is null when it times out", async () => {
    const h = harness();
    const { run } = await h.start();
    h.clock.now += 3_600_000;
    await h.manager.alarm();
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { timedOut: true, paid: null } });
  });

  it.each([[null], [undefined]])("is {} for an event delivered with the payload %j, while the run waits", async (payload) => {
    const h = harness();
    const { run } = await h.start();
    await h.manager.deliverEvent("payment.A-1", payload as never);
    await h.manager.alarm();
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { timedOut: false, paid: {} } });
  });

  it("is {} for an event with a null payload that arrived before the wait began", async () => {
    const h = harness();
    await h.manager.deliverEvent("payment.A-1", null);
    const { run } = await h.start();
    expect(run).toMatchObject({ status: "COMPLETED", output: { timedOut: false, paid: {} } });
  });

  it("keeps other falsy payloads as they are", async () => {
    for (const payload of [0, false, ""]) {
      const h = harness();
      await h.manager.deliverEvent("payment.A-1", payload);
      expect((await h.start()).run).toMatchObject({ status: "COMPLETED", output: { timedOut: false, paid: payload } });
    }
  });
});
