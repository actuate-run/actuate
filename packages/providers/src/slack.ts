// Docs: https://docs.slack.dev/reference/methods/chat.postMessage and https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
import { z } from "zod";
import type { ProviderDefinition } from "./contract.js";
import type { MessagingProvider } from "@actuate/sdk";
import { escapeSlack, htmlToSlack } from "./chat-format.js";
import { optionalString, parseWith, ProviderApiError, requestJson } from "./util.js";

const schema = z
  .object({
    botToken: optionalString().refine((v) => v === undefined || v.startsWith("xoxb-"), 'botToken must start with "xoxb-"'),
    webhookUrl: optionalString().refine(
      (v) => v === undefined || v.startsWith("https://hooks.slack.com/"),
      "webhookUrl must be a Slack incoming webhook URL (https://hooks.slack.com/...)",
    ),
    defaultChannel: optionalString(),
  })
  .refine((c) => c.botToken || c.webhookUrl, { message: "Set botToken (to post to any channel) or webhookUrl (one fixed channel)" });
export type SlackCredentials = z.output<typeof schema>;

export const slack: ProviderDefinition<SlackCredentials, "messaging"> = {
  kind: "slack",
  capability: "messaging",
  label: "Slack",
  credentialFields: [
    {
      key: "botToken",
      label: "Bot token",
      secret: true,
      optional: true,
      help: "xoxb-... from a Slack app with chat:write. Posts to any channel the bot is in; `to` is a channel ID like C0123456789.",
    },
    {
      key: "webhookUrl",
      label: "Incoming webhook URL",
      secret: true,
      optional: true,
      help: "Simpler: posts to the one channel the webhook was made for, and `to` is ignored.",
    },
    { key: "defaultChannel", label: "Default channel ID", secret: false, optional: true, help: "Used with the bot token when `to` is empty." },
  ],
  parseCredentials: (input) => parseWith("Slack", schema, input),
  create(credentials, ctx): MessagingProvider {
    return {
      async send(to, text, options) {
        // Idempotency: neither chat.postMessage nor incoming webhooks take an idempotency key, so
        // options.idempotencyKey is unused. A retried send can post twice.
        const body = options?.format === "html" ? htmlToSlack(text) : escapeSlack(text);
        const channel = (to ?? "").trim() || credentials.defaultChannel;
        if (credentials.botToken && channel) {
          const res = await requestJson<{ ok: boolean; ts?: string; channel?: string; error?: string }>(
            "Slack",
            ctx.fetch,
            "https://slack.com/api/chat.postMessage",
            {
              method: "POST",
              headers: { authorization: `Bearer ${credentials.botToken}`, "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ channel, text: body, unfurl_links: false }),
            },
          );
          if (!res?.ok || !res.ts) throw new ProviderApiError("Slack", 200, res?.error ?? "chat.postMessage failed");
          return { id: `${res.channel ?? channel}:${res.ts}`, channel: "slack" };
        }
        if (!credentials.webhookUrl) throw new Error("Slack send needs `to` as a channel ID (or set a default channel)");
        // The webhook URL is a secret: requestJson strips URLs from network errors.
        await requestJson("Slack", ctx.fetch, credentials.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: body }),
        });
        return { id: "webhook", channel: "slack" };
      },
    };
  },
};
