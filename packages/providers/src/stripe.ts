// Docs: https://docs.stripe.com/api/checkout/sessions/create (webhooks: https://docs.stripe.com/webhooks#verify-manually)
import { z } from "zod";
import {
  WebhookVerificationError,
  hmacSha256Hex,
  timingSafeEqual,
  type ProviderDefinition,
} from "./contract.js";
import type { Bill, PaymentProvider } from "@actuate/sdk";
import { type ProviderDefinitionWithWebhookLookup, formEncode, fromMinor, normaliseCurrency, optionalString, parseWith, requestJson, toMinor } from "./util.js";

const API = "https://api.stripe.com/v1";
/** Same default as Stripe's own libraries. */
export const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300;

const schema = z.object({
  secretKey: z
    .string({ error: "secretKey is required" })
    .trim()
    .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, "secretKey must be a Stripe secret or restricted key (sk_live_..., sk_test_..., rk_...)"),
  webhookSecret: optionalString().refine((v) => v === undefined || v.startsWith("whsec_"), 'webhookSecret must start with "whsec_"'),
});
export type StripeCredentials = z.output<typeof schema>;

interface CheckoutSession {
  id: string;
  object: "checkout.session";
  url: string | null;
  status: "open" | "complete" | "expired" | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  metadata?: Record<string, string> | null;
  payment_intent?: string | { id: string } | null;
}

function sessionStatus(s: CheckoutSession): Bill["status"] {
  if (s.payment_status === "paid" || s.payment_status === "no_payment_required") return "paid";
  if (s.status === "expired") return "expired";
  return "pending";
}

function toBill(s: CheckoutSession): Bill {
  const currency = (s.currency ?? "").toUpperCase();
  return {
    id: s.id,
    url: s.url ?? "",
    status: sessionStatus(s),
    amount: s.amount_total == null ? 0 : fromMinor(s.amount_total, currency || "USD"),
    currency,
    referenceId: s.metadata?.actuate_reference_id ?? s.client_reference_id ?? "",
  };
}

/** Verify a Stripe-Signature header against the raw body. Exported for tests and reuse. */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  tolerance = STRIPE_TIMESTAMP_TOLERANCE_SECONDS,
): Promise<void> {
  if (!header) throw new WebhookVerificationError("Missing Stripe-Signature header");
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t") timestamp = Number(value);
    else if (key === "v1") signatures.push(value); // ignore v0 and other schemes (downgrade protection)
  }
  if (timestamp === undefined || !Number.isInteger(timestamp) || signatures.length === 0) {
    throw new WebhookVerificationError("Malformed Stripe-Signature header");
  }
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  if (!signatures.some((sig) => timingSafeEqual(sig, expected))) throw new WebhookVerificationError("Stripe signature mismatch");
  if (Math.abs(nowSeconds - timestamp) > tolerance) throw new WebhookVerificationError("Stripe webhook timestamp outside the tolerance window");
}

const EVENT_STATUS: Record<string, "paid" | "failed" | "expired" | undefined> = {
  "checkout.session.async_payment_succeeded": "paid",
  "checkout.session.async_payment_failed": "failed",
  "checkout.session.expired": "expired",
};

export const stripe: ProviderDefinitionWithWebhookLookup<StripeCredentials, "payment"> = {
  kind: "stripe",
  capability: "payment",
  label: "Stripe",
  credentialFields: [
    { key: "secretKey", label: "Secret key", secret: true, help: "sk_live_... or a restricted key with Checkout Sessions and Refunds write access." },
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      secret: true,
      optional: true,
      help: "whsec_... from a webhook endpoint pointing at this actuator's provider webhook URL, subscribed to checkout.session.* events.",
    },
  ],
  parseCredentials: (input) => parseWith("Stripe", schema, input),
  create(credentials, ctx): PaymentProvider {
    const auth = { authorization: `Bearer ${credentials.secretKey}` };
    const post = <T>(path: string, data: Record<string, unknown>, idempotencyKey?: string) =>
      requestJson<T>("Stripe", ctx.fetch, `${API}${path}`, {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/x-www-form-urlencoded",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: formEncode(data),
      });
    const getSession = (id: string) =>
      requestJson<CheckoutSession>("Stripe", ctx.fetch, `${API}/checkout/sessions/${encodeURIComponent(id)}`, { method: "GET", headers: auth });

    return {
      async createBill(req) {
        const currency = normaliseCurrency(req.currency);
        if (!req.referenceId) throw new Error("referenceId is required");
        const returnUrl = req.returnUrl ?? ctx.defaultReturnUrl;
        const session = await post<CheckoutSession>(
          "/checkout/sessions",
          {
            mode: "payment",
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: currency.toLowerCase(),
                  unit_amount: toMinor(req.amount, currency),
                  product_data: { name: req.description || req.referenceId },
                },
              },
            ],
            success_url: returnUrl,
            cancel_url: returnUrl,
            client_reference_id: req.referenceId,
            customer_email: req.customer?.email,
            metadata: { actuate_reference_id: req.referenceId },
            payment_intent_data: { metadata: { actuate_reference_id: req.referenceId } },
          },
          req.idempotencyKey,
        );
        return toBill(session);
      },
      async getBill(id) {
        return toBill(await getSession(id));
      },
      async refund(req) {
        const session = await getSession(req.billId);
        const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
        if (!pi) throw new Error(`Stripe checkout session ${req.billId} has no payment to refund`);
        const currency = (session.currency ?? "usd").toUpperCase();
        const refund = await post<{ id: string; status: string }>(
          "/refunds",
          {
            payment_intent: pi,
            amount: req.amount === undefined ? undefined : toMinor(req.amount, currency),
            metadata: req.reason ? { reason: req.reason.slice(0, 500) } : undefined,
          },
          req.idempotencyKey,
        );
        const status = refund.status === "succeeded" ? "succeeded" : refund.status === "failed" || refund.status === "canceled" ? "failed" : "pending";
        return { id: refund.id, status };
      },
    };
  },
  async parseWebhook(request, credentials) {
    if (!credentials.webhookSecret) throw new WebhookVerificationError("Stripe webhook signing secret is not configured");
    const raw = await request.text();
    await verifyStripeSignature(raw, request.headers.get("stripe-signature"), credentials.webhookSecret);
    let event: { id: string; type: string; data?: { object?: CheckoutSession } };
    try {
      event = JSON.parse(raw);
    } catch {
      throw new WebhookVerificationError("Stripe webhook body is not JSON");
    }
    const session = event.data?.object;
    if (!session || session.object !== "checkout.session") return null;
    let status = EVENT_STATUS[event.type];
    if (event.type === "checkout.session.completed") {
      // Delayed methods (e.g. FPX on some flows) complete as "unpaid" and follow with async_payment_*.
      if (session.payment_status === "paid" || session.payment_status === "no_payment_required") status = "paid";
      else return null;
    }
    if (!status) return null;
    // Only the metadata createBill sets. A buyer can choose client_reference_id themselves (Payment Links
    // and pricing tables take it from the URL), which would let any cheap payment on the account mark
    // someone else's reference as paid.
    const referenceId = session.metadata?.actuate_reference_id;
    if (!referenceId) return null; // not a session createBill made
    const bill = toBill(session);
    return {
      event: `payment.${referenceId}`,
      payload: {
        provider: "stripe",
        status,
        billId: session.id,
        amount: bill.amount,
        currency: bill.currency,
        referenceId,
        providerEventId: event.id,
        providerEventType: event.type,
      },
    };
  },
};
