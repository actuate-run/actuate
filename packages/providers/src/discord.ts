// Docs: https://discord.com/developers/docs/resources/message#create-message and https://discord.com/developers/docs/resources/webhook#execute-webhook
import { z } from "zod";
import type { ProviderDefinition } from "./contract.js";
import type { MessagingProvider } from "@actuate/sdk";
import { htmlToDiscord } from "./chat-format.js";
import { idempotencyNonce, optionalString, parseWith, requestJson } from "./util.js";

const MAX_LENGTH = 2000;

const schema = z
  .object({
    botToken: optionalString(),
    webhookUrl: optionalString().refine(
      (v) => v === undefined || /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(v),
      "webhookUrl must be a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)",
    ),
    defaultChannel: optionalString(),
  })
  .refine((c) => c.botToken || c.webhookUrl, { message: "Set botToken (to post to any channel) or webhookUrl (one fixed channel)" });
export type DiscordCredentials = z.output<typeof schema>;

export const discord: ProviderDefinition<DiscordCredentials, "messaging"> = {
  kind: "discord",
  capability: "messaging",
  label: "Discord",
  credentialFields: [
    {
      key: "botToken",
      label: "Bot token",
      secret: true,
      optional: true,
      help: "From your Discord application's Bot page. Posts to any channel the bot can see; `to` is a channel ID.",
    },
    {
      key: "webhookUrl",
      label: "Webhook URL",
      secret: true,
      optional: true,
      help: "Simpler: Channel settings → Integrations → Webhooks. Posts to that channel, and `to` is ignored.",
    },
    { key: "defaultChannel", label: "Default channel ID", secret: false, optional: true, help: "Used with the bot token when `to` is empty." },
  ],
  parseCredentials: (input) => parseWith("Discord", schema, input),
  create(credentials, ctx): MessagingProvider {
    return {
      async send(to, text, options) {
        const content = options?.format === "html" ? htmlToDiscord(text) : text;
        if (content.length > MAX_LENGTH) throw new Error(`Discord messages are at most ${MAX_LENGTH} characters (this one is ${content.length})`);
        // Never ping @everyone or roles from automation.
        const message = { content, allowed_mentions: { parse: ["users"] } };
        const payload = JSON.stringify(message);
        const channel = (to ?? "").trim() || credentials.defaultChannel;
        if (credentials.botToken && channel) {
          if (!/^\d{5,25}$/.test(channel)) throw new Error("Discord send needs `to` as a numeric channel ID");
          // Idempotency: Create Message checks `nonce` (at most 25 characters) for uniqueness over the past few
          // minutes when `enforce_nonce` is set, and returns the earlier message instead of posting again. So a
          // quick retry is deduplicated; one after a longer backoff may post twice.
          const nonce = options?.idempotencyKey ? await idempotencyNonce(options.idempotencyKey, 25) : undefined;
          const res = await requestJson<{ id: string }>("Discord", ctx.fetch, `https://discord.com/api/v10/channels/${channel}/messages`, {
            method: "POST",
            headers: { authorization: `Bot ${credentials.botToken}`, "content-type": "application/json" },
            body: nonce ? JSON.stringify({ ...message, nonce, enforce_nonce: true }) : payload,
          });
          return { id: res.id, channel: "discord" };
        }
        if (!credentials.webhookUrl) throw new Error("Discord send needs `to` as a channel ID (or set a default channel)");
        // Execute Webhook takes no nonce: webhook sends cannot be deduplicated, so the idempotency key is unused.
        const res = await requestJson<{ id?: string }>("Discord", ctx.fetch, `${credentials.webhookUrl}?wait=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        return { id: res?.id ?? "webhook", channel: "discord" };
      },
    };
  },
};
