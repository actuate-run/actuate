import { createRuntime } from "@actuate/runtime/worker";
import actuator from "./keyed.js";

const runtime = createRuntime(actuator);
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
