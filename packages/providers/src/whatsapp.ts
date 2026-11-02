// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages (signature: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads)
import { z } from "zod";
import { WebhookVerificationError, hmacSha256Hex, timingSafeEqual, type ProviderDefinition } from "./contract.js";
import type { MessagingProvider } from "@actuate/sdk";
import { htmlToText, optionalString, parseWith, requestJson, requiredString } from "./util.js";

export const WHATSAPP_DEFAULT_API_VERSION = "v26.0";

const schema = z.object({
  phoneNumberId: z
    .string({ error: "phoneNumberId is required" })
    .trim()
    .regex(/^\d+$/, "phoneNumberId must be the numeric Phone number ID from WhatsApp Manager (not the phone number)"),
  accessToken: requiredString("accessToken"),
  appSecret: optionalString(),
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
    { key: "appSecret", label: "App secret", secret: true, optional: true, help: "Used to verify X-Hub-Signature-256 on webhooks." },
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
  async parseWebhook(request, credentials) {
    // Inbound messages are a later feature; verify the signature when an app secret is configured.
    if (credentials.appSecret) {
      const header = request.headers.get("x-hub-signature-256") ?? "";
      const raw = await request.text();
      const expected = `sha256=${await hmacSha256Hex(credentials.appSecret, raw)}`;
      if (!timingSafeEqual(header.toLowerCase(), expected)) throw new WebhookVerificationError("WhatsApp X-Hub-Signature-256 mismatch");
    }
    return null;
  },
};
