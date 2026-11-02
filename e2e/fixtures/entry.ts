import { createRuntime } from "@actuate/runtime/worker";
import { consoleMessaging } from "@actuate/runtime";
import actuator from "./actuator.js";

const runtime = createRuntime(actuator, { providers: () => ({ messaging: consoleMessaging(() => {}) }) });
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
