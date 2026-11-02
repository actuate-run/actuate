import { beforeAll, describe, expect, it } from "vitest";
import { WebhookVerificationError } from "../src/contract.js";
import { chip } from "../src/index.js";
import type { ChipCredentials } from "../src/chip.js";
import { context, json, jsonRequest, mockFetch } from "./helpers.js";

const BRAND = "409eb80e-3782-4b1d-afa8-b779759266a5";

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

/** Extract the PKCS#1 RSAPublicKey from an SPKI (skip SEQ header, AlgorithmIdentifier, BIT STRING header + unused-bits byte). */
function spkiToPkcs1(spki: Uint8Array): Uint8Array {
  let i = 0;
  const readLen = () => {
    let len = spki[i++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | spki[i++]!;
    }
    return len;
  };
  i++; // SEQUENCE
  readLen();
  i++; // AlgorithmIdentifier SEQUENCE
  const algLen = readLen();
  i += algLen;
  i++; // BIT STRING
  const len = readLen();
  return spki.slice(i + 1, i + len);
}

let keys: CryptoKeyPair;
let creds: ChipCredentials;
let spkiDer: ArrayBuffer;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  spkiDer = (await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer;
  creds = chip.parseCredentials({ brandId: BRAND, secretKey: "chip-secret", publicKey: toPem(spkiDer, "PUBLIC KEY") });
});

async function signedRequest(body: string, key = keys.privateKey) {
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return jsonRequest(body, { "x-signature": btoa(String.fromCharCode(...new Uint8Array(sig))) });
}

const purchase = {
  id: "d6c9c6a3-1111-4e4e-9c59-000000000001",
  type: "purchase",
  brand_id: BRAND,
  status: "created",
  checkout_url: "https://gate.chip-in.asia/p/d6c9c6a3/",
  reference: "order-7",
  purchase: { currency: "MYR", total: 5000, products: [{ name: "Deposit", price: 5000 }] },
};

describe("chip createBill", () => {
  it("creates a purchase", async () => {
    const { fetch, calls } = mockFetch(json(purchase, 201));
    const bill = await chip.create(creds, context(fetch)).createBill({
      amount: 50,
      referenceId: "order-7",
      description: "Deposit",
      customer: { email: "ali@example.com", name: "Ali" },
    });
    expect(bill).toEqual({ id: purchase.id, url: purchase.checkout_url, status: "pending", amount: 50, currency: "MYR", referenceId: "order-7" });
    const call = calls[0]!;
    expect(call.url).toBe("https://gate.chip-in.asia/api/v1/purchases/");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer chip-secret");
    expect(JSON.parse(call.body)).toEqual({
      brand_id: BRAND,
      reference: "order-7",
      client: { email: "ali@example.com", full_name: "Ali" },
      purchase: { currency: "MYR", products: [{ name: "Deposit", price: 5000 }] },
      success_callback: "https://gw.actuate.test/a/act_1/providers/x/webhook",
      success_redirect: "https://gw.actuate.test/return",
      failure_redirect: "https://gw.actuate.test/return",
      cancel_redirect: "https://gw.actuate.test/return",
    });
  });

  it("requires a customer email", async () => {
    const { fetch } = mockFetch(json(purchase));
    await expect(chip.create(creds, context(fetch)).createBill({ amount: 1, referenceId: "r" })).rejects.toThrow(/customer.email/);
  });

  it("surfaces field errors", async () => {
    const { fetch } = mockFetch(json({ brand_id: [{ message: "Object with id=x does not exist.", code: "does_not_exist" }] }, 400));
    await expect(chip.create(creds, context(fetch)).createBill({ amount: 1, referenceId: "r", customer: { email: "a@b.co" } })).rejects.toThrow(
      "CHIP API error (HTTP 400): brand_id: Object with id=x does not exist.",
    );
  });

  it("validates credentials", () => {
    expect(() => chip.parseCredentials({ brandId: "nope", secretKey: "s", publicKey: "x" })).toThrow(/brandId must be the Brand ID/);
    expect(() => chip.parseCredentials({ brandId: BRAND, secretKey: "s", publicKey: "not a pem" })).toThrow(/publicKey must be a PEM/);
  });
});

describe("chip getBill and refund", () => {
  it("gets a purchase", async () => {
    const { fetch, calls } = mockFetch(json({ ...purchase, status: "paid" }));
    const bill = await chip.create(creds, context(fetch)).getBill(purchase.id);
    expect(calls[0]!.url).toBe(`https://gate.chip-in.asia/api/v1/purchases/${purchase.id}/`);
    expect(bill.status).toBe("paid");
  });

  it("refunds in full and in part", async () => {
    const full = mockFetch(json({ id: "pay_1", status: "success" }));
    expect(await chip.create(creds, context(full.fetch)).refund!({ billId: purchase.id })).toEqual({ id: "pay_1", status: "succeeded" });
    expect(full.calls[0]!.url).toBe(`https://gate.chip-in.asia/api/v1/purchases/${purchase.id}/refund/`);
    expect(JSON.parse(full.calls[0]!.body)).toEqual({});

    const part = mockFetch(json(purchase), json({ id: purchase.id, status: "pending_refund" }));
    expect(await chip.create(creds, context(part.fetch)).refund!({ billId: purchase.id, amount: 10 })).toEqual({ id: purchase.id, status: "pending" });
    expect(JSON.parse(part.calls[1]!.body)).toEqual({ amount: 1000 });
  });
});

describe("chip webhooks", () => {
  it("verifies the RSA signature and emits paid", async () => {
    const body = JSON.stringify({ ...purchase, status: "paid", event_type: "purchase.paid" });
    const ev = await chip.parseWebhook!(await signedRequest(body), creds);
    expect(ev).toEqual({
      event: "payment.order-7",
      payload: { provider: "chip", status: "paid", billId: purchase.id, amount: 50, currency: "MYR", referenceId: "order-7", providerEventType: "purchase.paid" },
    });
  });

  it("accepts a PKCS#1 (BEGIN RSA PUBLIC KEY) key", async () => {
    const pkcs1 = chip.parseCredentials({ brandId: BRAND, secretKey: "s", publicKey: toPem(spkiToPkcs1(new Uint8Array(spkiDer)).slice().buffer as ArrayBuffer, "RSA PUBLIC KEY") });
    const body = JSON.stringify({ ...purchase, status: "error" });
    expect((await chip.parseWebhook!(await signedRequest(body), pkcs1))?.payload).toMatchObject({ status: "failed" });
  });

  it("rejects tampered bodies, other keys and missing signatures", async () => {
    const body = JSON.stringify({ ...purchase, status: "paid" });
    const req = await signedRequest(body);
    const tampered = jsonRequest(body.replace("5000", "1"), { "x-signature": req.headers.get("x-signature")! });
    await expect(chip.parseWebhook!(tampered, creds)).rejects.toBeInstanceOf(WebhookVerificationError);
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    await expect(chip.parseWebhook!(await signedRequest(body, other.privateKey), creds)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(chip.parseWebhook!(jsonRequest(body), creds)).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("ignores irrelevant events", async () => {
    expect(await chip.parseWebhook!(await signedRequest(JSON.stringify({ ...purchase, status: "viewed" })), creds)).toBeNull();
    expect(await chip.parseWebhook!(await signedRequest(JSON.stringify({ id: "p", type: "payment", status: "paid" })), creds)).toBeNull();
    expect(await chip.parseWebhook!(await signedRequest(JSON.stringify({ ...purchase, status: "paid", brand_id: "other" })), creds)).toBeNull();
  });
});
