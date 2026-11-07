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
| `CUSTOM_WEBHOOK_APPROVAL_TEMPLATE` | Optional JSON used instead, whatever the format, for approval requests only (`waitForApproval` with `notify`): the same placeholders plus `{{approveUrl}}`, `{{rejectUrl}}` and `{{expiresAt}}` (ISO 8601). It must use at least one of `{{approveUrl}}`, `{{rejectUrl}}` or `{{text}}` (the text holds the links), so the links always reach the receiver. Questions (`waitForInput`) use the body format, where `{{answerUrl}}` and the standard body's `approval.answerUrl` carry the answer link. Without it, approvals use the body format too. |

Body formats:

- `standard`: `{ "id", "to", "text", "html"?, "subject"?, "replyUrl"? }` as JSON. `text` is always plain text; `html` is the original when sent with `format: "html"`. `replyUrl` is there only with a signing secret.
- `text`: the plain text as `text/plain`, with the subject as a `Title` header (ntfy).
- `template`: your JSON with the placeholders filled in, JSON-escaped. Google Chat, Mattermost and Rocket.Chat take `{"text":"{{text}}"}`; Gotify `{"title":"{{subject}}","message":"{{text}}"}`; Apprise `{"title":"{{subject}}","body":"{{text}}"}`.

Approval and input requests carry an `approval` object in the `standard` body: `{ "kind": "approval" | "input", "actuator", "step", "message"?, "approveUrl", "rejectUrl" }` (or `"answerUrl"` for input), and `"expiresAt"` in ISO 8601. `text` still holds the message and the links. Only Actuate's approval notifications set it: the runtime drops `approval` from sends made by actuator code. The links open Actuate's confirm page, where the decision is made (opening a link decides nothing, so link previews are harmless). Send approvals only to a receiver that shows them to a person: a link is all it takes to decide.

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

`signStandardWebhook` and `verifyStandardWebhook` are exported for receivers written in TypeScript (WebCrypto only, so they run in Workers).

## Approval buttons

A chat provider can put Approve and Reject buttons on approval messages. When `send` gets `options.approval.buttons` (`{ route, nonce }`, set only by Actuate's own approval notifications), it puts `encodeButtonPayload({ route, nonce, action })` (`ap1:<route>:<nonce>:<a|r>`, at most 47 bytes) on its buttons; the text keeps the signed links either way. Clicks come back through four optional `ProviderDefinition` members:

| Member | |
| --- | --- |
| `parseInteraction(request, credentials, ctx?)` | Verify the request and return `{ click }` (a `ButtonClick`, from `parseButtonPayload`), `{ reply }` for a request the provider needs answered as is (a PING), or null to fall through to `parseWebhook`. Throws `WebhookVerificationError` on a bad signature. Reads the body from `request.clone()`, so `parseWebhook` still has it. |
| `isApprover(actor, credentials)` | Whether this person may decide with a button; true when no `approvers` list is configured. |
| `respondInteraction(click, outcome, credentials, ctx)` | The reply to send now, and an optional `after()` run once it is sent (editing the message). |
| `routeHint(body, contentType)` | The unverified route in a raw body, for the hosted platform's tenant-level interactions URL. |

Helpers in the contract, so every provider words and validates things the same way: `parseApprovers` (an `approvers` credential: IDs separated by spaces or commas, with `role:<id>` entries where the provider has roles), `isListedApprover`, `formatApprovers`, `approversCredentialField`, `clickOutcomeText` ("Approved by Alice at 14:02 UTC", "Already approved by Alice", "This request has expired or was already decided.", "You're not on the approver list for this.", "This button belongs to another actuator."), `withoutLinkLines` and `decidedMessageText` for the edited message, and `jsonReply` / `textReply`. `providerInteractions(definition, credentials)` and `providerInteractionsFromEnv(env, kind)` bind them for a runtime (`createRuntime`'s `providerInteractions`).

An `approvers` list restricts buttons, not links: the signed links in the message still work for whoever holds them.

### Discord

| Variable | |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Optional. Your application's Public Key (General Information), 64 hex characters; not a secret. With `DISCORD_BOT_TOKEN`, approvals get interactive Approve and Reject buttons. |
| `DISCORD_APPROVERS` | Optional. Who may decide with a button: Discord user IDs and `role:<role ID>` entries, separated by spaces or commas (turn on Developer Mode, then right-click a user or role → Copy ID). Empty: anyone who can see the message. |

What an approval message gets (the text always keeps the links):

- **Bot token and public key**: Approve (green) and Reject (red) buttons. Set the application's **Interactions Endpoint URL** (General Information) to the actuator's `/providers/discord/webhook` (the tenant's Interactions URL on the hosted platform); Discord checks it with a signed PING. The application then receives interactions over HTTP only, not over the Gateway.
- **Bot token without a public key, or a channel webhook**: link buttons to the confirm pages (sent with `?with_components=true` through a webhook, which can't send interactive buttons), when every link is at most 512 characters; otherwise text only. A question (`waitForInput`) gets an **Answer** link button under the same rule. If Discord refuses the buttons, the text is sent alone.

Every interaction must carry a valid `X-Signature-Ed25519` over `X-Signature-Timestamp` + body (verified with WebCrypto), with a timestamp within 5 minutes; otherwise 401. A decided click updates the message in the interaction response (links and buttons removed, "Approved by Alice at 14:02 UTC"); everything else answers only the clicker, ephemerally. Other interactions of the same application (slash commands, other buttons) get a polite ephemeral "This app only handles Actuate approval buttons." The clicker is `discord:<user ID> (<display name>)` in `ApprovalResult.by`. If the reply misses Discord's 3-second deadline, the user sees "This interaction failed" but the decision stands.

`npx actuate providers` lists every provider and its variables. Adding one? Implement the contract in [`src/contract.ts`](src/contract.ts) and see [CONTRIBUTING.md](../../CONTRIBUTING.md). Guide: [Capabilities and providers](https://actuate.run/docs/concepts/capabilities/).

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
