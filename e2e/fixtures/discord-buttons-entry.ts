/**
 * A self-hosted worker with Discord configured from the environment (ACTUATE_MESSAGING=discord, DISCORD_BOT_TOKEN,
 * DISCORD_PUBLIC_KEY, DISCORD_APPROVERS), the way `actuate dev` wires providers: approvals carry interactive
 * buttons, and clicks come back signed to /providers/discord/webhook.
 */
import { defineActuator, z } from "@actuate/sdk";
import { createRuntime } from "@actuate/runtime/worker";
import { parseProviderWebhookFromEnv, providerInteractionsFromEnv, providersFromEnv } from "@actuate/providers";

const actuator = defineActuator({
  name: "discord_buttons",
  description: "E2E fixture: an approval with Discord buttons.",
  input: z.object({ to: z.string() }),
  capabilities: ["messaging"],
  async run(ctx, input) {
    return ctx.step.waitForApproval("ok", { message: "Refund RM 20?", notify: input.to, timeout: "1 hour" });
  },
});

const runtime = createRuntime(actuator, {
  providers: (env, publicUrl) => providersFromEnv(env, publicUrl, (input, init) => fetch(input, init)),
  providerWebhook: (kind, request, env) => parseProviderWebhookFromEnv(env, kind, request),
  providerInteractions: (kind, env) => providerInteractionsFromEnv(env, kind, (input, init) => fetch(input, init)),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
