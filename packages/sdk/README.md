# @actuate/sdk

Define an actuator: one TypeScript file that becomes a tool your AI agent can call over MCP (on the hosted platform) or HTTP. Steps run exactly once, waits cost nothing, and each actuator has its own SQLite database.

```bash
npm create actuate   # new project with the SDK and CLI
```

```ts
import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "hello",
  description: "Greets someone, waits a day, then follows up.",
  input: z.object({ name: z.string() }),
  async run(ctx, input) {
    await ctx.step.do("greet", () => ctx.log.info(`Hello, ${input.name}!`));
    await ctx.step.sleep("1 day"); // hibernates: nothing runs, nothing is billed
    await ctx.step.do("follow-up", () => ctx.log.info(`Still there, ${input.name}?`));
  },
});
```

| API | |
| --- | --- |
| `ctx.step.do(name, fn)` | Run `fn` once; replays and retries get the stored result |
| `ctx.step.sleep` / `sleepUntil` | Hibernate until a time |
| `ctx.step.waitForEvent` | Resume on a webhook, payment, inbound message or posted event |
| `ctx.step.waitForApproval` / `waitForInput` | Resume when a person approves or answers through a signed link, or approves with a chat button (`via: "chat"`, with a verified `by`); `notify: "owner"` sends the link to the actuator's owner, no messaging provider needed, and `notify: { to, channel }` picks the messaging channel |
| `ctx.db` | The actuator's own SQLite database. `batch([...])` runs statements all-or-nothing; `commitWithStep([...])` applies them with the step's completion |
| `ctx.messaging`, `ctx.payment`, `ctx.llm`, `ctx.http` | Declared capabilities, backed by your own accounts |
| `ctx.notifyOwner(text, { subject })` | Message the actuator's owner (email on the platform, the terminal under `actuate dev`), inside a step |
| `idempotencyKey: ["orderId"]` | One run per order: a repeated MCP or run API call with the same field values returns the first run (while it runs or waits, or for 24 hours after it completes) |
| `secret(schema)` | Mark a config field as secret (`apiKey: secret(z.string())`): its value is redacted from logs, errors and run records, and the platform never shows it again |

Reference: [SDK API](https://actuate.run/docs/reference/sdk/).

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
