// Docs: https://resend.com/docs/api-reference/emails/send-email
import { z } from "zod";
import type { ProviderDefinition } from "./contract.js";
import type { MessagingProvider } from "@actuate/sdk";
import { optionalString, parseWith, requestJson } from "./util.js";

const schema = z.object({
  apiKey: z.string({ error: "apiKey is required" }).trim().startsWith("re_", 'apiKey must start with "re_"'),
  from: z
    .string({ error: "from is required" })
    .trim()
    .regex(/^(?:[^<>]*<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/, 'from must be an email address on a verified domain, e.g. "Acme <bot@acme.com>"'),
  replyTo: optionalString(),
  defaultSubject: optionalString(),
});
export type ResendCredentials = z.output<typeof schema>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deriveSubject(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return firstLine.length > 78 ? `${firstLine.slice(0, 75)}...` : firstLine || "Message";
}

export const resend: ProviderDefinition<ResendCredentials, "messaging"> = {
  kind: "resend",
  capability: "messaging",
  label: "Email (Resend)",
  credentialFields: [
    { key: "apiKey", label: "API key", secret: true, help: "A Resend API key with sending access." },
    { key: "from", label: "From address", secret: false, help: 'On a domain verified in Resend, e.g. "Acme <bot@acme.com>".' },
    { key: "replyTo", label: "Reply-to address", secret: false, optional: true },
    { key: "defaultSubject", label: "Default subject", secret: false, optional: true, help: "Used when a send gives no subject." },
  ],
  parseCredentials: (input) => parseWith("Resend", schema, input),
  create(credentials, ctx): MessagingProvider {
    return {
      async send(to, text, options) {
        const recipient = (to ?? "").trim();
        if (!EMAIL.test(recipient)) throw new Error("Resend send needs `to` as an email address");
        const headers: Record<string, string> = { authorization: `Bearer ${credentials.apiKey}`, "content-type": "application/json" };
        if (options?.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey.slice(0, 256);
        const body = await requestJson<{ id?: string }>("Resend", ctx.fetch, "https://api.resend.com/emails", {
          method: "POST",
          headers,
          body: JSON.stringify({
            from: credentials.from,
            to: [recipient],
            subject: options?.subject ?? credentials.defaultSubject ?? deriveSubject(text),
            text,
            ...(credentials.replyTo ? { reply_to: credentials.replyTo } : {}),
          }),
        });
        if (!body?.id) throw new Error("Resend API returned no email ID");
        return { id: body.id, channel: "email" };
      },
    };
  },
};
