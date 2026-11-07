# @actuate/providers

## 0.5.0

### Minor Changes

- 9b569d3: Approve and Reject buttons in Telegram, Slack and Discord, approvals decided by a custom webhook's receiver, and the runtime and provider contract they run on.

  - **sdk:** `ApprovalPrompt.buttons?: { route, nonce }` is set on approval notifications (never questions) when the runtime made a button nonce, for providers that render buttons. `ApprovalResult.via` gains `"chat"`, with a verified `by`: `<channel>:<user id>`, plus ` (<display name>)` when the provider gives one (the ID is checked by the provider's signature, the name is whatever the person set). New types for provider adapters and runtimes: `ProviderReply`, `ButtonActor`, `ButtonClick`, `ClickOutcome` and `ProviderInteractions`.
  - **sdk:** `notify` on `waitForApproval` and `waitForInput` also takes `{ to, channel }` (new `Notify` type), which sends through that messaging channel when several are configured. `"owner"` stays a reserved string, and `{ to: "owner" }` is refused, like any malformed `notify`: the call throws. A named channel that isn't configured always fails delivery, even when only one provider is configured: it is logged on the run as a delivery error, and the step still waits. **Behaviour change:** the same goes for `ctx.messaging.send(to, text, { channel })`, which used to send through the only configured provider whatever `channel` said, and now rejects, so a recipient meant for one channel never goes out through another.
  - **providers:** `ProviderDefinition` gains the optional `parseInteraction`, `isApprover`, `respondInteraction` and `routeHint` for chat providers that take button clicks; a provider takes clicks only with the first three. The contract has the one implementation of the button payload, `encodeButtonPayload` / `parseButtonPayload` (`ap1:<route>:<nonce>:<a|r>`, strict, at most 47 bytes, within Telegram's 64), and shared helpers: `parseApprovers` / `isListedApprover` / `formatApprovers` / `approversCredentialField` for an `approvers` credential (IDs separated by spaces or commas, `role:<id>` where the provider has roles, at most 100 entries, `MAX_APPROVERS`), `clickOutcomeText` (a click on a step decided in the dashboard, through the API or with a link reads "Already approved in the dashboard" and the like, never naming who decided), `withoutLinkLines` and `decidedMessageText` for what the clicker sees, and `jsonReply` / `textReply`. `providerInteractions(definition, credentials)` and `providerInteractionsFromEnv(env, kind)` bind a provider's click handling for a runtime. An approver list restricts buttons only: the signed links stay in every message and still work for whoever holds them.
  - **runtime:** a new `_actuate_approval_buttons` table (existing databases get it the first time a `RunManager` opens them) holds one random 96-bit nonce per approval that notifies someone (not `notify: "owner"`), and the kind of the messaging provider that delivered it, when `RunManagerOptions.buttonRoute` is set (`"local"` self-hosted, `LOCAL_BUTTON_ROUTE`). The nonce goes to the notifier as `ApprovalRequest.buttons` and nowhere else: not in run logs (a notifier error that quotes it has it replaced by `[nonce]`), step outputs, receipts or anything a run token reads, and actuator code can neither send `approval` (the runtime drops it) nor read the table. `ApprovalRequest.channel` carries `notify`'s channel. `pruneRuns` removes a run's nonces with it, and expired ones.
  - **runtime:** new `RunManager.bindButtonKind(nonce, kind)`: once the notifier's send succeeds, it records which provider delivered the buttons (`buttonKindOfChannel(receipt.channel)`; the self-hosted worker does this), once per nonce. New `RunManager.decideByButton(nonce, action, { by, kind })`: synchronous, it checks that `kind` (the provider that verified the click) is the one the nonce was bound to, so a nonce from a channel with a strict approver list can't be replayed through another (a custom webhook's Reply URL, say) and an unbound nonce decides nothing; then the nonce, its expiry and that the step still waits, marks the nonce used and completes the wait (`{ approved, at, by, via: "chat" }`), then sets the run due and calls `scheduleWake`, so the pass runs from the alarm and never delays the provider's reply. It returns `decided`, `already` (a second or racing click, or a step decided by a link, the dashboard or the API, with that decision and its `via`, and `by` only for a chat decision), both with the `runId` and `step`, `expired` or `unknown` (also for another provider's click). `RunManager.setButtonRoute(route)` sets or changes the route after construction, validated like the option. New `chatApproverLabel`, `clickOutcome`, `buttonKindOfChannel`, `isButtonKind`, `newButtonNonce`, `isButtonRoute`, `isButtonNonce`, `notifyTarget` and the `ButtonDecision` type.
  - **runtime:** `createRuntime` takes `providerInteractions: (kind, env) => ProviderInteractions | null`. `POST /providers/:kind/webhook` asks the provider's `parseInteraction` first: a reply goes back verbatim; a click is checked for the `"local"` route and the approver list, decided, answered with `respondInteraction`, and its follow-up runs in `waitUntil` (if `respondInteraction` throws once the click is decided, the answer is an empty 200 and the decision stands); anything else falls through to `providerWebhook`, whose `{ reply }` may now be a `ProviderReply` (status, content type, body) as well as a string.
  - **providers:** the custom webhook's receiver can decide approvals. With a signing secret, an approval's standard body gains `approval.decide: { approve, reject, url }` (two `ap1:` payloads and the Reply URL), and templates gain `{{approvePayload}}` / `{{rejectPayload}}` (empty otherwise); the links stay. The receiver POSTs `{ "decision": "<payload>", "by": { "id", "name"? } }` to the Reply URL with the reply auth (Bearer secret or Standard Webhooks signature), and gets JSON back: `{ status, decision?, by?, at?, message }` (`decided`, `already`, `expired`, `unknown`, `not-approver`, `foreign`; `by` only for a chat decision), or 400 `{ "status": "invalid", message }` for a bad payload or `by` (`id` 1-64 characters, no spaces or commas; `name` at most 60, so `ApprovalResult.by` holds both uncut). The run resumes with `via: "chat"` and `by: "custom-webhook:<id> (<name>)"`. `by` is asserted by the receiver: Actuate verifies the secret, not the person. New optional credential `approvers` (`CUSTOM_WEBHOOK_APPROVERS`): the `by.id` values allowed to decide this way. A body without `decision` is still an ordinary reply.
  - **providers:** Telegram approval buttons. With `webhookSecretToken` and a button nonce, approvals get Approve and Reject callback buttons; otherwise URL buttons to the confirm pages (only for `http(s)` links on a public host, so not under `actuate dev` on `localhost`), and questions get an Answer URL button. The text keeps its links. Clicks arrive on the bot's webhook, checked against `X-Telegram-Bot-Api-Secret-Token` (401 otherwise), and are answered in the webhook response with `answerCallbackQuery`; a deciding click then edits the message with `editMessageText` (links and buttons removed, "Approved by … at 14:02 UTC"). Other callback queries get a bare `answerCallbackQuery`. New optional credential `approvers` (`TELEGRAM_APPROVERS`): numeric user IDs. `webhookSecretToken` is now checked against Telegram's rule (1-256 characters of `A-Z a-z 0-9 _ -`). Self-hosted, register the webhook at the actuator's `/providers/telegram/webhook` with `secret_token` and `allowed_updates=["message","callback_query"]`.
  - **providers:** Slack approval buttons. Approvals and questions go out as Block Kit, with `text` (links included) as the fallback. With the new optional `signingSecret` (`SLACK_SIGNING_SECRET`) and a button nonce, Approve and Reject are interactive; otherwise they are URL buttons to the confirm pages, and questions get an Answer URL button. Clicks are verified by `X-Slack-Signature` (v0 HMAC-SHA256, 5-minute window, 401 otherwise) and answered with an empty 200; a follow-up to the click's `response_url` then replaces the message for a decision (links and buttons removed) or posts an ephemeral note to the clicker. If Slack refuses the blocks (`invalid_blocks`, `invalid_blocks_format` or `msg_blocks_too_long`), the text goes alone, once. New optional credential `approvers` (`SLACK_APPROVERS`): member IDs. Self-hosted, set the app's Interactivity Request URL to the actuator's `/providers/slack/webhook`.
  - **providers:** Discord approval buttons. With a bot token and the new optional `publicKey` (`DISCORD_PUBLIC_KEY`, the application's public key), approvals get interactive Approve and Reject buttons; otherwise (no public key, or a channel webhook) link buttons to the confirm pages when every link is at most 512 characters, else text only, and questions get an Answer link button under the same rule. Interactions are verified by Ed25519 `X-Signature-Ed25519` (WebCrypto, 5-minute window, 401 otherwise), a PING gets its PONG, and a click is answered with type 7 (`UPDATE_MESSAGE`, links and buttons removed) for a decision or an ephemeral type 4 otherwise; other interactions of the application get a polite ephemeral reply. New optional credential `approvers` (`DISCORD_APPROVERS`): user IDs and `role:<id>` entries. Self-hosted, set the application's Interactions Endpoint URL to the actuator's `/providers/discord/webhook`.
  - **providers:** `parseProviderWebhookFromEnv` returns null (so `{ ignored: true }`) for a configured provider that takes no webhooks of its own, such as Slack and Discord, instead of a 401; a provider that isn't configured is still a 401.
  - **cli:** `actuate dev` wires `providerInteractionsFromEnv`, so a chat provider configured in `.dev.vars` takes button clicks on its webhook.

- a1790d9: New messaging channel: custom webhook. Send messages to any URL: your own server, Zapier, n8n, ntfy, Google Chat…

  - **providers:** new `custom-webhook` messaging provider (`ACTUATE_MESSAGING=custom-webhook`, `CUSTOM_WEBHOOK_URL`, and optional `CUSTOM_WEBHOOK_SECRET`, `CUSTOM_WEBHOOK_HEADERS`, `CUSTOM_WEBHOOK_FORMAT`, `CUSTOM_WEBHOOK_TEMPLATE`). Actuate POSTs each message to your URL; to reply, POST to the reply URL it gave you. Pick it with `send(to, text, { channel: "custom-webhook" })`. The body is `standard` JSON (`id`, `to`, `text`, `html`, `subject`, `replyUrl`), `text` (plain text with a `Title` header, for ntfy) or your own JSON `template` with `{{text}}`-style placeholders. With a signing secret (`whsec_...`) each message is signed the Standard Webhooks way (`webhook-id`, `webhook-timestamp`, `webhook-signature`), and replies posted to `/providers/custom-webhook/webhook` with `Authorization: Bearer <secret>` or a valid signature arrive as `message.custom-webhook.<from>` events. The message `id` comes from the idempotency key, so a retried step sends the same `id` and the receiver can drop the duplicate. Redirects are not followed, requests time out after 10 seconds, and errors never include the URL, the secret or header values.
  - **providers:** new `signStandardWebhook(secret, id, timestamp, body)` and `verifyStandardWebhook(secret, headers, body)` (WebCrypto only, so they run in Workers).
  - **providers:** `credentialFields` entries can declare `multiline: true` (a textarea), `options` (a select; leaving it empty picks the provider's default) and `generate: "whsec"` (a "Generate" button for a Standard Webhooks secret), so a form can render them generically. Existing providers are unchanged.
  - **sdk:** the `MessagingSendOptions.channel`, `idempotencyKey` and `InboundMessage.from` docs mention the custom webhook channel.

- 42d5134: Run keys derived from input fields, approval links for the owner, approval cards for custom webhooks, and the MCP tool entry in `actuate deploy --dry-run`.

  - **sdk:** new `idempotencyKey: readonly string[]` on `defineActuator`: the input fields that say which request a call is, e.g. `["orderId"]`. A call over MCP or the run API that sends no idempotency key of its own gets one derived from those fields' values, so a retried tool call returns the first call's run instead of starting a second one. It matches a run with the same values that is still running or waiting, or that completed in the last 24 hours; a failed or cancelled run never matches, so the call can be tried again. A key the caller sends (MCP `_meta["run.actuate/idempotencyKey"]`, the `Idempotency-Key` header) takes its place and works exactly as before: send a new one to force a new run. Cron runs and webhooks never get a derived key. The key is computed from the input as sent, before zod's defaults, coercion and transforms, so `"A-1"` and `"a-1"` are different orders. `defineActuator` throws when a name is not a top-level field of the input schema, when the field is not a string, number, integer or boolean (an enum or literal of those is fine), and for an empty or repeated list. Declaring it also marks the MCP tool idempotent (`idempotentHint: true`) unless `hints.idempotent` is `false`.
  - **sdk:** `notify: "owner"` on `waitForApproval` and `waitForInput` sends the signed links to the actuator's owner, the way `ctx.notifyOwner` reaches them, with no messaging provider needed. On the hosted platform that is the account email, and the alert channel when it is Telegram, Slack, Discord or email (never a custom webhook, which may be another agent); self-hosted, the `notifyOwner` notifier given to `createRuntime`, else the worker's console; under `actuate dev`, the terminal. When the links can't go out (a daily cap reached) the step still waits, the request is in the approval queue, and the run's log gets a `warn` line. **"owner" is now a reserved `notify` value:** it is no longer passed to the messaging provider, so a messaging recipient (a custom-webhook recipient string, say) literally named "owner" can't be used for approvals any more. New `NOTIFY_OWNER` constant.
  - **runtime:** new `deriveInputKey(fields, input)` (`input:<SHA-256 hex>` of the canonical JSON array of the fields' values, in declared order; no key when the input lacks one of the fields), `inputKeyMaterial`, `triggerDerivesInputKey(triggerKind)`, `INPUT_KEY_PREFIX` and `INPUT_KEY_COMPLETED_TTL_MS`. `RunManager.start` takes `inputKey`, stored in a new `_actuate_runs.input_key` column with its own unique index and matched as described above, checked after `idempotencyKey` (both may be given). Existing databases get the column and index the first time a `RunManager` opens them. The self-hosted worker derives the key on `POST /run` when the request has no `Idempotency-Key` (or `X-GitHub-Delivery`); `/webhook` and cron never do.
  - **runtime:** `RunManagerOptions.notifyApproval` may resolve to `{ sent: false, reason }`, which is logged on the run as a `warn` line (never the links themselves). The self-hosted worker sends `notify: "owner"` requests to its `notifyOwner` notifier, keyed `approval:<runId>:<step>`, the message cut short when needed so the links always fit.
  - **sdk:** new `MessagingSendOptions.approval?: ApprovalPrompt` (`kind: "approval" | "input"`, `actuator`, `step`, `message?`, `approveUrl?`, `rejectUrl?`, `answerUrl?`, `expiresAt` in epoch ms). Only Actuate's approval and input notifications set it, so a provider can render the request (a card with link buttons); providers that don't know it ignore it, and the text still carries the links. The runtime removes it from sends made through `ctx.messaging`, so actuator code can't fake an approval card.
  - **runtime:** the self-hosted worker's approval and input notifications set `approval` on the messaging send. A waitForInput notification's subject is now "Input needed: <actuator>".
  - **providers:** the custom webhook's `standard` body carries an `approval` object on approval and input requests (`kind`, `actuator`, `step`, `message`, `approveUrl` and `rejectUrl` or `answerUrl`, and `expiresAt` in ISO 8601); `text` keeps the links. New template placeholders `{{approveUrl}}`, `{{rejectUrl}}`, `{{answerUrl}}` and `{{expiresAt}}` (empty on ordinary messages), and a new optional credential field `approvalTemplate` ("Approval JSON template", `CUSTOM_WEBHOOK_APPROVAL_TEMPLATE`), validated like the JSON template and used for approval requests only; questions (`waitForInput`) use the body format, whose `approval` object (standard) or `{{answerUrl}}` (template) carries the answer link. The README has presets for a Microsoft Teams Adaptive Card and a Google Chat card with Approve and Reject link buttons, which open Actuate's confirm page. Test the Google Chat one in your space first: Google doesn't document `cardsV2` for incoming webhooks.
  - **runtime:** new `mcpToolEntry(metadata)`: an actuator's MCP `tools/list` entry (name, title, description, input and output schemas, explicit annotations), as the hosted platform serves it.
  - **cli:** `actuate deploy --dry-run` prints the MCP tool entry agents will see after the metadata (`mcpTool` in `--json`). The deploy metadata includes `idempotencyKey` when one is declared.
  - **cli:** new deploy check `idempotency-key`: every `idempotencyKey` field must be required in the input schema (not optional, no default), top-level, and a string, number, integer or boolean. The `cron-input` warning now also says when an actuator with cron declares `idempotencyKey`, since cron runs never use it.
  - **cli:** `testActuator().start()` derives the run key the same way for "api" (the default) and "mcp" runs started without an `idempotencyKey`.

### Patch Changes

- Updated dependencies [9b569d3]
- Updated dependencies [a1790d9]
- Updated dependencies [42d5134]
  - @actuate/sdk@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [bb8c52d]
  - @actuate/sdk@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [ebf7434]
  - @actuate/sdk@0.4.0

## 0.3.0

### Minor Changes

- b9ea870: Default idempotency keys for provider calls, and atomic database writes.

  - **runtime:** inside `ctx.step.do`, `ctx.messaging.send`, `ctx.payment.createBill` and `ctx.payment.refund` now get an idempotency key when you pass none, as `MessagingSendOptions.idempotencyKey` always documented. Each call gets its own key, `<runId>:<step>:<method>:<n>`, where `n` counts that method's calls in this attempt of the step from 0, so two sends in one step are not deduplicated against each other, and a retried step sends the same key for the same call. A key you pass is used as is. Keys are at most 255 characters. This works the same self-hosted and on the hosted platform, because the runtime adds the key before the call reaches the provider. **Behaviour change:** a retried step whose earlier attempt reached Stripe or Resend now gets the first attempt's result instead of a second checkout session, refund or email. If the retry sends different parameters with the same key, Stripe and Resend reject it. Keys expire after 24 hours at both, so a retry after a longer backoff is not deduplicated.
  - **providers:** Stripe sends the key as `Idempotency-Key` on `createBill` and `refund` (as before). Resend sends it as `Idempotency-Key`. Discord bot-token sends now pass a nonce derived from it with `enforce_nonce`, so Discord drops duplicates within a few minutes. A key too long for an API is shortened with a hash, never cut off, so keys that differ only at the end stay distinct. Telegram, WhatsApp, Slack, Discord webhooks, CHIP, ToyyibPay and Billplz document no idempotency key, so those adapters do not use it: a retried call can repeat there. The dev payment provider (`actuate dev`) now returns the same bill for a repeated key, as Stripe does.
  - **sdk, runtime:** `ctx.db.batch([...statements])` runs several parameterised statements in one transaction, all or nothing (`transactionSync` on a Durable Object), and resolves to each statement's rows. If one fails, none is applied, and the error says which one failed. Build statements with `` ctx.db.statement`...${value}` `` or `{ sql, params }`. Statements that control a transaction (`BEGIN`, `COMMIT`, `SAVEPOINT`, ...) and tables starting with `_actuate_` are refused.
  - **sdk, runtime:** `ctx.db.commitWithStep([...statements])`, inside `ctx.step.do`, queues writes to apply in the same transaction that records the step as completed. A failed or retried attempt applies none of them, and a completed step never applies them again, even when the run is replayed. Use it for writes that must happen exactly once with the step's result. The step can't read the writes or their rows; use `ctx.db.batch` when it needs them.
  - **runtime:** `Journal` has two new optional methods, `batch` and `commitStep`. A host whose journal lacks them (for example, a hosted platform still on 0.2) rejects `ctx.db.batch` and `commitWithStep` with an error instead of applying writes partly.

### Patch Changes

- Updated dependencies [b9ea870]
  - @actuate/sdk@0.3.0

## 0.2.0

### Patch Changes

- e06474e: Security hardening.

  - **runtime:** new `ACTUATE_RUN_TOKEN` for agents. It can describe the actuator, start runs (`POST /run`) and read a run (`GET /runs/:runId`), and nothing else: it can't approve, answer an input step, fetch approval links, post events, cancel or read tables. `ACTUATE_TOKEN` stays the owner's token for every route. Give your agent the run token, so the agent a run is gated against can't approve itself.
  - **runtime:** under `actuate dev`, routes left open because their secret is unset (the admin API and `/webhook`) now answer only requests to `localhost`, and refuse cross-site and cross-origin requests from browsers (`403`). A web page the developer has open can no longer start runs with the real providers in `.dev.vars`, fake payments through `GET /events`, or read data through DNS rebinding. Requests through a tunnel reach the public routes (`/approve`, `/providers/:kind/webhook`) as before; set `ACTUATE_TOKEN` to use the admin API through one.
  - **runtime:** `GET /events/:key` is accepted only under `actuate dev`; use `POST` elsewhere.
  - **runtime:** without `ACTUATE_PUBLIC_URL`, the origin for approval links and provider callbacks is learned only from a request made with `ACTUATE_TOKEN` (under `actuate dev`, from a request to localhost), not from whoever calls first. Set `ACTUATE_PUBLIC_URL` in production.
  - **runtime:** the approval page is sent with `Cache-Control: no-store`, `X-Frame-Options: DENY` and a restrictive Content-Security-Policy.
  - **providers:** Stripe payment events take their reference only from the `actuate_reference_id` metadata that `createBill` sets, not from `client_reference_id`, which buyers can set themselves on Payment Links and pricing tables.
  - **cli:** `actuate login` creates the credentials file as `0600` (and its folder as `0700`) from the start.
  - **cli:** `actuate login` points at the dashboard's new origin, `https://app.actuate.run/settings/tokens`.
  - **create-actuate:** `--ref` must be a plain git ref.

- Updated dependencies [e06474e]
  - @actuate/sdk@0.2.0

## 0.1.2

### Patch Changes

- @actuate/sdk@0.1.2

## 0.1.1

### Patch Changes

- First release published from GitHub Actions, with npm provenance. No code changes since 0.1.0.
- Updated dependencies
  - @actuate/sdk@0.1.1

## 0.1.0

### Minor Changes

- 62a1af6: First public release: the actuator SDK, the durable step engine for workerd, provider adapters, the `actuate` CLI and `npm create actuate`.

### Patch Changes

- Updated dependencies [62a1af6]
  - @actuate/sdk@0.1.0
