// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages (signature: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads)
import { z } from "zod";
import { WebhookVerificationError, hmacSha256Hex, timingSafeEqual, type ProviderDefinition, type ProviderEvent } from "./contract.js";
import type { InboundMessage, MessagingProvider } from "@actuate/sdk";
import { htmlToText, messageEvent, optionalString, parseWith, requestJson, requiredString } from "./util.js";

export const WHATSAPP_DEFAULT_API_VERSION = "v26.0";

const schema = z.object({
  phoneNumberId: z
    .string({ error: "phoneNumberId is required" })
    .trim()
    .regex(/^\d+$/, "phoneNumberId must be the numeric Phone number ID from WhatsApp Manager (not the phone number)"),
  accessToken: requiredString("accessToken"),
  appSecret: optionalString(),
  verifyToken: optionalString(),
  apiVersion: z
    .string()
    .trim()
    .regex(/^v\d+\.\d+$/, 'apiVersion must look like "v26.0"')
    .optional(),
});
export type WhatsAppCredentials = z.output<typeof schema>;

interface SendResponse {
  messages?: Array<{ id: string }>;
}

export const whatsapp: ProviderDefinition<WhatsAppCredentials, "messaging"> = {
  kind: "whatsapp",
  capability: "messaging",
  label: "WhatsApp Cloud API",
  credentialFields: [
    { key: "phoneNumberId", label: "Phone number ID", secret: false, help: "From your Meta app: WhatsApp > API Setup." },
    { key: "accessToken", label: "Access token", secret: true, help: "A System User permanent token with whatsapp_business_messaging." },
    {
      key: "appSecret",
      label: "App secret",
      secret: true,
      optional: true,
      help: "Needed to receive messages: verifies X-Hub-Signature-256. Meta app > App settings > Basic.",
    },
    {
      key: "verifyToken",
      label: "Webhook verify token",
      secret: true,
      optional: true,
      help: "Any string you choose. Enter the same one as the Verify token when you add the webhook URL in Meta.",
    },
    { key: "apiVersion", label: "Graph API version", secret: false, optional: true, help: `Defaults to ${WHATSAPP_DEFAULT_API_VERSION}.` },
  ],
  parseCredentials: (input) => parseWith("WhatsApp", schema, input),
  create(credentials, ctx): MessagingProvider {
    const version = credentials.apiVersion ?? WHATSAPP_DEFAULT_API_VERSION;
    return {
      async send(to, text, options) {
        const recipient = (to ?? "").replace(/[\s+()-]/g, "");
        if (!/^\d{6,20}$/.test(recipient)) throw new Error("WhatsApp send needs `to` as a phone number in international format, e.g. 60123456789");
        const base = { messaging_product: "whatsapp", recipient_type: "individual", to: recipient };
        const message = options?.template
          ? {
              ...base,
              type: "template",
              template: {
                name: options.template.name,
                language: { code: options.template.language },
                ...(options.template.variables?.length
                  ? { components: [{ type: "body", parameters: options.template.variables.map((v) => ({ type: "text", text: v })) }] }
                  : {}),
              },
            }
          : { ...base, type: "text", text: { preview_url: false, body: options?.format === "html" ? htmlToText(text) : text } };
        const body = await requestJson<SendResponse>("WhatsApp", ctx.fetch, `https://graph.facebook.com/${version}/${credentials.phoneNumberId}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(message),
        });
        const id = body?.messages?.[0]?.id;
        if (!id) throw new Error("WhatsApp API returned no message ID");
        return { id, channel: "whatsapp" };
      },
    };
  },
  handshake(request, credentials) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.searchParams.get("hub.mode") !== "subscribe") return null;
    const given = url.searchParams.get("hub.verify_token") ?? "";
    if (!credentials.verifyToken || !timingSafeEqual(given, credentials.verifyToken)) {
      throw new WebhookVerificationError("WhatsApp verify token mismatch: set the same Webhook verify token here and in Meta");
    }
    return url.searchParams.get("hub.challenge") ?? "";
  },
  async parseWebhook(request, credentials) {
    // Without the app secret anyone could post fake messages, so inbound needs it.
    if (!credentials.appSecret || request.method !== "POST") return null;
    const header = request.headers.get("x-hub-signature-256") ?? "";
    const raw = await request.text();
    const expected = `sha256=${await hmacSha256Hex(credentials.appSecret, raw)}`;
    if (!timingSafeEqual(header.toLowerCase(), expected)) throw new WebhookVerificationError("WhatsApp X-Hub-Signature-256 mismatch");
    let body: MetaWebhook;
    try {
      body = JSON.parse(raw) as MetaWebhook;
    } catch {
      return null;
    }
    const events: ProviderEvent[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        // One business account can have several numbers: only this provider's number counts.
        if (change.field !== "messages" || value?.metadata?.phone_number_id !== credentials.phoneNumberId) continue;
        for (const m of value.messages ?? []) {
          if (!m.from || !m.id) continue;
          const name = value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
          const message: InboundMessage = {
            channel: "whatsapp",
            from: m.from,
            text: messageText(m),
            type: m.type ?? "unknown",
            id: m.id,
            at: Number(m.timestamp ?? 0) * 1000,
            ...(name ? { name } : {}),
          };
          events.push({ event: messageEvent("whatsapp", m.from), payload: { ...message } });
        }
      }
    }
    return events.length ? events : null;
  },
};

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
}

interface MetaWebhook {
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: MetaMessage[];
      };
    }>;
  }>;
}

function messageText(m: MetaMessage): string {
  return (
    m.text?.body ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    m.image?.caption ??
    m.video?.caption ??
    m.document?.caption ??
    ""
  );
}
