import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "refund_order",
  description: "Refund an order. Above RM 100 a manager approves first. Each order is refunded once.",
  input: z.object({ orderId: z.string(), billId: z.string(), amount: z.number().positive().max(500) }),
  capabilities: ["payment", "messaging"],
  async run(ctx, input) {
    if (input.amount > 100) {
      // The run pauses here (for hours if it must) until the manager taps a signed link.
      const decision = await ctx.step.waitForApproval("manager", {
        message: `Refund RM ${input.amount} for order ${input.orderId}?`,
        notify: "@shop_manager",
        timeout: "24 hours",
      });
      if (!decision?.approved) return { status: "DECLINED", note: decision?.note ?? "timed out" };
    }
    // A step runs once. If the agent retries, it gets this result back, not a second refund.
    const refund = await ctx.step.do("refund", ({ idempotencyKey }) =>
      ctx.payment.refund!({ billId: input.billId, amount: input.amount, idempotencyKey }),
    );
    return { status: "REFUNDED", refundId: refund.id };
  },
});
