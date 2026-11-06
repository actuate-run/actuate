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
| `CUSTOM_WEBHOOK_FORMAT` | `standard` (default), `text` or `template`. Setting a template without a format means `template`. |
| `CUSTOM_WEBHOOK_TEMPLATE` | JSON for the `template` format, with `{{text}}`, `{{html}}`, `{{subject}}`, `{{to}}`, `{{id}}`, `{{replyUrl}}` inside JSON strings. |

Body formats:

- `standard`: `{ "id", "to", "text", "html"?, "subject"?, "replyUrl"? }` as JSON. `text` is always plain text; `html` is the original when sent with `format: "html"`. `replyUrl` is there only with a signing secret.
- `text`: the plain text as `text/plain`, with the subject as a `Title` header (ntfy).
- `template`: your JSON with the placeholders filled in, JSON-escaped. Google Chat, Mattermost and Rocket.Chat take `{"text":"{{text}}"}`; Gotify `{"title":"{{subject}}","message":"{{text}}"}`; Apprise `{"title":"{{subject}}","body":"{{text}}"}`.

`id` (also the `webhook-id` header) comes from the step's idempotency key, so a retried step sends the same `id` and the receiver can drop the duplicate. A JSON reply with a string `id` becomes the receipt's `id`. Redirects are not followed, requests time out after 10 s, and at most 64 KB of the response is read.

Replies are a POST to the reply URL (`/providers/custom-webhook/webhook`) with JSON `{ "from": "me", "text": "yes" }` (also `id`, `at` in ms, `name`, `type`), authorized by any one of `Authorization: Bearer <secret>`, `?secret=<secret>`, or a Standard Webhooks signature made with the secret. Each becomes the event `message.custom-webhook.<from>`; a reply without `from` is ignored (`{"ignored": true}`). Known limitation: Actuate does not deduplicate a signed reply replayed within its 5-minute window.

```sh
curl -X POST "$REPLY_URL" -H "Authorization: Bearer $CUSTOM_WEBHOOK_SECRET" -H "content-type: application/json" -d '{"from":"me","text":"yes"}'
```

`signStandardWebhook` and `verifyStandardWebhook` are exported for receivers written in TypeScript (WebCrypto only, so they run in Workers).

`npx actuate providers` lists every provider and its variables. Adding one? Implement the contract in [`src/contract.ts`](src/contract.ts) and see [CONTRIBUTING.md](../../CONTRIBUTING.md). Guide: [Capabilities and providers](https://actuate.run/docs/concepts/capabilities/).

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
