// Docs: https://core.telegram.org/bots/api#sendmessage
import { z } from "zod";
import { WebhookVerificationError, timingSafeEqual, type ProviderDefinition } from "./contract.js";
import type { MessagingProvider } from "@actuate/sdk";
import { optionalString, parseWith, ProviderApiError, requestJson } from "./util.js";

const schema = z.object({
  botToken: z
    .string({ error: "botToken is required" })
    .trim()
    .regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "botToken must look like 123456789:AA... (from @BotFather)"),
  /** Optional secret_token set via setWebhook; checked against X-Telegram-Bot-Api-Secret-Token. */
  webhookSecretToken: optionalString(),
});
export type TelegramCredentials = z.output<typeof schema>;

interface TelegramResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
  error_code?: number;
}

export const telegram: ProviderDefinition<TelegramCredentials, "messaging"> = {
  kind: "telegram",
  capability: "messaging",
  label: "Telegram Bot",
  credentialFields: [
    { key: "botToken", label: "Bot token", secret: true, help: "Create a bot with @BotFather and paste its token." },
    {
      key: "webhookSecretToken",
      label: "Webhook secret token",
      secret: true,
      optional: true,
      help: "Only needed for inbound messages: the secret_token you pass to setWebhook.",
    },
  ],
  parseCredentials: (input) => parseWith("Telegram", schema, input),
  create(credentials, ctx): MessagingProvider {
    return {
      async send(to, text) {
        if (!to?.trim()) throw new Error("Telegram send needs a chat ID in `to`");
        // The bot token is part of the URL, so errors below never include the URL.
        const body = await requestJson<TelegramResponse>("Telegram", ctx.fetch, `https://api.telegram.org/bot${credentials.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: to.trim(), text }),
        });
        if (!body?.ok || !body.result) throw new ProviderApiError("Telegram", body?.error_code ?? 200, body?.description ?? "sendMessage failed");
        return { id: String(body.result.message_id), channel: "telegram" };
      },
    };
  },
  async parseWebhook(request, credentials) {
    // Inbound messages are a later feature. Still reject updates that fail the secret-token check.
    if (credentials.webhookSecretToken) {
      const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!timingSafeEqual(got, credentials.webhookSecretToken)) throw new WebhookVerificationError("Telegram secret token mismatch");
    }
    return null;
  },
};
