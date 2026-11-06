import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "e2e_keyed",
  description: "E2E fixture: one run per order (idempotencyKey),.",
  input: z.object({ orderId: z.string(), mode: z.enum(["done", "fail"]).default("done"), note: z.string().optional() }),
  idempotencyKey: ["orderId"],
  async run(ctx, input) {
    await ctx.step.do("record", () => ctx.log.info(`order ${input.orderId}`));
    if (input.mode === "fail") throw new Error("refused");
    return { trigger: ctx.trigger.kind };
  },
});
