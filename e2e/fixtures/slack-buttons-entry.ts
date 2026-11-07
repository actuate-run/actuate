/**
 * A self-hosted worker with the real Slack provider configured from environment variables (incoming webhook,
 * signing secret, approvers), the way a self-hosted actuator wires it: messages go out with Block Kit buttons and
 * clicks come back to POST /providers/slack/webhook.
 */
import { defineActuator, z } from "@actuate/sdk";
import { createRuntime } from "@actuate/runtime/worker";
import { providerInteractionsFromEnv, providersFromEnv } from "@actuate/providers";

const actuator = defineActuator({
  name: "slack_buttons",
  description: "E2E fixture: an approval with Slack buttons.",
  input: z.object({ to: z.string() }),
  capabilities: ["messaging"],
  async run(ctx, input) {
    return ctx.step.waitForApproval("ok", { message: "Refund RM 20 to Aina?", notify: input.to, timeout: "1 hour" });
  },
});

const runtime = createRuntime(actuator, {
  providers: (env, publicUrl) => providersFromEnv(env, publicUrl),
  providerInteractions: (kind, env) => providerInteractionsFromEnv(env, kind),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
