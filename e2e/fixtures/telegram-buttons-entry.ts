/**
 * A self-hosted worker wired the way `actuate dev` wires real providers (providersFromEnv,
 * parseProviderWebhookFromEnv, providerInteractionsFromEnv), with Telegram as the messaging channel. The test
 * mocks api.telegram.org and clicks by posting callback_query updates to /providers/telegram/webhook.
 */
import { defineActuator, z } from "@actuate/sdk";
import { createRuntime } from "@actuate/runtime/worker";
import { parseProviderWebhookFromEnv, providerInteractionsFromEnv, providersFromEnv } from "@actuate/providers";

const actuator = defineActuator({
  name: "tg_buttons",
  description: "E2E fixture: a Telegram approval with Approve and Reject buttons.",
  input: z.object({ chat: z.string(), mode: z.enum(["approve", "ask"]).default("approve") }),
  capabilities: ["messaging"],
  async run(ctx, input) {
    if (input.mode === "ask") return { answer: (await ctx.step.waitForInput("why", { prompt: "Why?", notify: input.chat }))?.text ?? null };
    return await ctx.step.waitForApproval("ok", { message: "Refund RM 20?", notify: { to: input.chat, channel: "telegram" }, timeout: "1 hour" });
  },
});

const runtime = createRuntime(actuator, {
  providers: (env, publicUrl) => providersFromEnv(env, publicUrl),
  providerWebhook: (kind, request, env) => parseProviderWebhookFromEnv(env, kind, request),
  providerInteractions: (kind, env) => providerInteractionsFromEnv(env, kind),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
