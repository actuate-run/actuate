# Actuate

Hosted, durable TypeScript scripts. An **actuator** is one TypeScript file with a durable step engine, its own SQLite database and an MCP endpoint, deployed in one command and costing nothing while it sleeps.

```ts
import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "hello",
  description: "Greets someone, waits a day, then follows up.",
  input: z.object({ name: z.string() }),
  async run(ctx, input) {
    await ctx.step.do("greet", () => ctx.log.info(`Hello, ${input.name}!`));
    await ctx.step.sleep("1 day"); // hibernates: no memory, no cost
    await ctx.step.do("follow-up", () => ctx.log.info(`Still there, ${input.name}?`));
  },
});
```

```bash
npm create actuate my-bot
cd my-bot && npm install && npx actuate dev
```

Locally, messages print to the console and payments are faked unless you pick real providers in `.dev.vars` (`actuate providers` lists the variables), e.g. `ACTUATE_MESSAGING=telegram` and `TELEGRAM_BOT_TOKEN=...`.

## Packages

| Package | What it is |
| --- | --- |
| [`@actuate/sdk`](packages/sdk) | `defineActuator`, `ctx.step.*`, `ctx.db`, provider types |
| [`@actuate/runtime`](packages/runtime) | The step engine: journal, replay, sleeps, events, approvals. Runs on `workerd` with SQLite, so you can self-host |
| [`@actuate/cli`](packages/cli) | The `actuate` command: `init`, `dev`, `check`, `deploy`, `run`, `logs` |
| [`@actuate/providers`](packages/providers) | Bring-your-own-credentials adapters: Telegram, WhatsApp Cloud, Resend, Stripe, Chip, ToyyibPay, Billplz, Anthropic, OpenAI, Google |
| [`create-actuate`](packages/create-actuate) | `npm create actuate` |

## How the step engine works

`run` is replayed from the top after every pause. Each `ctx.step.do(name, fn)` is journaled in the actuator's SQLite database (`_actuate_steps`): a completed step returns its stored result without calling `fn` again. `sleep`, `waitForEvent` and `waitForApproval` write a waiting row, set a Durable Object alarm and end the invocation; when the alarm fires or the event arrives, `run` replays and continues past the line where it stopped.

Because of replay, anything with a side effect (network, provider calls, writes, `Date.now()`) belongs inside `ctx.step.do`. Provider calls outside a step throw at runtime, and `actuate check` flags the rest before you deploy.

## Development

```bash
pnpm install
pnpm check     # build, typecheck, and test (unit tests on node:sqlite, e2e on workerd via Miniflare)
```

## License

Apache-2.0
