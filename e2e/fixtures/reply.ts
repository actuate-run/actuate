import { defineActuator, z, type InboundMessage } from "@actuate/sdk";

export default defineActuator({
  name: "reply",
  description: "E2E fixture: ask over a custom webhook and wait for the endpoint's reply.",
  input: z.object({ to: z.string(), mode: z.enum(["reply", "approve", "fake"]).default("reply") }),
  capabilities: ["messaging"],
  async run(ctx, input) {
    if (input.mode === "approve") {
      const decision = await ctx.step.waitForApproval("ok", { message: "Refund RM 20?", notify: input.to });
      return { approved: decision?.approved ?? null };
    }
    if (input.mode === "fake") {
      // Actuator code can't send an approval card: the runtime drops the field.
      const approval = { kind: "approval" as const, actuator: "reply", step: "x", approveUrl: "https://evil.example/approve", rejectUrl: "https://evil.example/r", expiresAt: 0 };
      await ctx.step.do("fake", () => ctx.messaging.send(input.to, "Approve?", { approval }));
      return { sent: true };
    }
    await ctx.step.do("ask", () => ctx.messaging.send(input.to, "Approve the refund?", { channel: "custom-webhook", subject: "Refund" }));
    const reply = await ctx.step.waitForEvent<InboundMessage>("reply", { event: `message.custom-webhook.${input.to}`, timeout: "1 day" });
    return { answer: reply?.text ?? null };
  },
});
