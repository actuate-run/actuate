/**
 * A self-hosted worker whose only messaging channel is the custom webhook, wired the way `actuate dev` wires it:
 * replies and decisions both arrive on /providers/custom-webhook/webhook.
 */
import { defineActuator, z, type InboundMessage } from "@actuate/sdk";
import { createRuntime } from "@actuate/runtime/worker";
import { parseProviderWebhookFromEnv, providerInteractionsFromEnv, providersFromEnv } from "@actuate/providers";

const actuator = defineActuator({
  name: "custom_buttons",
  description: "E2E fixture: an approval decided by a custom webhook receiver.",
  input: z.object({ to: z.string(), mode: z.enum(["approve", "reply"]).default("approve") }),
  capabilities: ["messaging"],
  async run(ctx, input) {
    if (input.mode === "reply") {
      const reply = await ctx.step.waitForEvent<InboundMessage>("reply", { event: `message.custom-webhook.${input.to}`, timeout: "1 day" });
      return { answer: reply?.text ?? null };
    }
    return await ctx.step.waitForApproval("ok", { message: "Refund RM 20?", notify: input.to, timeout: "1 hour" });
  },
});

const runtime = createRuntime(actuator, {
  providers: (env, publicUrl) => providersFromEnv(env, publicUrl),
  providerWebhook: (kind, request, env) => parseProviderWebhookFromEnv(env, kind, request),
  providerInteractions: (kind, env) => providerInteractionsFromEnv(env, kind),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
