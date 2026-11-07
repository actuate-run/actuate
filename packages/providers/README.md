# @actuate/providers

Bring-your-own-credentials adapters behind `ctx.messaging`, `ctx.payment` and `ctx.llm`. The hosted platform and `actuate dev` use the same code.

| Capability | Providers |
| --- | --- |
| messaging | Telegram, WhatsApp Cloud API, Slack, Discord, Resend (email), Custom webhook (any URL). Several at once, picked with `send(..., { channel })`; WhatsApp, Telegram and custom webhook replies arrive as events |
| payment | Stripe, Chip, ToyyibPay, Billplz. Payment webhooks are verified and arrive as `payment.<referenceId>` events |
| llm | Anthropic, OpenAI, Google, or any OpenAI-compatible API (OpenRouter, Groq, DeepSeek, Ollama, ...) |

Self-hosted or under `actuate dev`, configure them with environment variables:

```ts
import { parseProviderWebhookFromEnv, providersFromEnv } from "@actuate/providers";

// ACTUATE_MESSAGING=whatsapp,slack  WHATSAPP_ACCESS_TOKEN=...  SLACK_WEBHOOK_URL=...
// ACTUATE_PAYMENT=billplz  BILLPLZ_API_KEY=...  ACTUATE_LLM=anthropic  ANTHROPIC_API_KEY=...
const providers = providersFromEnv(env, "https://bot.example.com");
```

`npx actuate providers` lists every provider and its variables. Adding one? Implement the contract in [`src/contract.ts`](https://github.com/actuate-run/actuate/blob/main/packages/providers/src/contract.ts) and see [CONTRIBUTING.md](https://github.com/actuate-run/actuate/blob/main/CONTRIBUTING.md). Guide: [Capabilities and providers](https://actuate.run/docs/concepts/capabilities/).

## Custom webhook

Send messages to any URL: your own server, Zapier, n8n, ntfy, Google Chat… Actuate POSTs each message to your URL; to reply, POST to the reply URL it gave you.

```ts
// ACTUATE_MESSAGING=custom-webhook  CUSTOM_WEBHOOK_URL=https://example.com/hook  CUSTOM_WEBHOOK_SECRET=whsec_...
await ctx.messaging.send("me", "Approve the refund?", { channel: "custom-webhook" });
const reply = await ctx.step.waitForEvent("reply", { event: "message.custom-webhook.me", timeout: "1 day" });
```

| Variable | |
| --- | --- |
| `CUSTOM_WEBHOOK_URL` | Required. `https://` (plain `http://` only for `localhost`, `127.0.0.1`, `[::1]`); no IP addresses or `user:pass@`. Treated as a secret. |
| `CUSTOM_WEBHOOK_SECRET` | Optional signing secret, `whsec_` + base64 of 24 to 64 bytes (`whsec_$(openssl rand -base64 32)`). Signs each message ([Standard Webhooks](https://www.standardwebhooks.com/): `webhook-id`, `webhook-timestamp`, `webhook-signature`) and turns on replies. |
| `CUSTOM_WEBHOOK_HEADERS` | Optional extra headers, one `Name: value` per line (at most 20), e.g. `Authorization: Bearer ...`, `X-Gotify-Key: ...`. `Host`, `Content-Length`, `Transfer-Encoding`, `Connection` and `webhook-*` are refused. |
| `CUSTOM_WEBHOOK_FORMAT` | `standard`, `text` or `template`. Leave empty for automatic: `template` when a JSON template is set, otherwise `standard`. |
| `CUSTOM_WEBHOOK_TEMPLATE` | JSON for the `template` format, with `{{text}}`, `{{html}}`, `{{subject}}`, `{{to}}`, `{{id}}`, `{{replyUrl}}` inside JSON strings (and the approval placeholders below, empty on ordinary messages). |
| `CUSTOM_WEBHOOK_APPROVAL_TEMPLATE` | Optional JSON used instead, whatever the format, for approval requests only (`waitForApproval` with `notify`): the same placeholders plus `{{approveUrl}}`, `{{rejectUrl}}` and `{{expiresAt}}` (ISO 8601). It must use at least one of `{{approveUrl}}`, `{{rejectUrl}}` or `{{text}}` (the text holds the links), so the links always reach the receiver. Questions (`waitForInput`) use the body format, where `{{answerUrl}}` and the standard body's `approval.answerUrl` carry the answer link. Without it, approvals use the body format too. Approval templates and JSON templates also take `{{approvePayload}}` and `{{rejectPayload}}` (see "Deciding from the receiver"; empty without a signing secret). |
| `CUSTOM_WEBHOOK_APPROVERS` | Optional. The `by.id` values allowed to decide from the receiver (see below), separated by spaces or commas; up to 64 characters each, no spaces or commas. Empty: any `by.id` your receiver sends. Restricts decisions posted to the Reply URL only: the signed links still work for whoever holds them. |

Body formats:

- `standard`: `{ "id", "to", "text", "html"?, "subject"?, "replyUrl"? }` as JSON. `text` is always plain text; `html` is the original when sent with `format: "html"`. `replyUrl` is there only with a signing secret.
- `text`: the plain text as `text/plain`, with the subject as a `Title` header (ntfy).
- `template`: your JSON with the placeholders filled in, JSON-escaped. Google Chat, Mattermost and Rocket.Chat take `{"text":"{{text}}"}`; Gotify `{"title":"{{subject}}","message":"{{text}}"}`; Apprise `{"title":"{{subject}}","body":"{{text}}"}`.

Approval and input requests carry an `approval` object in the `standard` body: `{ "kind": "approval" | "input", "actuator", "step", "message"?, "approveUrl", "rejectUrl" }` (or `"answerUrl"` for input), `"expiresAt"` in ISO 8601, and with a signing secret, on approvals, `"decide": { "approve", "reject", "url" }` (below). `text` still holds the message and the links. Only Actuate's approval notifications set it: the runtime drops `approval` from sends made by actuator code. The links open Actuate's confirm page, where the decision is made (opening a link decides nothing, so link previews are harmless). Send approvals only to a receiver that shows them to a person: a link is all it takes to decide.

Approval templates for chat apps whose incoming webhooks show cards with link buttons:

Microsoft Teams (Workflows, "When a Teams webhook request is received"; Office 365 connectors are retired), an Adaptive Card with `Action.OpenUrl` buttons (the workflow's schema requires `"contentUrl": null` on the attachment):

<!-- preset: teams -->
```json
{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","contentUrl":null,"content":{"$schema":"http://adaptivecards.io/schemas/adaptive-card.json","type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"{{subject}}","weight":"Bolder","wrap":true},{"type":"TextBlock","text":"{{text}}","wrap":true},{"type":"TextBlock","text":"Links expire {{expiresAt}}","isSubtle":true,"size":"Small","wrap":true}],"actions":[{"type":"Action.OpenUrl","title":"Approve","url":"{{approveUrl}}"},{"type":"Action.OpenUrl","title":"Reject","url":"{{rejectUrl}}"}]}}]}
```

Google Chat, a `cardsV2` card with link buttons. Test it in your space first: Google's documentation doesn't say that incoming webhooks accept `cardsV2` (they are known to work, and other tools send them, but it isn't promised). If the space shows nothing, use `{"text":"{{text}}"}`, which carries the same links.

<!-- preset: googlechat -->
```json
{"text":"{{subject}}","cardsV2":[{"cardId":"approval","card":{"header":{"title":"{{subject}}","subtitle":"Links expire {{expiresAt}}"},"sections":[{"widgets":[{"textParagraph":{"text":"{{text}}"}},{"buttonList":{"buttons":[{"text":"Approve","onClick":{"openLink":{"url":"{{approveUrl}}"}}},{"text":"Reject","onClick":{"openLink":{"url":"{{rejectUrl}}"}}}]}}]}]}}]}
```

The approval template is used for approval requests only, so these cards never show empty buttons. Questions (`waitForInput` with `notify`) go out in the body format, with the answer link in the text (and in `{{answerUrl}}`).

`id` (also the `webhook-id` header) comes from the step's idempotency key, so a retried step sends the same `id` and the receiver can drop the duplicate. A JSON reply with a string `id` becomes the receipt's `id`. Redirects are not followed, requests time out after 10 s, and at most 64 KB of the response is read.

Replies are a POST to the reply URL (`/providers/custom-webhook/webhook`) with JSON `{ "from": "me", "text": "yes" }` (also `id`, `at` in ms, `name`, `type`), authorized by `Authorization: Bearer <secret>` or a Standard Webhooks signature made with the secret (never `?secret=`: a secret in the URL ends up in logs). Each becomes the event `message.custom-webhook.<from>`; a reply without `from` is ignored (`{"ignored": true}`). Known limitation: Actuate does not deduplicate a signed reply replayed within its 5-minute window.

```sh
curl -X POST "$REPLY_URL" -H "Authorization: Bearer $CUSTOM_WEBHOOK_SECRET" -H "content-type: application/json" -d '{"from":"me","text":"yes"}'
```

### Deciding from the receiver

With a signing secret, your receiver can decide an approval itself, say from Approve and Reject buttons in its own UI, without opening a link. The approval's `approval.decide` holds two opaque values, `approve` and `reject` (`ap1:...`, at most 47 characters; also `{{approvePayload}}` and `{{rejectPayload}}` in templates), and `url`, the Reply URL. To decide, POST one of them back to the Reply URL with the same auth as a reply (`Authorization: Bearer <secret>` or a Standard Webhooks signature, never `?secret=`), naming the person who decided:

```sh
curl -X POST "$REPLY_URL" -H "Authorization: Bearer $CUSTOM_WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"decision":"ap1:local:...:a","by":{"id":"alice","name":"Alice Tan"}}'
```

`by.id` is required (1 to 64 characters, no spaces or commas), `by.name` optional (at most 60). The answer is always JSON:

| Status | Body |
| --- | --- |
| 200 | `{ "status": "decided", "decision": "approved" \| "rejected", "by": "custom-webhook:alice (Alice Tan)", "at": "<ISO 8601>", "message": "Approved by Alice Tan at 14:02 UTC" }` |
| 200 | `{ "status": "already", "decision", "by", "at", "message": "Already approved by Alice Tan" }`: decided before by another decision. After a link, the dashboard or the API, `by` is left out and `message` reads "Already approved with a link", "Already approved in the dashboard" or "Already approved through the API" |
| 200 | `{ "status": "expired" \| "unknown", "message": "This request has expired or was already decided." }` |
| 200 | `{ "status": "not-approver", "message": "You're not on the approver list for this." }` (`by.id` isn't in `CUSTOM_WEBHOOK_APPROVERS`) |
| 200 | `{ "status": "foreign", "message": "This button belongs to another actuator." }` |
| 400 | `{ "status": "invalid", "message" }`: a `decision` that isn't one of the two values, or a missing or malformed `by` |
| 401 | Bad or missing auth |

Show `message` to the person, or use `status` and `decision` to update your own UI; the reply never holds a link or the payload. The run resumes with `{ approved, at, by: "custom-webhook:<id> (<name>)", via: "chat" }`. **`by` is what your receiver asserts:** Actuate checks the secret, so it knows the request came from your receiver, but it can't check who the person was. Only let your receiver decide for people it has authenticated itself, and keep the secret on your server. A body without `decision` is an ordinary reply. `notify: "owner"` never goes to a custom webhook, so the owner's approvals can't be decided this way.

`signStandardWebhook` and `verifyStandardWebhook` are exported for receivers written in TypeScript (WebCrypto only, so they run in Workers).

## Approval buttons

A chat provider can put Approve and Reject buttons on approval messages. When `send` gets `options.approval.buttons` (`{ route, nonce }`, set only by Actuate's own approval notifications), it puts `encodeButtonPayload({ route, nonce, action })` (`ap1:<route>:<nonce>:<a|r>`, at most 47 bytes) on its buttons; the text keeps the signed links either way. Clicks come back through four optional `ProviderDefinition` members:

| Member | |
| --- | --- |
| `parseInteraction(request, credentials, ctx?)` | Verify the request and return `{ click }` (a `ButtonClick`, from `parseButtonPayload`), `{ reply }` for a request the provider needs answered as is (a PING), or null to fall through to `parseWebhook`. Throws `WebhookVerificationError` on a bad signature. Reads the body from `request.clone()`, so `parseWebhook` still has it. |
| `isApprover(actor, credentials)` | Whether this person may decide with a button; true when no `approvers` list is configured. |
| `respondInteraction(click, outcome, credentials, ctx)` | The reply to send now, and an optional `after()` run once it is sent (editing the message). |
| `routeHint(body, contentType)` | The unverified route in a raw body, for the hosted platform's tenant-level interactions URL. |

Helpers in the contract, so every provider words and validates things the same way: `parseApprovers` (an `approvers` credential: IDs separated by spaces or commas, with `role:<id>` entries where the provider has roles, at most 100 entries, `MAX_APPROVERS`), `isListedApprover`, `formatApprovers`, `approversCredentialField`, `clickOutcomeText` ("Approved by Alice at 14:02 UTC", "Already approved by Alice" after a chat decision, "Already approved in the dashboard", "Already approved through the API" or "Already approved with a link" after any other, never naming who decided, "This request has expired or was already decided.", "You're not on the approver list for this.", "This button belongs to another actuator."), `withoutLinkLines` and `decidedMessageText` for the edited message, and `jsonReply` / `textReply`. `providerInteractions(definition, credentials)` and `providerInteractionsFromEnv(env, kind)` bind them for a runtime (`createRuntime`'s `providerInteractions`).

An `approvers` list (at most 100 entries) restricts buttons, not links: the signed links in the message still work for whoever holds them. A button decides only through the provider that sent it, so a payload copied from a Slack message can't be replayed through the custom webhook's Reply URL, whose `by` your receiver asserts.

### Telegram

| Credentials | Approval message |
| --- | --- |
| `botToken` + `webhookSecretToken` | Approve and Reject callback buttons (`callback_data` is the button payload). |
| `botToken` only | Approve and Reject URL buttons that open the confirm pages. Clicks can't be verified without the secret token, so they aren't taken. |

`waitForInput` gets an "Answer" URL button either way. The text keeps its links. URL buttons need an `http(s)` link on a public-looking host, so `actuate dev` on `localhost` sends the links as text only. If Telegram still refuses a button URL, the message goes again without buttons.

Clicks arrive on the bot's one webhook with its messages, at `/providers/telegram/webhook` when self-hosted. Register it once with your secret token and both update types:

```sh
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url="$ACTUATE_PUBLIC_URL/providers/telegram/webhook" \
  -d secret_token="$TELEGRAM_WEBHOOK_SECRET_TOKEN" \
  -d allowed_updates='["message","callback_query"]'
```

The secret token is 1-256 characters of `A-Z a-z 0-9 _ -`, checked when the credentials are read. Every update must carry it in `X-Telegram-Bot-Api-Secret-Token` (compared in constant time); a missing or wrong one gets 401. A `callback_query` with our payload is a click. Any other callback query gets a bare `answerCallbackQuery` with no text, which stops the clicker's spinner. Every other update goes on to `parseWebhook`, which never turns a callback query into a message event.

The click is answered in the webhook response (`{"method":"answerCallbackQuery","callback_query_id":…,"text":…}`, so no API call is made). A deciding click then edits the message through `editMessageText`: the link lines are removed, "Approved by Wei Tan at 14:02 UTC" is added, the buttons are removed and the text is plain. Other outcomes answer only the clicker. `TELEGRAM_APPROVERS` (optional) takes numeric user IDs (`42 43`), not chat IDs or @usernames. The clicker is recorded as `telegram:<user id> (<first last name or @username>)`; the name is whatever the user set.

### Slack

Approvals and questions go out as Block Kit: a section with the message (links included), then an actions block. `text` stays the same, links and all, as the notification fallback. This works with the incoming webhook URL or the bot token.

- **With `signingSecret`** (`SLACK_SIGNING_SECRET`): interactive **Approve** (primary) and **Reject** (danger) buttons, with action IDs `actuate_approve` and `actuate_reject` and the button payload in `value`.
- **Without it**, or with no button nonce: URL buttons that open the confirm pages.
- **Questions** (`waitForInput`) get an **Answer** URL button.
- **Limits:** a URL longer than Slack's 3000 characters gets no button, and a message longer than 3000 characters is split over several sections. If Slack still refuses the blocks (`invalid_blocks`), the text is sent alone, once.

Setup, in a Slack app used only by Actuate (an app has one Request URL):

1. Under **Basic Information**, copy the **Signing Secret** into `signingSecret`.
2. Under **Interactivity & Shortcuts**, turn interactivity on. Set the Request URL to the interactions URL (self-hosted: `https://<your actuator>/providers/slack/webhook`).
3. Optionally, set `approvers` (`SLACK_APPROVERS`): member IDs (`U…` or `W…`, from profile, ⋯, **Copy member ID**), separated by spaces or commas. Without it, anyone in the channel can click.

A click is checked before anything is decided:

- `parseInteraction` verifies `X-Slack-Signature`: the `v0=` HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw body>`, compared in constant time. A timestamp more than 5 minutes off fails, and a failed check is a 401. The body is read from `request.clone()`.
- A `block_actions` payload carrying one of our button values becomes a click, from `user.id` with the name from `user.name` or `user.username`, so `by` reads `slack:U01ABC (alice)`.
- Any other `block_actions`, such as a URL-button click, gets Slack's required ack. Anything else is null.

The reply to every click is an empty 200, sent within Slack's 3 seconds. After it, a follow-up posts to the click's `response_url` (only `hooks.slack.com` or `hooks.slack-gov.com`):

- **A decision** replaces the message (`replace_original: true`) with the text minus its link lines, plus "Approved by alice at 14:02 UTC". The buttons are removed.
- **Anything else** is an ephemeral note only the clicker sees (`response_type: "ephemeral"`, `replace_original: false`), such as "Already approved by alice".

Nothing logs or returns the `response_url`.

### Discord

| Variable | |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Optional. Your application's Public Key (General Information), 64 hex characters; not a secret. With `DISCORD_BOT_TOKEN`, approvals get interactive Approve and Reject buttons. |
| `DISCORD_APPROVERS` | Optional. Who may decide with a button: Discord user IDs and `role:<role ID>` entries, separated by spaces or commas (turn on Developer Mode, then right-click a user or role → Copy ID). Empty: anyone who can see the message. |

What an approval message gets (the text always keeps the links):

- **Bot token and public key**: Approve (green) and Reject (red) buttons. Set the application's **Interactions Endpoint URL** (General Information) to the actuator's `/providers/discord/webhook` (the tenant's Interactions URL on the hosted platform); Discord checks it with a signed PING. The application then receives interactions over HTTP only, not over the Gateway.
- **Bot token without a public key, or a channel webhook**: link buttons to the confirm pages (sent with `?with_components=true` through a webhook, which can't send interactive buttons), when every link is at most 512 characters; otherwise text only. A question (`waitForInput`) gets an **Answer** link button under the same rule. If Discord refuses the buttons, the text is sent alone.

Every interaction must carry a valid `X-Signature-Ed25519` over `X-Signature-Timestamp` + body (verified with WebCrypto), with a timestamp within 5 minutes; otherwise 401. A decided click updates the message in the interaction response (links and buttons removed, "Approved by Alice at 14:02 UTC"); everything else answers only the clicker, ephemerally. Other interactions of the same application (slash commands, other buttons) get a polite ephemeral "This app only handles Actuate approval buttons." The clicker is `discord:<user ID> (<display name>)` in `ApprovalResult.by`. If the reply misses Discord's 3-second deadline, the user sees "This interaction failed" but the decision stands.

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
