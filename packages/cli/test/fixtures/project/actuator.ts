import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "fixture_greeter",
  description: "Greets someone and waits for a manager. A fixture for the CLI's tests.",
  config: z.object({ greeting: z.string().default("Hello") }),
  input: z.object({ name: z.string().min(1) }),
  capabilities: ["messaging"],
  async run(ctx, input, config) {
    await ctx.step.do("greet", () => ctx.messaging.send(input.name, `${config.greeting}, ${input.name}!`));
    const ok = await ctx.step.waitForApproval("ok");
    return { approved: ok?.approved ?? false };
  },
});
