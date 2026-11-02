# @actuate/providers

Bring-your-own-credentials adapters for Actuate: Telegram, WhatsApp Cloud, Resend, Stripe, Chip, ToyyibPay, Billplz, Anthropic, OpenAI and Google.

```ts
import { providersFromEnv } from "@actuate/providers";

// ACTUATE_MESSAGING=telegram, TELEGRAM_BOT_TOKEN=..., ACTUATE_PAYMENT=billplz, ...
const providers = providersFromEnv(env, "https://bot.example.com");
```

Docs: https://actuate.run/docs · Source: https://github.com/actuate-run/actuate

License: Apache-2.0
