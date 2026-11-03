import { defineActuator, z } from "@actuate/sdk";

/** E2E fixture: ctx.db.batch and ctx.db.commitWithStep on a real Durable Object, and default provider keys. */
export default defineActuator({
  name: "atomic",
  description: "E2E fixture: atomic database batches, writes committed with a step, and per-call idempotency keys.",
  input: z.object({ mode: z.enum(["batch", "commit", "keys"]) }),
  capabilities: ["messaging", "payment"],
  async run(ctx, input) {
    await ctx.db.migrate([
      "CREATE TABLE stock (sku TEXT PRIMARY KEY, qty INTEGER NOT NULL CHECK (qty >= 0))",
      "CREATE TABLE orders (id TEXT PRIMARY KEY, run_id TEXT, sku TEXT)",
    ]);
    if (input.mode === "batch") {
      await ctx.step.do("seed", () => ctx.db.batch([ctx.db.statement`INSERT INTO stock VALUES (${ctx.runId}, ${1})`]));
      const error = await ctx.step.do("oversell", async () => {
        try {
          await ctx.db.batch([
            ctx.db.statement`INSERT INTO orders VALUES (${`${ctx.runId}-1`}, ${ctx.runId}, ${ctx.runId})`,
            ctx.db.statement`INSERT INTO orders VALUES (${`${ctx.runId}-2`}, ${ctx.runId}, ${ctx.runId})`,
            ctx.db.statement`UPDATE stock SET qty = qty - ${2} WHERE sku = ${ctx.runId}`,
          ]);
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      });
      const sold = await ctx.step.do("sell", () =>
        ctx.db.batch([
          ctx.db.statement`UPDATE stock SET qty = qty - ${1} WHERE sku = ${ctx.runId} RETURNING qty`,
          ctx.db.statement`INSERT INTO orders VALUES (${`${ctx.runId}-3`}, ${ctx.runId}, ${ctx.runId})`,
        ]),
      );
      const orders = await ctx.db.query("SELECT id FROM orders WHERE run_id = ?", [ctx.runId]);
      return { error, sold, orders };
    }
    if (input.mode === "commit") {
      await ctx.step.do("order", { retries: 1, backoff: "1 second" }, ({ attempt }) => {
        ctx.db.commitWithStep([ctx.db.statement`INSERT INTO orders VALUES (${ctx.runId}, ${ctx.runId}, ${"tea"})`]);
        if (attempt === 1) throw new Error("first attempt fails after queueing its write");
        return attempt;
      });
      return { orders: await ctx.db.query("SELECT id FROM orders WHERE run_id = ?", [ctx.runId]) };
    }
    await ctx.step.do("checkout", { retries: 1, backoff: "1 second" }, async ({ attempt }) => {
      const bill = await ctx.payment.createBill({ amount: 50, currency: "USD", referenceId: ctx.runId });
      await ctx.messaging.send("buyer@example.test", `Pay at ${bill.url}`);
      await ctx.messaging.send("buyer@example.test", "Reminder", { idempotencyKey: `${ctx.runId}:reminder` });
      if (attempt === 1) throw new Error("fails after the provider calls, so the retry repeats them");
    });
    return { ok: true };
  },
});
