import { defineActuator, z, type InboundMessage } from "@actuate/sdk";

export default defineActuator({
  name: "reply",
  description: "E2E fixture: ask over a custom webhook and wait for the endpoint's reply.",
  input: z.object({ to: z.string() }),
  capabilities: ["messaging"],
  async run(ctx, input) {
    await ctx.step.do("ask", () => ctx.messaging.send(input.to, "Approve the refund?", { channel: "custom-webhook", subject: "Refund" }));
    const reply = await ctx.step.waitForEvent<InboundMessage>("reply", { event: `message.custom-webhook.${input.to}`, timeout: "1 day" });
    return { answer: reply?.text ?? null };
  },
});
