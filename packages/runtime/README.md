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

`ctx.notifyOwner` messages go to `createRuntime(actuator, { notifyOwner: (env) => notifier })`, an `OwnerNotifier` you write (email, chat); without one they are written to the run's log as info lines and the call resolves to `{ sent: false }`. `actuate dev` prints them (`consoleOwnerNotifier`). Hosts that call `executePass` themselves pass it as `owner`. Approvals and questions with `notify: "owner"` send their signed links to the same notifier (keyed `approval:<runId>:<step>`), or print them to the worker's console when there is none; when they don't go out, the run's log says why in a warning, and the step waits all the same. Other `notify` values go to the messaging provider with `approval` set in the send options (an `ApprovalPrompt`), so a provider such as the custom webhook can render a card; actuator code's own sends never carry it.

`notify: { to, channel }` sends through that messaging channel (`MessagingSendOptions.channel`); a channel that isn't configured is logged on the run as a delivery error, and the step waits all the same.

Approve and Reject buttons: an approval that notifies someone gets a random single-use button nonce, stored in `_actuate_approval_buttons` and handed only to the messaging send, as `approval.buttons` (`{ route: "local", nonce }`). It never reaches the run's logs, step outputs or anything a run token reads. Chat providers that take clicks receive them on `POST /providers/<kind>/webhook`; wire them with `providerInteractions`:

```ts
import { parseProviderWebhookFromEnv, providerInteractionsFromEnv, providersFromEnv } from "@actuate/providers";

const runtime = createRuntime(actuator, {
  providers: (env, publicUrl) => providersFromEnv(env, publicUrl),
  providerWebhook: (kind, request, env) => parseProviderWebhookFromEnv(env, kind, request),
  providerInteractions: (kind, env) => providerInteractionsFromEnv(env, kind),
});
```

Each POST goes to the provider's `parseInteraction` first. A reply it needs (a Discord PING) goes back as is; a verified click is checked for the route `"local"` ("This button belongs to another actuator" otherwise) and against the provider's `approvers` list, then decided with `RunManager.decideByButton`. A nonce decides only through the provider that delivered it: after a successful send the worker records the receipt's provider with `bindButtonKind`, and a click through any other provider, or on a nonce whose send failed, is "expired or already decided". `decideByButton` completes the wait and sets the run due without waiting for the pass, so the reply fits the provider's 3-second deadline; the alarm resumes the run, which sees `{ approved, at, by: "<kind>:<user id> (<name>)", via: "chat" }`. The provider's reply goes back at once and its follow-up (editing the message) runs in `waitUntil`. Anything else falls through to `providerWebhook`. The approver list restricts buttons only: the signed links stay in every message and still work for whoever holds them. Hosts that build their own `RunManager` pass `buttonRoute` (1 to 24 characters of `[A-Za-z0-9_-]`, or set later with `setButtonRoute`) to get nonces, call `bindButtonKind(nonce, buttonKindOfChannel(receipt.channel))` once the notifier's send succeeds, label the clicker with `chatApproverLabel(kind, actor)` and pass the clicking provider's kind: `decideByButton(nonce, action, { by, kind })`, whose `decided` and `already` results name the `runId` and `step` (`clickOutcome` drops them for the provider's reply). `pruneRuns` drops a run's nonces with it, and expired ones.

`POST /run` without an `Idempotency-Key` header gets a run key derived from the actuator's `idempotencyKey` fields: a repeated call with the same values returns the first run while it runs or waits, or for 24 hours after it completes; a failed or cancelled run never blocks a new one. Webhooks and cron never get one. Hosts that build their own `RunManager` compute it with `deriveInputKey(actuator.idempotencyKey, rawInput)` and pass it to `start` as `inputKey`; `mcpToolEntry(metadata)` builds the MCP `tools/list` entry the hosted platform serves.

Config fields marked with `secret()` (JSON Schema `"writeOnly": true`) never show in what the runtime serves: each value becomes `[secret]` in logs, errors, run records and step outputs, while replays still get the real value. Hosts that build their own `RunManager` pass `secrets: () => collectSecrets(configJsonSchema, config)`; `redactSecrets`, `secretFields`, `secretPaths` and `omitSecrets` work on plain JSON Schema too. Limits: reads are redacted with the secrets configured now, so output stored before a key rotation shows the old key; `/tables` (the actuator's own data) is not redacted; booleans, values under 6 characters and encodings other than JSON escaping and URL/form encoding (base64, say) are not caught.

For tests and Node hosts, `nodeSqlite` runs the engine on `node:sqlite`, and `meteredNodeSqlite` adds an estimate of the rows read and written that Durable Objects would bill. `checkActuatorSql` refuses the SQL the hosted platform refuses (recursive queries, PRAGMA, ATTACH, generator functions). To test an actuator, use `@actuate/cli/testing`, which builds on them.

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
