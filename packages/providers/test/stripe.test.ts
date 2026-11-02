import { describe, expect, it } from "vitest";
import { WebhookVerificationError } from "../src/contract.js";
import { stripe } from "../src/index.js";
import { context, hmacHex, json, jsonRequest, mockFetch } from "./helpers.js";

const creds = stripe.parseCredentials({ secretKey: "sk_test_abc123", webhookSecret: "whsec_testsecret" });

const session = {
  id: "cs_test_1",
  object: "checkout.session",
  url: "https://checkout.stripe.com/c/pay/cs_test_1",
  status: "open",
  payment_status: "unpaid",
  amount_total: 5000,
  currency: "myr",
  client_reference_id: "order-7",
  metadata: { actuate_reference_id: "order-7" },
  payment_intent: null,
};

async function signed(body: string, secret = "whsec_testsecret", t = Math.floor(Date.now() / 1000)) {
  return jsonRequest(body, { "stripe-signature": `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)},v0=deadbeef` });
}

function event(type: string, object: Record<string, unknown>) {
  return JSON.stringify({ id: "evt_1", object: "event", type, data: { object: { ...session, ...object } } });
}

describe("stripe createBill", () => {
  it("creates a Checkout Session with form-encoded params", async () => {
    const { fetch, calls } = mockFetch(json(session));
    const bill = await stripe.create(creds, context(fetch)).createBill({
      amount: 50,
      referenceId: "order-7",
      description: "Deposit",
      customer: { email: "ali@example.com" },
      idempotencyKey: "idem-1",
    });
    expect(bill).toEqual({
      id: "cs_test_1",
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
      status: "pending",
      amount: 50,
      currency: "MYR",
      referenceId: "order-7",
    });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer sk_test_abc123");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.headers["idempotency-key"]).toBe("idem-1");
    const params = Object.fromEntries(new URLSearchParams(call.body));
    expect(params).toEqual({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "myr",
      "line_items[0][price_data][unit_amount]": "5000",
      "line_items[0][price_data][product_data][name]": "Deposit",
      success_url: "https://gw.actuate.test/return",
      cancel_url: "https://gw.actuate.test/return",
      client_reference_id: "order-7",
      customer_email: "ali@example.com",
      "metadata[actuate_reference_id]": "order-7",
      "payment_intent_data[metadata][actuate_reference_id]": "order-7",
    });
  });

  it("handles zero-decimal currencies", async () => {
    const { fetch, calls } = mockFetch(json({ ...session, currency: "jpy", amount_total: 500 }));
    const bill = await stripe.create(creds, context(fetch)).createBill({ amount: 500, currency: "jpy", referenceId: "r" });
    expect(new URLSearchParams(calls[0]!.body).get("line_items[0][price_data][unit_amount]")).toBe("500");
    expect(bill.amount).toBe(500);
  });

  it("rejects invalid amounts before calling the API", async () => {
    const { fetch, calls } = mockFetch(json(session));
    await expect(stripe.create(creds, context(fetch)).createBill({ amount: -1, referenceId: "r" })).rejects.toThrow(/positive number/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces Stripe errors", async () => {
    const { fetch } = mockFetch(json({ error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_****123" } }, 401));
    await expect(stripe.create(creds, context(fetch)).createBill({ amount: 1, referenceId: "r" })).rejects.toThrow(
      "Stripe API error (HTTP 401): Invalid API Key provided: sk_test_****123",
    );
  });
});

describe("stripe getBill and refund", () => {
  it("gets a session", async () => {
    const { fetch, calls } = mockFetch(json({ ...session, status: "complete", payment_status: "paid" }));
    const bill = await stripe.create(creds, context(fetch)).getBill("cs_test_1");
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_1");
    expect(calls[0]!.method).toBe("GET");
    expect(bill.status).toBe("paid");
  });

  it("refunds through the session's payment intent", async () => {
    const { fetch, calls } = mockFetch(json({ ...session, payment_intent: "pi_123" }), json({ id: "re_1", status: "succeeded" }));
    const result = await stripe.create(creds, context(fetch)).refund!({ billId: "cs_test_1", amount: 20.5, reason: "late", idempotencyKey: "k" });
    expect(result).toEqual({ id: "re_1", status: "succeeded" });
    expect(calls[1]!.url).toBe("https://api.stripe.com/v1/refunds");
    expect(calls[1]!.headers["idempotency-key"]).toBe("k");
    expect(Object.fromEntries(new URLSearchParams(calls[1]!.body))).toEqual({ payment_intent: "pi_123", amount: "2050", "metadata[reason]": "late" });
  });

  it("refuses to refund an unpaid session", async () => {
    const { fetch } = mockFetch(json(session));
    await expect(stripe.create(creds, context(fetch)).refund!({ billId: "cs_test_1" })).rejects.toThrow(/no payment to refund/);
  });
});

describe("stripe credentials", () => {
  it("validates keys", () => {
    expect(() => stripe.parseCredentials({ secretKey: "pk_live_123" })).toThrow(/secretKey must be a Stripe secret/);
    expect(() => stripe.parseCredentials({ secretKey: "sk_live_1", webhookSecret: "nope" })).toThrow(/webhookSecret must start with "whsec_"/);
    expect(stripe.parseCredentials({ secretKey: " sk_live_1 ", webhookSecret: "" })).toEqual({ secretKey: "sk_live_1", webhookSecret: undefined });
  });
});

describe("stripe webhooks", () => {
  it("maps checkout.session.completed (paid)", async () => {
    const body = event("checkout.session.completed", { status: "complete", payment_status: "paid" });
    const ev = await stripe.parseWebhook!(await signed(body), creds);
    expect(ev).toEqual({
      event: "payment.order-7",
      payload: {
        provider: "stripe",
        status: "paid",
        billId: "cs_test_1",
        amount: 50,
        currency: "MYR",
        referenceId: "order-7",
        providerEventId: "evt_1",
        providerEventType: "checkout.session.completed",
      },
    });
  });

  it("maps async success, async failure and expiry", async () => {
    const s = await stripe.parseWebhook!(await signed(event("checkout.session.async_payment_succeeded", { payment_status: "paid" })), creds);
    expect(s?.payload).toMatchObject({ status: "paid" });
    const f = await stripe.parseWebhook!(await signed(event("checkout.session.async_payment_failed", {})), creds);
    expect(f?.payload).toMatchObject({ status: "failed" });
    const e = await stripe.parseWebhook!(await signed(event("checkout.session.expired", { status: "expired" })), creds);
    expect(e?.payload).toMatchObject({ status: "expired" });
  });

  it("ignores completed-but-unpaid sessions and irrelevant events", async () => {
    expect(await stripe.parseWebhook!(await signed(event("checkout.session.completed", { payment_status: "unpaid" })), creds)).toBeNull();
    const other = JSON.stringify({ id: "evt_2", type: "customer.created", data: { object: { id: "cus_1", object: "customer" } } });
    expect(await stripe.parseWebhook!(await signed(other), creds)).toBeNull();
  });

  it("rejects tampered bodies, wrong secrets and missing headers", async () => {
    const body = event("checkout.session.completed", { payment_status: "paid" });
    const req = await signed(body);
    const tampered = jsonRequest(body.replace("order-7", "order-8"), { "stripe-signature": req.headers.get("stripe-signature")! });
    await expect(stripe.parseWebhook!(tampered, creds)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(stripe.parseWebhook!(await signed(body, "whsec_other"), creds)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(stripe.parseWebhook!(jsonRequest(body), creds)).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("ignores v0 signatures (downgrade protection)", async () => {
    const body = event("checkout.session.completed", { payment_status: "paid" });
    const t = Math.floor(Date.now() / 1000);
    const req = jsonRequest(body, { "stripe-signature": `t=${t},v0=${await hmacHex("whsec_testsecret", `${t}.${body}`)}` });
    await expect(stripe.parseWebhook!(req, creds)).rejects.toThrow(/Malformed/);
  });

  it("rejects a stale timestamp", async () => {
    const body = event("checkout.session.completed", { payment_status: "paid" });
    const stale = await signed(body, "whsec_testsecret", Math.floor(Date.now() / 1000) - 301);
    await expect(stripe.parseWebhook!(stale, creds)).rejects.toThrow(/tolerance/);
  });

  it("rejects webhooks when no signing secret is configured", async () => {
    const noSecret = stripe.parseCredentials({ secretKey: "sk_test_1" });
    await expect(stripe.parseWebhook!(await signed("{}"), noSecret)).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});
