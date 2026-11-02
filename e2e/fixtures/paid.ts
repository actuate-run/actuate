import { defineActuator, z, type PaymentEvent } from "@actuate/sdk";

export default defineActuator({
  name: "paid",
  description: "E2E fixture: Telegram message plus a Billplz bill and its signed callback.",
  input: z.object({ chat: z.string(), email: z.string() }),
  capabilities: ["messaging", "payment"],
  async run(ctx, input) {
    const bill = await ctx.step.do("bill", () => ctx.payment.createBill({ amount: 50, referenceId: ctx.runId, customer: { email: input.email } }));
    await ctx.step.do("tell", () => ctx.messaging.send(input.chat, `Pay here: ${bill.url}`));
    const paid = await ctx.step.waitForEvent<PaymentEvent>("paid", { event: `payment.${ctx.runId}`, timeout: "1 day" });
    return { status: paid?.status ?? "unpaid" };
  },
});
