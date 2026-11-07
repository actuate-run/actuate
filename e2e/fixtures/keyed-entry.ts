import { createRuntime } from "@actuate/runtime/worker";
import actuator from "./keyed.js";

const runtime = createRuntime(actuator, {
  // Says what it was given (never the links themselves), so the test can read it from the run's warning.
  notifyOwner: (env) =>
    env.NO_OWNER
      ? undefined
      : {
          notify: async (m) => ({
            sent: false,
            reason: `${m.subject} / ${m.text.startsWith("Refund ") ? "message" : "no message"} / ${/Approve: \S+\/approve\?token=\S+\nReject: \S+\/approve\?token=\S+$/.test(m.text) ? "links" : "no links"} / ${m.idempotencyKey === `approval:${m.runId}:ok` ? "keyed" : m.idempotencyKey}`,
          }),
        },
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
