# @actuate/sdk

Define Actuate actuators: one TypeScript file with durable steps, its own SQLite database and a schema-checked MCP tool.

```ts
import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "hello",
  description: "Greets someone, waits a day, then follows up.",
  input: z.object({ name: z.string() }),
  async run(ctx, input) {
    await ctx.step.do("greet", () => ctx.log.info(`Hello, ${input.name}!`));
    await ctx.step.sleep("1 day");
    await ctx.step.do("follow-up", () => ctx.log.info(`Still there, ${input.name}?`));
  },
});
```

Docs: https://actuate.run/docs · Source: https://github.com/actuate-run/actuate

License: Apache-2.0
