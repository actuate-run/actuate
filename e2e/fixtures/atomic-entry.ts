import { createRuntime } from "@actuate/runtime/worker";
import { providersFromEnv } from "@actuate/providers";
import actuator from "./atomic.js";

const runtime = createRuntime(actuator, { providers: (env, publicUrl) => providersFromEnv(env, publicUrl) });
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
