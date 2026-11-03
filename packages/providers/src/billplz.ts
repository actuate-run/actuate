// Docs: https://www.billplz.com/api (now served at https://support.billplz.com/api)
import { z } from "zod";
import {
  WebhookVerificationError,
  hmacSha256Hex,
  timingSafeEqual,
  type ProviderContext,
  type ProviderEvent,
} from "./contract.js";
import type { Bill, PaymentProvider } from "@actuate/sdk";
import { type ProviderDefinitionWithWebhookLookup, looseBoolean, NotSupportedError, parseWith, readForm, requestJson, requireMyr, requiredString, toMinor, webhookFetch } from "./util.js";

const schema = z.object({
  apiKey: requiredString("apiKey"),
  collectionId: requiredString("collectionId"),
  xSignatureKey: requiredString("xSignatureKey"),
  sandbox: looseBoolean(),
});
export type BillplzCredentials = z.output<typeof schema>;

export function billplzBase(credentials: Pick<BillplzCredentials, "sandbox">): string {
  return credentials.sandbox ? "https://www.billplz-sandbox.com/api" : "https://www.billplz.com/api";
}

interface BillplzBill {
  id: string;
  url: string;
  state: "due" | "paid" | "deleted";
  paid: boolean;
  amount: number;
  paid_amount?: number;
  reference_1?: string | null;
}

function toBill(b: BillplzBill): Bill {
  return {
    id: b.id,
    url: b.url,
    status: b.paid || b.state === "paid" ? "paid" : b.state === "deleted" ? "expired" : "pending",
    amount: b.amount / 100,
    currency: "MYR",
    referenceId: b.reference_1 ?? "",
  };
}

/**
 * Billplz X Signature: every field except x_signature becomes key+value, the
 * strings are sorted case-insensitively, joined with "|", and HMAC-SHA256'd
 * (hex) with the collection's X Signature key.
 */
export async function billplzSignature(fields: Record<string, string>, key: string): Promise<string> {
  const source = Object.entries(fields)
    .filter(([k]) => k !== "x_signature")
    .map(([k, v]) => `${k}${v}`)
    .sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .join("|");
  return hmacSha256Hex(key, source);
}

function basicAuth(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`;
}

async function fetchBill(fetcher: typeof fetch, credentials: BillplzCredentials, id: string): Promise<BillplzBill> {
  return requestJson<BillplzBill>("Billplz", fetcher, `${billplzBase(credentials)}/v3/bills/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { authorization: basicAuth(credentials.apiKey) },
  });
}

export const billplz: ProviderDefinitionWithWebhookLookup<BillplzCredentials, "payment"> = {
  kind: "billplz",
  capability: "payment",
  label: "Billplz",
  credentialFields: [
    { key: "apiKey", label: "API secret key", secret: true },
    { key: "collectionId", label: "Collection ID", secret: false },
    { key: "xSignatureKey", label: "X Signature key", secret: true, help: "Settings > Keys & Integration. Enable X Signature." },
    { key: "sandbox", label: "Sandbox (billplz-sandbox.com)", secret: false, optional: true },
  ],
  parseCredentials: (input) => parseWith("Billplz", schema, input),
  create(credentials, ctx): PaymentProvider {
    const base = billplzBase(credentials);
    return {
      // Idempotency: the v3 bills API documents no idempotency key or dedup field (reference_1 is only a
      // reference), so req.idempotencyKey is unused. A retried createBill can make a second, unpaid bill. No refunds.
      async createBill(req) {
        const currency = requireMyr("Billplz", req.currency);
        if (!req.referenceId) throw new Error("referenceId is required");
        if (req.referenceId.length > 120) throw new Error("Billplz referenceId must be at most 120 characters");
        const email = req.customer?.email;
        const mobile = req.customer?.phone?.replace(/\D/g, "");
        if (!email && !mobile) throw new Error("Billplz needs customer.email or customer.phone");
        const params = new URLSearchParams({
          collection_id: credentials.collectionId,
          name: (req.customer?.name || email || mobile || "Customer").slice(0, 255),
          amount: String(toMinor(req.amount, currency)),
          callback_url: ctx.webhookUrl,
          redirect_url: req.returnUrl ?? ctx.defaultReturnUrl,
          description: (req.description || req.referenceId).slice(0, 200),
          reference_1_label: "Reference",
          reference_1: req.referenceId,
        });
        if (email) params.set("email", email);
        if (mobile) params.set("mobile", mobile);
        const bill = await requestJson<BillplzBill>("Billplz", ctx.fetch, `${base}/v3/bills`, {
          method: "POST",
          headers: { authorization: basicAuth(credentials.apiKey), "content-type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        return toBill(bill);
      },
      async getBill(id) {
        return toBill(await fetchBill(ctx.fetch, credentials, id));
      },
      async refund() {
        throw new NotSupportedError("Billplz", "refund");
      },
    };
  },
  async parseWebhook(request: Request, credentials: BillplzCredentials, ctx?: Pick<ProviderContext, "fetch">): Promise<ProviderEvent | null> {
    const fields = await readForm(request);
    const given = fields.x_signature ?? "";
    const expected = await billplzSignature(fields, credentials.xSignatureKey);
    if (!given || !timingSafeEqual(given.toLowerCase(), expected)) throw new WebhookVerificationError("Billplz X Signature mismatch");
    if (!fields.id) return null;
    if (fields.collection_id && fields.collection_id !== credentials.collectionId) return null;
    // The callback does not carry reference_1, so look the bill up (also confirms the state).
    const bill = await fetchBill(webhookFetch(ctx), credentials, fields.id);
    if (!bill.reference_1) return null;
    const paid = fields.paid === "true";
    return {
      event: `payment.${bill.reference_1}`,
      payload: {
        provider: "billplz",
        status: paid ? "paid" : "failed",
        billId: fields.id,
        amount: Number(fields.paid_amount && paid ? fields.paid_amount : fields.amount ?? bill.amount) / 100,
        currency: "MYR",
        referenceId: bill.reference_1,
        paidAt: fields.paid_at || null,
        transactionId: fields.transaction_id ?? null,
      },
    };
  },
};
