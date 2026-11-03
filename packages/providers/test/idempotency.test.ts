/**
 * Idempotency keys reach the provider where its API deduplicates (Stripe, Resend, Discord bot messages),
 * and stay distinct when they have to be shortened. Inside a step the runtime supplies a key per call
 * (`<runId>:<step>:<method>:<n>`); these tests pass such keys directly.
 */
import { describe, expect, it } from "vitest";
import { billplz, chip, combineMessaging, discord, resend, slack, stripe, telegram, toyyibpay, whatsapp } from "../src/index.js";
import { fitIdempotencyKey } from "../src/util.js";
import { context, json, mockFetch } from "./helpers.js";

const stepKey = "run_019a4b2c3d4e5f60718293a4b5c6d7e8:refund";
const session = { id: "cs_1", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_1", status: "open", payment_status: "paid", amount_total: 5000, currency: "myr", metadata: { actuate_reference_id: "r" }, payment_intent: "pi_1" };

describe("fitIdempotencyKey", () => {
  it("passes short keys through and shortens long ones without merging keys that differ at the end", async () => {
    expect(await fitIdempotencyKey("k", 255)).toBe("k");
    const long = `${"s".repeat(300)}:send:`;
    const [a, b] = [await fitIdempotencyKey(`${long}0`, 255), await fitIdempotencyKey(`${long}1`, 255)];
    expect(a).toHaveLength(255);
    expect(b).toHaveLength(255);
    expect(a).not.toBe(b);
    expect(await fitIdempotencyKey(`${long}0`, 255)).toBe(a);
  });
});

describe("stripe", () => {
  const creds = stripe.parseCredentials({ secretKey: "sk_test_abc123" });

  it("sends each call's key as the Idempotency-Key header: createBill and refund, not the GET", async () => {
    const { fetch, calls } = mockFetch(json(session), json(session), json({ id: "re_1", status: "succeeded" }));
    const p = stripe.create(creds, context(fetch));
    await p.createBill({ amount: 50, referenceId: "r", idempotencyKey: `${stepKey}:createBill:0` });
    await p.refund!({ billId: "cs_1", idempotencyKey: `${stepKey}:refund:0` });
    expect(calls.map((c) => [c.method, c.headers["idempotency-key"]])).toEqual([
      ["POST", `${stepKey}:createBill:0`],
      ["GET", undefined],
      ["POST", `${stepKey}:refund:0`],
    ]);
  });

  it("keeps keys within Stripe's 255 characters and distinct", async () => {
    const { fetch, calls } = mockFetch(json(session));
    const p = stripe.create(creds, context(fetch));
    const base = `run_x:${"s".repeat(250)}:createBill:`;
    await p.createBill({ amount: 50, referenceId: "r", idempotencyKey: `${base}0` });
    await p.createBill({ amount: 50, referenceId: "r", idempotencyKey: `${base}1` });
    const [a, b] = calls.map((c) => c.headers["idempotency-key"]!);
    expect(a!.length).toBeLessThanOrEqual(255);
    expect(a).not.toBe(b);
  });
});

describe("resend", () => {
  const creds = resend.parseCredentials({ apiKey: "re_123", from: "Bot <bot@acme.test>" });

  it("sends the key as the Idempotency-Key header, distinct per call even when shortened", async () => {
    const { fetch, calls } = mockFetch(json({ id: "e1" }));
    const p = combineMessaging([
      { kind: "telegram", provider: telegram.create(telegram.parseCredentials({ botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" }), context(fetch)) },
      { kind: "resend", provider: resend.create(creds, context(fetch)) },
    ]);
    const long = `run_x:${"s".repeat(260)}:send:`;
    await p.send("a@b.test", "one", { channel: "email", idempotencyKey: `${stepKey}:send:0` });
    await p.send("a@b.test", "two", { channel: "email", idempotencyKey: `${long}0` });
    await p.send("a@b.test", "three", { channel: "email", idempotencyKey: `${long}1` });
    const keys = calls.map((c) => c.headers["idempotency-key"]!);
    expect(keys[0]).toBe(`${stepKey}:send:0`);
    expect(keys[1]!.length).toBeLessThanOrEqual(256);
    expect(keys[1]).not.toBe(keys[2]);
  });
});

describe("discord", () => {
  it("sends a nonce derived from the key with enforce_nonce on bot messages", async () => {
    const { fetch, calls } = mockFetch(json({ id: "m1" }));
    const p = discord.create(discord.parseCredentials({ botToken: "bot.token" }), context(fetch));
    await p.send("1100000000000000000", "one", { idempotencyKey: `${stepKey}:send:0` });
    await p.send("1100000000000000000", "one again", { idempotencyKey: `${stepKey}:send:0` });
    await p.send("1100000000000000000", "two", { idempotencyKey: `${stepKey}:send:1` });
    await p.send("1100000000000000000", "no key");
    const bodies = calls.map((c) => JSON.parse(c.body));
    expect(bodies[0]).toMatchObject({ content: "one", enforce_nonce: true, nonce: expect.stringMatching(/^[0-9a-f]{25}$/) });
    expect(bodies[1].nonce).toBe(bodies[0].nonce);
    expect(bodies[2].nonce).not.toBe(bodies[0].nonce);
    expect(bodies[3]).not.toHaveProperty("nonce");
    expect(bodies[3]).not.toHaveProperty("enforce_nonce");
  });

  it("cannot deduplicate webhook sends (Execute Webhook takes no nonce)", async () => {
    const { fetch, calls } = mockFetch(json({ id: "m1" }));
    await discord.create(discord.parseCredentials({ webhookUrl: "https://discord.com/api/webhooks/123/abc-DEF" }), context(fetch)).send("", "x", { idempotencyKey: "k" });
    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty("nonce");
  });
});

describe("providers without an idempotency API", () => {
  // Telegram, WhatsApp, Slack, CHIP, ToyyibPay and Billplz document no idempotency key: the key is accepted
  // and not sent anywhere (in particular, never as an unknown field the API might reject).
  it("accept the key and send requests unchanged", async () => {
    const { fetch, calls } = mockFetch(json({ ok: true, result: { message_id: 1 }, messages: [{ id: "w1" }], channel: "C1", ts: "1.2" }));
    const ctx = context(fetch);
    const opts = { idempotencyKey: `${stepKey}:send:0` };
    await telegram.create(telegram.parseCredentials({ botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" }), ctx).send("1", "x", opts);
    await whatsapp.create(whatsapp.parseCredentials({ phoneNumberId: "1", accessToken: "t" }), ctx).send("60123456789", "x", opts);
    await slack.create(slack.parseCredentials({ botToken: "xoxb-1" }), ctx).send("C1", "x", opts);
    for (const c of calls) {
      expect(c.body).not.toContain(stepKey);
      expect(c.headers).not.toHaveProperty("idempotency-key");
    }
    expect(calls).toHaveLength(3);
  });

  it("payment adapters without one create the bill and send no key", async () => {
    const { fetch, calls } = mockFetch(
      json({ id: "B1", collection_id: "c", paid: false, state: "due", amount: 100, url: "https://www.billplz.com/bills/B1", reference_1: "r" }),
      json({ id: "p1", status: "created", checkout_url: "https://gate.chip-in.asia/p/p1", reference: "r", purchase: { total: 100, currency: "MYR" } }),
      json([{ BillCode: "abc" }]),
    );
    const ctx = context(fetch);
    const request = { amount: 1, referenceId: "r", customer: { email: "a@b.co" }, idempotencyKey: `${stepKey}:createBill:0` };
    await billplz.create(billplz.parseCredentials({ apiKey: "k", collectionId: "c", xSignatureKey: "x" }), ctx).createBill(request);
    await chip.create(chip.parseCredentials({ brandId: "00000000-0000-0000-0000-000000000000", secretKey: "s", publicKey: "-----BEGIN PUBLIC KEY-----\nAA\n-----END PUBLIC KEY-----" }), ctx).createBill(request);
    await toyyibpay.create(toyyibpay.parseCredentials({ userSecretKey: "k", categoryCode: "c" }), ctx).createBill(request);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.body).not.toContain(stepKey);
      expect(c.headers).not.toHaveProperty("idempotency-key");
    }
  });
});
