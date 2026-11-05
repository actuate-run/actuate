# @actuate/runtime

The Actuate step engine: journaled steps, replay, sleeps on Durable Object alarms, events, and signed approval and input links. It runs an actuator as a Worker plus a SQLite-backed Durable Object, on Cloudflare or plain `workerd`, with no Actuate account. `actuate dev` runs the same engine.

```ts
// worker.ts
import { createRuntime } from "@actuate/runtime/worker";
import actuator from "./actuator";

const runtime = createRuntime(actuator);
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
```

Bind `ActuatorObject` as a SQLite-backed Durable Object named `ACTUATOR`, set `ACTUATE_TOKEN`, `ACTUATE_WEBHOOK_SECRET` and `ACTUATE_PUBLIC_URL`, and deploy with `wrangler deploy`. Give your agent `ACTUATE_RUN_TOKEN` (start and read runs only), never `ACTUATE_TOKEN`, which can approve. The runtime serves an HTTP API for runs, events, approvals and tables. Guide: [Self-hosting](https://actuate.run/docs/guides/self-hosting/) · [Runtime HTTP API](https://actuate.run/docs/reference/runtime-http/).

`ctx.notifyOwner` messages go to `createRuntime(actuator, { notifyOwner: (env) => notifier })`, an `OwnerNotifier` you write (email, chat); without one they are written to the run's log. `actuate dev` prints them (`consoleOwnerNotifier`). Hosts that call `executePass` themselves pass it as `owner`.

Config fields marked with `secret()` (JSON Schema `"writeOnly": true`) never show in what the runtime serves: each value becomes `[secret]` in logs, errors, run records and step outputs, while replays still get the real value. Hosts that build their own `RunManager` pass `secrets: () => collectSecrets(configJsonSchema, config)`; `redactSecrets`, `secretFields`, `secretPaths` and `omitSecrets` work on plain JSON Schema too. Limits: reads are redacted with the secrets configured now, so output stored before a key rotation shows the old key; `/tables` (the actuator's own data) is not redacted; booleans, values under 6 characters and encodings other than JSON escaping and URL/form encoding (base64, say) are not caught.

For tests and Node hosts, `nodeSqlite` runs the engine on `node:sqlite`, and `meteredNodeSqlite` adds an estimate of the rows read and written that Durable Objects would bill. `checkActuatorSql` refuses the SQL the hosted platform refuses (recursive queries, PRAGMA, ATTACH, generator functions). To test an actuator, use `@actuate/cli/testing`, which builds on them.

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
