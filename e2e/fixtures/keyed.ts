import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "e2e_keyed",
  description: "E2E fixture: one run per order (idempotencyKey), and approvals sent to the owner.",
  input: z.object({ orderId: z.string(), mode: z.enum(["done", "fail", "approve"]).default("done"), note: z.string().optional() }),
  idempotencyKey: ["orderId"],
  async run(ctx, input) {
    await ctx.step.do("record", () => ctx.log.info(`order ${input.orderId}`));
    if (input.mode === "fail") throw new Error("refused");
    if (input.mode === "approve") {
      const decision = await ctx.step.waitForApproval("ok", { message: `Refund ${input.orderId}?`, notify: "owner" });
      return { approved: decision?.approved ?? null };
    }
    return { trigger: ctx.trigger.kind };
  },
});
