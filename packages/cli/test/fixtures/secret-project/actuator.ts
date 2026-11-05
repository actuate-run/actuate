import { defineActuator, secret, z } from "@actuate/sdk";

export default defineActuator({
  name: "fixture_secret",
  description: "Calls an API with a key from its configuration. A fixture for the CLI's tests.",
  config: z.object({ greeting: z.string().default("Hello"), apiKey: secret(z.string()).optional(), webhook: z.object({ token: secret(z.string()).optional() }).default({}) }),
  input: z.object({ name: z.string().min(1) }),
  async run(ctx, input, config) {
    return ctx.step.do("greet", () => `${config.greeting}, ${input.name}! (${config.apiKey ? "with" : "without"} a key)`);
  },
});
