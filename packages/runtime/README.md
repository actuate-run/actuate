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

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
