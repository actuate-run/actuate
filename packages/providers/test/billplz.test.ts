import { describe, expect, it } from "vitest";
import { WebhookVerificationError } from "../src/contract.js";
import { billplz, billplzSignature } from "../src/index.js";
import { context, failure, formRequest, hmacHex, json, mockFetch } from "./helpers.js";

const creds = billplz.parseCredentials({ apiKey: "73eb57f0-api", collectionId: "inbmmepb", xSignatureKey: "S-xsig-key" });

const apiBill = {
  id: "8X0Iyzaw",
  collection_id: "inbmmepb",
  paid: false,
  state: "due",
  amount: 5000,
  paid_amount: 0,
  url: "https://www.billplz.com/bills/8X0Iyzaw",
  reference_1: "order-7",
};

describe("billplz createBill", () => {
  it("posts a bill with Basic auth and amount in sen", async () => {
    const { fetch, calls } = mockFetch(json(apiBill));
    const bill = await billplz.create(creds, context(fetch)).createBill({
      amount: 50,
      referenceId: "order-7",
      description: "Deposit",
      customer: { name: "Ali", email: "ali@example.com", phone: "+60 12 345 6789" },
    });
    expect(bill).toEqual({ id: "8X0Iyzaw", url: "https://www.billplz.com/bills/8X0Iyzaw", status: "pending", amount: 50, currency: "MYR", referenceId: "order-7" });
    const call = calls[0]!;
    expect(call.url).toBe("https://www.billplz.com/api/v3/bills");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Basic ${btoa("73eb57f0-api:")}`);
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      collection_id: "inbmmepb",
      name: "Ali",
      amount: "5000",
      callback_url: "https://gw.actuate.test/a/act_1/providers/x/webhook",
      redirect_url: "https://gw.actuate.test/return",
      description: "Deposit",
      reference_1_label: "Reference",
      reference_1: "order-7",
      email: "ali@example.com",
      mobile: "60123456789",
    });
  });

  it("uses the sandbox base URL", async () => {
    const { fetch, calls } = mockFetch(json(apiBill));
    await billplz.create({ ...creds, sandbox: true }, context(fetch)).createBill({ amount: 1, referenceId: "r", customer: { email: "a@b.co" } });
    expect(calls[0]!.url).toBe("https://www.billplz-sandbox.com/api/v3/bills");
  });

  it("requires email or mobile, and MYR", async () => {
    const { fetch, calls } = mockFetch(json(apiBill));
    const client = billplz.create(creds, context(fetch));
    await expect(client.createBill({ amount: 1, referenceId: "r" })).rejects.toThrow(/customer.email or customer.phone/);
    await expect(client.createBill({ amount: 1, currency: "SGD", referenceId: "r", customer: { email: "a@b.co" } })).rejects.toThrow(/only supports MYR/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces API errors", async () => {
    const { fetch } = mockFetch(json({ error: { type: "Unauthorized", message: ["Invalid access token"] } }, 401));
    // Billplz error messages may be arrays; fall back to the status text but never throw something unreadable.
    const err = await failure(billplz.create(creds, context(fetch)).createBill({ amount: 1, referenceId: "r", customer: { email: "a@b.co" } }));
    expect(err.message).toMatch(/^Billplz API error \(HTTP 401\)/);
    expect(err.message).toContain("Invalid access token");
  });

  it("validates credentials", () => {
    expect(() => billplz.parseCredentials({ apiKey: "a", collectionId: "b" })).toThrow(/xSignatureKey is required/);
  });
});

describe("billplz getBill and refund", () => {
  it("gets a bill", async () => {
    const { fetch, calls } = mockFetch(json({ ...apiBill, paid: true, state: "paid" }));
    const bill = await billplz.create(creds, context(fetch)).getBill("8X0Iyzaw");
    expect(calls[0]!.url).toBe("https://www.billplz.com/api/v3/bills/8X0Iyzaw");
    expect(calls[0]!.method).toBe("GET");
    expect(bill.status).toBe("paid");
  });

  it("refund is not supported", async () => {
    const { fetch } = mockFetch(json({}));
    await expect(billplz.create(creds, context(fetch)).refund!({ billId: "x" })).rejects.toThrow("refund is not supported by Billplz");
  });
});

describe("billplz webhooks", () => {
  const callback: Record<string, string> = {
    id: "8X0Iyzaw",
    collection_id: "inbmmepb",
    paid: "true",
    state: "paid",
    amount: "5000",
    paid_amount: "5000",
    due_at: "2026-11-2",
    email: "ali@example.com",
    mobile: "",
    name: "ALI",
    url: "https://www.billplz.com/bills/8X0Iyzaw",
    paid_at: "2026-11-02 10:00:00 +0800",
  };

  async function sign(fields: Record<string, string>) {
    // Independent implementation of the documented algorithm.
    const source = Object.keys(fields)
      .map((k) => `${k}${fields[k]}`)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .join("|");
    return { ...fields, x_signature: await hmacHex("S-xsig-key", source) };
  }

  it("matches the documented signature example shape", async () => {
    const fields = { id: "zq0tm2wc", mobile: "", paid: "true" };
    expect(await billplzSignature(fields, "k")).toBe(await hmacHex("k", "idzq0tm2wc|mobile|paidtrue"));
  });

  it("verifies and emits paid, looking up the reference", async () => {
    const { fetch, calls } = mockFetch(json({ ...apiBill, paid: true, state: "paid" }));
    const ev = await billplz.parseWebhook!(formRequest(await sign(callback)), creds, { fetch });
    expect(calls[0]!.url).toBe("https://www.billplz.com/api/v3/bills/8X0Iyzaw");
    expect(ev).toEqual({
      event: "payment.order-7",
      payload: {
        provider: "billplz",
        status: "paid",
        billId: "8X0Iyzaw",
        amount: 50,
        currency: "MYR",
        referenceId: "order-7",
        paidAt: "2026-11-02 10:00:00 +0800",
        transactionId: null,
      },
    });
  });

  it("emits failed for unpaid callbacks", async () => {
    const { fetch } = mockFetch(json(apiBill));
    const ev = await billplz.parseWebhook!(formRequest(await sign({ ...callback, paid: "false", state: "due", paid_amount: "0", paid_at: "" })), creds, {
      fetch,
    });
    expect(ev?.payload).toMatchObject({ status: "failed", amount: 50 });
  });

  it("rejects tampered callbacks", async () => {
    const { fetch, calls } = mockFetch(json(apiBill));
    const signedFields = await sign(callback);
    await expect(billplz.parseWebhook!(formRequest({ ...signedFields, paid_amount: "1" }), creds, { fetch })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
    await expect(billplz.parseWebhook!(formRequest(callback), creds, { fetch })).rejects.toBeInstanceOf(WebhookVerificationError);
    expect(calls).toHaveLength(0);
  });

  it("ignores callbacks for another collection", async () => {
    const { fetch } = mockFetch(json(apiBill));
    expect(await billplz.parseWebhook!(formRequest(await sign({ ...callback, collection_id: "other" })), creds, { fetch })).toBeNull();
  });
});
