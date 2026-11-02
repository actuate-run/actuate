import { describe, expect, it } from "vitest";
import { WebhookVerificationError } from "../src/contract.js";
import { resend, telegram, whatsapp } from "../src/index.js";
import { context, failure, hmacHex, json, jsonRequest, mockFetch } from "./helpers.js";

const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

describe("telegram", () => {
  const creds = telegram.parseCredentials({ botToken: BOT_TOKEN });

  it("sends via sendMessage", async () => {
    const { fetch, calls } = mockFetch(json({ ok: true, result: { message_id: 42 } }));
    const receipt = await telegram.create(creds, context(fetch)).send("-100123", "hello");
    expect(receipt).toEqual({ id: "42", channel: "telegram" });
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body)).toEqual({ chat_id: "-100123", text: "hello" });
  });

  it("rejects bad credentials without echoing them", () => {
    expect(() => telegram.parseCredentials({ botToken: "nope-secret" })).toThrow(/Invalid Telegram credentials: botToken/);
    try {
      telegram.parseCredentials({ botToken: "nope-secret" });
    } catch (e) {
      expect(String(e)).not.toContain("nope-secret");
    }
    expect(() => telegram.parseCredentials({})).toThrow(/botToken is required/);
  });

  it("surfaces API errors readably and never leaks the token", async () => {
    const { fetch } = mockFetch(json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400));
    const err = await failure(telegram.create(creds, context(fetch)).send("1", "x"));
    expect(err.message).toBe("Telegram API error (HTTP 400): Bad Request: chat not found");
    expect(err.message).not.toContain(BOT_TOKEN);
  });

  it("redacts the token from network errors", async () => {
    const fetch = (async () => {
      throw new TypeError(`connect failed https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    }) as typeof globalThis.fetch;
    const err = await failure(telegram.create(creds, context(fetch)).send("1", "x"));
    expect(err.message).not.toContain(BOT_TOKEN);
  });

  it("checks the webhook secret token and returns null", async () => {
    const withSecret = telegram.parseCredentials({ botToken: BOT_TOKEN, webhookSecretToken: "s3cret" });
    await expect(telegram.parseWebhook!(jsonRequest("{}", { "x-telegram-bot-api-secret-token": "s3cret" }), withSecret)).resolves.toBeNull();
    await expect(telegram.parseWebhook!(jsonRequest("{}", { "x-telegram-bot-api-secret-token": "wrong" }), withSecret)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });
});

describe("whatsapp", () => {
  const creds = whatsapp.parseCredentials({ phoneNumberId: "1055551234", accessToken: "EAAG-token", appSecret: "appsecret" });

  it("sends free-form text", async () => {
    const { fetch, calls } = mockFetch(json({ messaging_product: "whatsapp", messages: [{ id: "wamid.ABC" }] }));
    const receipt = await whatsapp.create(creds, context(fetch)).send("+60 12-345 6789", "hi there");
    expect(receipt).toEqual({ id: "wamid.ABC", channel: "whatsapp" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/1055551234/messages");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe("Bearer EAAG-token");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "60123456789",
      type: "text",
      text: { preview_url: false, body: "hi there" },
    });
  });

  it("sends templates with body variables", async () => {
    const { fetch, calls } = mockFetch(json({ messages: [{ id: "wamid.T" }] }));
    const custom = whatsapp.parseCredentials({ phoneNumberId: "1", accessToken: "t", apiVersion: "v25.0" });
    await whatsapp.create(custom, context(fetch)).send("60123456789", "", {
      template: { name: "deposit_reminder", language: "en_US", variables: ["Aisyah", "RM 50"] },
    });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v25.0/1/messages");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      type: "template",
      template: {
        name: "deposit_reminder",
        language: { code: "en_US" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Aisyah" }, { type: "text", text: "RM 50" }] }],
      },
    });
  });

  it("validates credentials and recipients", async () => {
    expect(() => whatsapp.parseCredentials({ phoneNumberId: "+60123", accessToken: "x" })).toThrow(/phoneNumberId/);
    expect(() => whatsapp.parseCredentials({ phoneNumberId: "1" })).toThrow(/accessToken is required/);
    const { fetch } = mockFetch(json({}));
    await expect(whatsapp.create(creds, context(fetch)).send("not-a-number", "x")).rejects.toThrow(/phone number/);
  });

  it("surfaces Graph API errors", async () => {
    const { fetch } = mockFetch(json({ error: { message: "(#131030) Recipient phone number not in allowed list", code: 131030 } }, 400));
    await expect(whatsapp.create(creds, context(fetch)).send("60123456789", "x")).rejects.toThrow(
      "WhatsApp API error (HTTP 400): (#131030) Recipient phone number not in allowed list",
    );
  });

  it("verifies X-Hub-Signature-256", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const sig = `sha256=${await hmacHex("appsecret", body)}`;
    await expect(whatsapp.parseWebhook!(jsonRequest(body, { "x-hub-signature-256": sig }), creds)).resolves.toBeNull();
    await expect(whatsapp.parseWebhook!(jsonRequest(body + " ", { "x-hub-signature-256": sig }), creds)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
    await expect(whatsapp.parseWebhook!(jsonRequest(body), creds)).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});

describe("resend", () => {
  const creds = resend.parseCredentials({ apiKey: "re_123abc", from: "Acme <bot@acme.com>" });

  it("sends an email with subject and idempotency key", async () => {
    const { fetch, calls } = mockFetch(json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
    const receipt = await resend.create(creds, context(fetch)).send("ali@example.com", "Your deposit is due", {
      subject: "Reminder",
      idempotencyKey: "run1:step2",
    });
    expect(receipt).toEqual({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794", channel: "email" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe("Bearer re_123abc");
    expect(calls[0]!.headers["idempotency-key"]).toBe("run1:step2");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      from: "Acme <bot@acme.com>",
      to: ["ali@example.com"],
      subject: "Reminder",
      text: "Your deposit is due",
    });
  });

  it("derives a subject when none is given", async () => {
    const { fetch, calls } = mockFetch(json({ id: "x" }));
    await resend.create(creds, context(fetch)).send("ali@example.com", "\nFirst line\nsecond");
    expect(JSON.parse(calls[0]!.body).subject).toBe("First line");
  });

  it("validates credentials and recipients", async () => {
    expect(() => resend.parseCredentials({ apiKey: "sk_wrong", from: "bot@acme.com" })).toThrow(/apiKey must start with "re_"/);
    expect(() => resend.parseCredentials({ apiKey: "re_1", from: "not an email" })).toThrow(/from must be an email/);
    const { fetch } = mockFetch(json({}));
    await expect(resend.create(creds, context(fetch)).send("12345", "x")).rejects.toThrow(/email address/);
  });

  it("surfaces API errors", async () => {
    const { fetch } = mockFetch(json({ statusCode: 422, name: "validation_error", message: "The acme.com domain is not verified." }, 422));
    await expect(resend.create(creds, context(fetch)).send("a@b.co", "x")).rejects.toThrow(
      "Resend API error (HTTP 422): The acme.com domain is not verified.",
    );
  });
});

describe("html format", () => {
  it("uses Telegram HTML mode, Resend html+text, and strips tags for WhatsApp", async () => {
    const { telegram, resend, whatsapp } = await import("../src/index.js");
    const bodies: any[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true, result: { message_id: 1, chat: { id: 1 } }, id: "e1", messages: [{ id: "w1" }] });
    }) as typeof fetch;
    const ctx = { fetch: f, webhookUrl: "", defaultReturnUrl: "" };
    const html = 'Paid: <b>RM 50</b> <a href="https://x.co/r">receipt</a>';
    await telegram.create(telegram.parseCredentials({ botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" }), ctx).send("1", html, { format: "html" });
    await resend.create(resend.parseCredentials({ apiKey: "re_x", from: "a@b.co" }), ctx).send("c@d.co", html, { format: "html", subject: "s" });
    await whatsapp.create(whatsapp.parseCredentials({ phoneNumberId: "1", accessToken: "t" }), ctx).send("+60123456789", html, { format: "html" });
    expect(bodies[0]).toMatchObject({ parse_mode: "HTML", text: html });
    expect(bodies[1]).toMatchObject({ html, text: "Paid: RM 50 receipt (https://x.co/r)" });
    expect(bodies[2].text.body).toBe("Paid: RM 50 receipt (https://x.co/r)");
  });
});
