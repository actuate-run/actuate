import { createRuntime } from "@actuate/runtime/worker";
import { consoleMessaging } from "@actuate/runtime";
import actuator from "./actuator.js";

const runtime = createRuntime(actuator, {
  providers: () => ({ messaging: consoleMessaging(() => {}) }),
  // Says what it was given, so the test can see the secret was redacted before it got here.
  notifyOwner: () => ({
    notify: async (m) => ({ sent: false, reason: `${m.subject} / ${m.text.includes("[secret]") ? "redacted" : "raw"} / ${m.idempotencyKey.endsWith(":tell:notifyOwner:0") ? "keyed" : m.idempotencyKey}` }),
  }),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
