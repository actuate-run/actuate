---
"@actuate/providers": minor
"@actuate/sdk": minor
---

New messaging channel: custom webhook. Send messages to any URL: your own server, Zapier, n8n, ntfy, Google Chat…

- **providers:** new `custom-webhook` messaging provider (`ACTUATE_MESSAGING=custom-webhook`, `CUSTOM_WEBHOOK_URL`, and optional `CUSTOM_WEBHOOK_SECRET`, `CUSTOM_WEBHOOK_HEADERS`, `CUSTOM_WEBHOOK_FORMAT`, `CUSTOM_WEBHOOK_TEMPLATE`). Actuate POSTs each message to your URL; to reply, POST to the reply URL it gave you. Pick it with `send(to, text, { channel: "custom-webhook" })`. The body is `standard` JSON (`id`, `to`, `text`, `html`, `subject`, `replyUrl`), `text` (plain text with a `Title` header, for ntfy) or your own JSON `template` with `{{text}}`-style placeholders. With a signing secret (`whsec_...`) each message is signed the Standard Webhooks way (`webhook-id`, `webhook-timestamp`, `webhook-signature`), and replies posted to `/providers/custom-webhook/webhook` with `Authorization: Bearer <secret>`, `?secret=<secret>` or a valid signature arrive as `message.custom-webhook.<from>` events. The message `id` comes from the idempotency key, so a retried step sends the same `id` and the receiver can drop the duplicate. Redirects are not followed, requests time out after 10 seconds, and errors never include the URL, the secret or header values.
- **providers:** new `signStandardWebhook(secret, id, timestamp, body)` and `verifyStandardWebhook(secret, headers, body)` (WebCrypto only, so they run in Workers).
- **providers:** `credentialFields` entries can declare `multiline: true` (a textarea), `options` (a select; the first is the default) and `generate: "whsec"` (a "Generate" button for a Standard Webhooks secret), so a form can render them generically. Existing providers are unchanged.
- **sdk:** the `MessagingSendOptions.channel`, `idempotencyKey` and `InboundMessage.from` docs mention the custom webhook channel.
