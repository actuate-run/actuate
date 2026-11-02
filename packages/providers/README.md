# @actuate/providers

Bring-your-own-credentials adapters behind `ctx.messaging`, `ctx.payment` and `ctx.llm`. The hosted platform and `actuate dev` use the same code.

| Capability | Providers |
| --- | --- |
| messaging | Telegram, WhatsApp Cloud API, Slack, Discord, Resend (email). Several at once, picked with `send(..., { channel })`; WhatsApp and Telegram replies arrive as events |
| payment | Stripe, Chip, ToyyibPay, Billplz. Payment webhooks are verified and arrive as `payment.<referenceId>` events |
| llm | Anthropic, OpenAI, Google, or any OpenAI-compatible API (OpenRouter, Groq, DeepSeek, Ollama, ...) |

Self-hosted or under `actuate dev`, configure them with environment variables:

```ts
import { parseProviderWebhookFromEnv, providersFromEnv } from "@actuate/providers";

// ACTUATE_MESSAGING=whatsapp,slack  WHATSAPP_ACCESS_TOKEN=...  SLACK_WEBHOOK_URL=...
// ACTUATE_PAYMENT=billplz  BILLPLZ_API_KEY=...  ACTUATE_LLM=anthropic  ANTHROPIC_API_KEY=...
const providers = providersFromEnv(env, "https://bot.example.com");
```

`npx actuate providers` lists every provider and its variables. Adding one? Implement the contract in [`src/contract.ts`](src/contract.ts) and see [CONTRIBUTING.md](../../CONTRIBUTING.md). Guide: [Capabilities and providers](https://actuate.run/docs/concepts/capabilities/).

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
