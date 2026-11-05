import { defineActuator, secret, z, type Actuator } from "@actuate/sdk";
import { createRuntime } from "@actuate/runtime/worker";

const base = { description: "Config that fails to load, three ways.", input: z.object({}), run: () => "ran" };

/** A transform that throws with the secret in its message. */
const transform = defineActuator({
  ...base,
  name: "e2e_transform",
  config: z.object({ apiKey: secret(z.string()) }).transform((c) => {
    throw new Error(`cannot use ${c.apiKey}`);
  }),
});

/** A config schema the runtime can't turn into JSON Schema (so it can't tell which fields are secret). */
const unreadable = {
  ...defineActuator({ ...base, name: "e2e_unreadable" }),
  config: {
    safeParse: (raw: { apiKey?: string }) => {
      throw new RangeError(`refused ${raw.apiKey}`);
    },
  },
} as unknown as Actuator;

const a = createRuntime(transform);
const b = createRuntime(defineActuator({ ...base, name: "e2e_custom", config: z.object({ apiKey: secret(z.string()) }) }), {
  config: () => {
    throw new TypeError("could not read sk_live_CUSTOM_SECRET from the vault");
  },
});
const c = createRuntime(unreadable);

export default a.worker;
export const TransformObject = a.ActuatorObject;
export const CustomConfigObject = b.ActuatorObject;
export const UnreadableObject = c.ActuatorObject;
