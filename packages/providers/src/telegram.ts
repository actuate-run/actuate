// Docs: https://core.telegram.org/bots/api#sendmessage
import { z } from "zod";
import { WebhookVerificationError, timingSafeEqual, type ProviderDefinition } from "./contract.js";
import type { InboundMessage, MessagingProvider } from "@actuate/sdk";
import { messageEvent, optionalString, parseWith, ProviderApiError, requestJson } from "./util.js";

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
      help: "Needed to receive messages: any string, passed as secret_token when you call setWebhook.",
    },
  ],
  parseCredentials: (input) => parseWith("Telegram", schema, input),
  create(credentials, ctx): MessagingProvider {
    return {
      async send(to, text, options) {
        if (!to?.trim()) throw new Error("Telegram send needs a chat ID in `to`");
        // Idempotency: the Bot API's sendMessage has no idempotency key or dedup field, so options.idempotencyKey
        // is unused. A retried step whose first attempt reached Telegram sends the message again.
        // The bot token is part of the URL, so errors below never include the URL.
        const body = await requestJson<TelegramResponse>("Telegram", ctx.fetch, `https://api.telegram.org/bot${credentials.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: to.trim(), text, ...(options?.format === "html" ? { parse_mode: "HTML" } : {}) }),
        });
        if (!body?.ok || !body.result) throw new ProviderApiError("Telegram", body?.error_code ?? 200, body?.description ?? "sendMessage failed");
        return { id: String(body.result.message_id), channel: "telegram" };
      },
    };
  },
  async parseWebhook(request, credentials) {
    // Without the secret token anyone could post fake updates, so inbound needs it.
    if (!credentials.webhookSecretToken) return null;
    const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!timingSafeEqual(got, credentials.webhookSecretToken)) throw new WebhookVerificationError("Telegram secret token mismatch");
    const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
    const m = update?.message;
    if (!m?.chat?.id) return null;
    const from = String(m.chat.id);
    const type = m.text !== undefined ? "text" : (["photo", "video", "document", "voice", "audio", "location", "contact", "sticker"].find((k) => k in m) ?? "unknown");
    const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
    const message: InboundMessage = {
      channel: "telegram",
      from,
      text: m.text ?? m.caption ?? "",
      type,
      id: String(m.message_id),
      at: (m.date ?? 0) * 1000,
      ...(name ? { name } : {}),
    };
    return { event: messageEvent("telegram", from), payload: { ...message } };
  },
};

interface TelegramUpdate {
  message?: {
    message_id: number;
    date?: number;
    chat?: { id: number | string };
    from?: { first_name?: string; last_name?: string };
    text?: string;
    caption?: string;
  } & Record<string, unknown>;
}
