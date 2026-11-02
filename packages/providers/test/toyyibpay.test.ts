import { describe, expect, it } from "vitest";
import { WebhookVerificationError } from "../src/contract.js";
import { toyyibpay } from "../src/index.js";
import { context, formRequest, json, mockFetch, text } from "./helpers.js";

const creds = toyyibpay.parseCredentials({ userSecretKey: "usk-secret", categoryCode: "cat123" });
const sandbox = toyyibpay.parseCredentials({ userSecretKey: "usk-secret", categoryCode: "cat123", sandbox: "true" });

const paidTx = [{ billName: "Deposit", billpaymentStatus: "1", billpaymentAmount: "50.00", billExternalReferenceNo: "order-7", billpaymentInvoiceNo: "TP123" }];

describe("toyyibpay createBill", () => {
  it("posts a form with amount in sen and the webhook callback", async () => {
    const { fetch, calls } = mockFetch(json([{ BillCode: "gcbhict9" }]));
    const bill = await toyyibpay.create(creds, context(fetch)).createBill({
      amount: 50,
      referenceId: "order-7",
      description: "Deposit: table #4 (Sat)",
      customer: { name: "Ali", email: "ali@example.com", phone: "+60 12-345 6789" },
      returnUrl: "https://shop.test/thanks",
    });
    expect(bill).toEqual({ id: "gcbhict9", url: "https://toyyibpay.com/gcbhict9", status: "pending", amount: 50, currency: "MYR", referenceId: "order-7" });
    const call = calls[0]!;
    expect(call.url).toBe("https://toyyibpay.com/index.php/api/createBill");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      userSecretKey: "usk-secret",
      categoryCode: "cat123",
      billName: "Deposit table 4 Sat",
      billDescription: "Deposit table 4 Sat",
      billPriceSetting: "1",
      billPayorInfo: "1",
      billAmount: "5000",
      billReturnUrl: "https://shop.test/thanks",
      billCallbackUrl: "https://gw.actuate.test/a/act_1/providers/x/webhook",
      billExternalReferenceNo: "order-7",
      billTo: "Ali",
      billEmail: "ali@example.com",
      billPhone: "60123456789",
      billPaymentChannel: "0",
    });
  });

  it("uses the dev base URL in sandbox mode", async () => {
    const { fetch, calls } = mockFetch(json([{ BillCode: "abc" }]));
    const bill = await toyyibpay.create(sandbox, context(fetch)).createBill({ amount: 1, referenceId: "r" });
    expect(calls[0]!.url).toBe("https://dev.toyyibpay.com/index.php/api/createBill");
    expect(bill.url).toBe("https://dev.toyyibpay.com/abc");
  });

  it("rejects non-MYR and sub-RM1 amounts", async () => {
    const { fetch, calls } = mockFetch(json([]));
    const client = toyyibpay.create(creds, context(fetch));
    await expect(client.createBill({ amount: 5, currency: "USD", referenceId: "r" })).rejects.toThrow(/only supports MYR/);
    await expect(client.createBill({ amount: 0.5, referenceId: "r" })).rejects.toThrow(/at least RM 1.00/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces 200-status error bodies", async () => {
    const a = mockFetch(text("[KEY-DID-NOT-EXIST]"));
    await expect(toyyibpay.create(creds, context(a.fetch)).createBill({ amount: 5, referenceId: "r" })).rejects.toThrow(
      "ToyyibPay API error (HTTP 200): [KEY-DID-NOT-EXIST]",
    );
    const b = mockFetch(json({ status: "error", msg: "billName parameter is empty" }));
    await expect(toyyibpay.create(creds, context(b.fetch)).createBill({ amount: 5, referenceId: "r" })).rejects.toThrow(/billName parameter is empty/);
  });

  it("validates credentials", () => {
    expect(() => toyyibpay.parseCredentials({ userSecretKey: "x" })).toThrow(/categoryCode is required/);
    expect(() => toyyibpay.parseCredentials({ userSecretKey: "x", categoryCode: "y", paymentChannel: "9" })).toThrow(/paymentChannel/);
  });
});

describe("toyyibpay getBill and refund", () => {
  it("reads status from getBillTransactions", async () => {
    const { fetch, calls } = mockFetch(json(paidTx));
    const bill = await toyyibpay.create(creds, context(fetch)).getBill("gcbhict9");
    expect(calls[0]!.url).toBe("https://toyyibpay.com/index.php/api/getBillTransactions");
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ billCode: "gcbhict9", userSecretKey: "usk-secret" });
    expect(bill).toEqual({ id: "gcbhict9", url: "https://toyyibpay.com/gcbhict9", status: "paid", amount: 50, currency: "MYR", referenceId: "order-7" });
  });

  it("refund is not supported", async () => {
    const { fetch } = mockFetch(json([]));
    await expect(toyyibpay.create(creds, context(fetch)).refund!({ billId: "x" })).rejects.toThrow("refund is not supported by ToyyibPay");
  });
});

describe("toyyibpay webhooks", () => {
  const callback = { refno: "TP123", status: "1", reason: "Approved", billcode: "gcbhict9", order_id: "order-7", amount: "50.00" };

  it("re-queries the bill and emits paid", async () => {
    const { fetch, calls } = mockFetch(json(paidTx));
    const ev = await toyyibpay.parseWebhook!(formRequest(callback), creds, { fetch });
    expect(calls[0]!.url).toBe("https://toyyibpay.com/index.php/api/getBillTransactions");
    expect(ev).toEqual({
      event: "payment.order-7",
      payload: { provider: "toyyibpay", status: "paid", billId: "gcbhict9", amount: 50, currency: "MYR", referenceId: "order-7", transactionRef: "TP123" },
    });
  });

  it("trusts the re-query over the callback (forged success)", async () => {
    const { fetch } = mockFetch(json([{ ...paidTx[0], billpaymentStatus: "3" }]));
    const ev = await toyyibpay.parseWebhook!(formRequest(callback), creds, { fetch });
    expect(ev?.payload).toMatchObject({ status: "failed" });
  });

  it("rejects callbacks for bills with no transactions on this account", async () => {
    const { fetch } = mockFetch(json([]));
    await expect(toyyibpay.parseWebhook!(formRequest(callback), creds, { fetch })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(toyyibpay.parseWebhook!(formRequest({ status: "1" }), creds, { fetch })).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("returns null while pending", async () => {
    const { fetch } = mockFetch(json([{ ...paidTx[0], billpaymentStatus: "2" }]));
    expect(await toyyibpay.parseWebhook!(formRequest({ ...callback, status: "2" }), creds, { fetch })).toBeNull();
  });
});
