// Docs: https://docs.chip-in.asia/chip-collect/api-reference/purchases/create (signatures: https://docs.chip-in.asia/chip-collect/overview/webhook-signatures)
import { z } from "zod";
import { WebhookVerificationError, type ProviderDefinition } from "./contract.js";
import type { Bill, PaymentProvider } from "@actuate/sdk";
import { type ProviderDefinitionWithWebhookLookup, base64ToBytes, fromMinor, normaliseCurrency, parseWith, requestJson, requiredString, toMinor } from "./util.js";

const API = "https://gate.chip-in.asia/api/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const schema = z.object({
  brandId: z.string({ error: "brandId is required" }).trim().regex(UUID, "brandId must be the Brand ID (a UUID) from the CHIP portal"),
  secretKey: requiredString("secretKey"),
  publicKey: z
    .string({ error: "publicKey is required" })
    .trim()
    .refine((v) => /-----BEGIN (RSA )?PUBLIC KEY-----/.test(v), "publicKey must be a PEM public key (-----BEGIN PUBLIC KEY-----)"),
});
export type ChipCredentials = z.output<typeof schema>;

interface Purchase {
  id: string;
  type?: string;
  event_type?: string;
  status: string;
  checkout_url?: string;
  reference?: string | null;
  purchase?: { total?: number; currency?: string };
}

const PAID = new Set(["paid", "settled", "cleared"]);
const FAILED = new Set(["error", "blocked", "cancelled"]);

function purchaseStatus(status: string): Bill["status"] {
  if (PAID.has(status)) return "paid";
  if (FAILED.has(status)) return "failed";
  if (status === "expired" || status === "overdue") return "expired";
  if (status === "refunded") return "refunded";
  return "pending";
}

function toBill(p: Purchase): Bill {
  const currency = (p.purchase?.currency ?? "MYR").toUpperCase();
  return {
    id: p.id,
    url: p.checkout_url ?? "",
    status: purchaseStatus(p.status),
    amount: p.purchase?.total == null ? 0 : fromMinor(p.purchase.total, currency),
    currency,
    referenceId: p.reference ?? "",
  };
}

// --- RSA public key import (SPKI, or PKCS#1 wrapped into SPKI) ---

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** Wrap a PKCS#1 RSAPublicKey in a SubjectPublicKeyInfo so WebCrypto can import it. */
function pkcs1ToSpki(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const bitString = [0x03, ...derLength(pkcs1.length + 1), 0x00, ...pkcs1];
  const body = [...algId, ...bitString];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

export function importChipPublicKey(pem: string): Promise<CryptoKey> {
  let cached = keyCache.get(pem);
  if (!cached) {
    const isPkcs1 = pem.includes("BEGIN RSA PUBLIC KEY");
    const b64 = pem.replace(/-----(BEGIN|END) (RSA )?PUBLIC KEY-----/g, "").replace(/\s+/g, "");
    const der = base64ToBytes(b64);
    cached = crypto.subtle.importKey("spki", isPkcs1 ? pkcs1ToSpki(der) : der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    cached.catch(() => keyCache.delete(pem));
    keyCache.set(pem, cached);
  }
  return cached;
}

export const chip: ProviderDefinitionWithWebhookLookup<ChipCredentials, "payment"> = {
  kind: "chip",
  capability: "payment",
  label: "CHIP Collect",
  credentialFields: [
    { key: "brandId", label: "Brand ID", secret: false },
    { key: "secretKey", label: "Secret key", secret: true, help: "Use a test key for sandbox; the API URL is the same." },
    {
      key: "publicKey",
      label: "Public key (PEM)",
      secret: false,
      help: "For success callbacks: the PEM from GET /public_key/. For a webhook you registered: its public_key.",
    },
  ],
  parseCredentials: (input) => parseWith("CHIP", schema, input),
  create(credentials, ctx): PaymentProvider {
    const headers = { authorization: `Bearer ${credentials.secretKey}`, "content-type": "application/json" };
    return {
      async createBill(req) {
        const currency = normaliseCurrency(req.currency);
        if (!req.referenceId) throw new Error("referenceId is required");
        const email = req.customer?.email;
        if (!email) throw new Error("CHIP needs customer.email");
        const returnUrl = req.returnUrl ?? ctx.defaultReturnUrl;
        const purchase = await requestJson<Purchase>("CHIP", ctx.fetch, `${API}/purchases/`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            brand_id: credentials.brandId,
            reference: req.referenceId,
            client: {
              email,
              ...(req.customer?.name ? { full_name: req.customer.name } : {}),
              ...(req.customer?.phone ? { phone: req.customer.phone } : {}),
            },
            purchase: {
              currency,
              products: [{ name: (req.description || req.referenceId).slice(0, 256), price: toMinor(req.amount, currency) }],
            },
            success_callback: ctx.webhookUrl,
            success_redirect: returnUrl,
            failure_redirect: returnUrl,
            cancel_redirect: returnUrl,
          }),
        });
        return toBill(purchase);
      },
      async getBill(id) {
        return toBill(await requestJson<Purchase>("CHIP", ctx.fetch, `${API}/purchases/${encodeURIComponent(id)}/`, { method: "GET", headers }));
      },
      async refund(req) {
        let body: Record<string, number> = {};
        if (req.amount !== undefined) {
          const current = await requestJson<Purchase>("CHIP", ctx.fetch, `${API}/purchases/${encodeURIComponent(req.billId)}/`, { method: "GET", headers });
          body = { amount: toMinor(req.amount, current.purchase?.currency ?? "MYR") };
        }
        const res = await requestJson<{ id: string; status?: string }>("CHIP", ctx.fetch, `${API}/purchases/${encodeURIComponent(req.billId)}/refund/`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        // A slow acquirer answers with the Purchase in pending_refund; otherwise a Payment object.
        const status = res.status === "pending_refund" ? "pending" : res.status === "error" || res.status === "failed" ? "failed" : "succeeded";
        return { id: res.id, status };
      },
    };
  },
  async parseWebhook(request, credentials) {
    const raw = new Uint8Array(await request.arrayBuffer());
    const header = request.headers.get("x-signature");
    if (!header) throw new WebhookVerificationError("Missing CHIP X-Signature header");
    let signature: Uint8Array<ArrayBuffer>;
    try {
      signature = base64ToBytes(header);
    } catch {
      throw new WebhookVerificationError("CHIP X-Signature is not base64");
    }
    const key = await importChipPublicKey(credentials.publicKey);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, raw);
    if (!ok) throw new WebhookVerificationError("CHIP signature mismatch");
    let body: Purchase;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new WebhookVerificationError("CHIP webhook body is not JSON");
    }
    // Only Purchase payloads for this brand map to payment events (payment.* events carry Payment objects).
    if (body.type !== undefined && body.type !== "purchase") return null;
    if ((body as { brand_id?: string }).brand_id && (body as { brand_id?: string }).brand_id !== credentials.brandId) return null;
    const status = purchaseStatus(body.status);
    if (status === "pending" || !body.reference) return null;
    const bill = toBill(body);
    return {
      event: `payment.${body.reference}`,
      payload: {
        provider: "chip",
        status,
        billId: body.id,
        amount: bill.amount,
        currency: bill.currency,
        referenceId: body.reference,
        providerEventType: body.event_type ?? null,
      },
    };
  },
};
