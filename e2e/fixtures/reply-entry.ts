import { createRuntime } from "@actuate/runtime/worker";
import { parseProviderWebhookFromEnv, providersFromEnv } from "@actuate/providers";
import actuator from "./reply.js";

const runtime = createRuntime(actuator, {
  providers: (env, publicUrl) => providersFromEnv(env, publicUrl),
  providerWebhook: (kind, request, env) => parseProviderWebhookFromEnv(env, kind, request),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
