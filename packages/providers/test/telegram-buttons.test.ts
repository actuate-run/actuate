/**
 * Telegram approval buttons, checked against the Bot API docs (https://core.telegram.org/bots/api):
 * InlineKeyboardButton (callback_data 1-64 bytes, url "HTTP or tg://"), CallbackQuery, answerCallbackQuery
 * (text 0-200 characters, answered in the webhook response) and editMessageText.
 */
import { describe, expect, it } from "vitest";
import type { ApprovalPrompt, ButtonClick, ClickOutcome } from "@actuate/sdk";
import { MAX_BUTTON_PAYLOAD_BYTES, WebhookVerificationError, parseButtonPayload } from "../src/contract.js";
import { telegram } from "../src/index.js";
import { context, failure, json, jsonRequest, mockFetch } from "./helpers.js";

const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const SECRET = "s3cret_token-1";
const NONCE = "AbCdEfGhIjKlMnOp";
const plain = telegram.parseCredentials({ botToken: BOT_TOKEN });
const interactive = telegram.parseCredentials({ botToken: BOT_TOKEN, webhookSecretToken: SECRET });
const listed = telegram.parseCredentials({ botToken: BOT_TOKEN, webhookSecretToken: SECRET, approvers: "42, 43\n44" });

const APPROVE = "https://self.example.org/approve?token=aaa";
const REJECT = "https://self.example.org/approve?token=bbb";
const TEXT = `Refund RM 20?\n\nApprove: ${APPROVE}\nReject: ${REJECT}`;
const approval = (extra: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  kind: "approval",
  actuator: "refunds",
  step: "ok",
  message: "Refund RM 20?",
  approveUrl: APPROVE,
  rejectUrl: REJECT,
  expiresAt: Date.now() + 3_600_000,
  buttons: { route: "local", nonce: NONCE },
  ...extra,
});
const ok = json({ ok: true, result: { message_id: 77 } });
const bytes = (s: string) => new TextEncoder().encode(s).length;

async function sent(creds: typeof plain, text: string, options: Parameters<ReturnType<typeof telegram.create>["send"]>[2]) {
  const { fetch, calls } = mockFetch(ok);
  await telegram.create(creds, context(fetch)).send("-100123", text, options);
  expect(calls).toHaveLength(1);
  return JSON.parse(calls[0]!.body) as Record<string, any>;
}

describe("telegram credentials", () => {
  it("takes an optional approvers list of numeric user IDs", () => {
    expect(listed.approvers).toBe("42 43 44");
    expect(interactive.approvers).toBeUndefined();
    expect(telegram.parseCredentials({ botToken: BOT_TOKEN, approvers: "  " }).approvers).toBeUndefined();
    expect(() => telegram.parseCredentials({ botToken: BOT_TOKEN, approvers: "42 @alice -100123" })).toThrow(
      /Invalid Telegram credentials: approvers must be Telegram numeric user IDs.*"@alice", "-100123"/,
    );
    expect(telegram.credentialFields.find((f) => f.key === "approvers")).toMatchObject({ secret: false, optional: true });
  });
});

describe("telegram send with an approval", () => {
  it("puts Approve and Reject callback buttons on an approval when the bot takes clicks", async () => {
    const body = await sent(interactive, TEXT, { approval: approval() });
    expect(body.text).toBe(TEXT); // the links stay in the text
    expect(body).not.toHaveProperty("parse_mode");
    const [row, ...more] = body.reply_markup.inline_keyboard;
    expect(more).toEqual([]);
    expect(row).toEqual([
      { text: "Approve", callback_data: `ap1:local:${NONCE}:a` },
      { text: "Reject", callback_data: `ap1:local:${NONCE}:r` },
    ]);
    for (const button of row) {
      expect(bytes(button.callback_data)).toBeGreaterThanOrEqual(1);
      expect(bytes(button.callback_data)).toBeLessThanOrEqual(64);
    }
  });

  it("keeps callback_data within 64 bytes for the longest route", async () => {
    const body = await sent(interactive, TEXT, { approval: approval({ buttons: { route: "r".repeat(24), nonce: "-_".repeat(8) } }) });
    for (const button of body.reply_markup.inline_keyboard[0]) {
      expect(bytes(button.callback_data)).toBeLessThanOrEqual(MAX_BUTTON_PAYLOAD_BYTES);
      expect(parseButtonPayload(button.callback_data)).toMatchObject({ route: "r".repeat(24) });
    }
  });

  it("uses URL buttons to the confirm pages without a webhook secret token, or without a nonce", async () => {
    const links = [{ text: "Approve", url: APPROVE }, { text: "Reject", url: REJECT }];
    expect((await sent(plain, TEXT, { approval: approval() })).reply_markup).toEqual({ inline_keyboard: [links] });
    const { buttons: _b, ...noNonce } = approval();
    expect((await sent(interactive, TEXT, { approval: noNonce })).reply_markup).toEqual({ inline_keyboard: [links] });
    // A malformed nonce never fails the send: link buttons instead.
    expect((await sent(interactive, TEXT, { approval: approval({ buttons: { route: "local", nonce: "short" } }) })).reply_markup).toEqual({ inline_keyboard: [links] });
  });

  it("puts an Answer URL button on an input request", async () => {
    const answerUrl = "https://self.example.org/answer?token=ccc";
    const input: ApprovalPrompt = { kind: "input", actuator: "refunds", step: "why", message: "Why?", answerUrl, expiresAt: Date.now() + 1000 };
    const body = await sent(interactive, `Why?\n\nAnswer: ${answerUrl}`, { approval: input });
    expect(body.reply_markup).toEqual({ inline_keyboard: [[{ text: "Answer", url: answerUrl }]] });
    expect(body.text).toBe(`Why?\n\nAnswer: ${answerUrl}`);
  });

  it("keeps HTML mode alongside the buttons", async () => {
    const html = `<b>Refund RM 20?</b>\n\nApprove: <a href="${APPROVE}">${APPROVE}</a>`;
    const body = await sent(interactive, html, { format: "html", approval: approval() });
    expect(body).toMatchObject({ text: html, parse_mode: "HTML" });
    expect(body.reply_markup.inline_keyboard[0]).toHaveLength(2);
  });

  it("only puts http(s) URLs with a public-looking host on URL buttons", async () => {
    for (const [approveUrl, rejectUrl] of [
      ["http://localhost:8787/approve?token=a", "http://localhost:8787/approve?token=b"],
      ["http://127.0.0.1:8787/approve?token=a", "http://127.0.0.1:8787/approve?token=b"],
      ["javascript:alert(1)", REJECT],
      ["tg://resolve?domain=x", REJECT],
      ["not a url", REJECT],
    ]) {
      const body = await sent(plain, TEXT, { approval: approval({ approveUrl, rejectUrl }) });
      expect(body).not.toHaveProperty("reply_markup");
      expect(body.text).toBe(TEXT);
    }
    // Plain http on a real host is fine ("HTTP or tg:// URL").
    const httpUrl = "http://self.example.org/approve?token=a";
    expect((await sent(plain, TEXT, { approval: approval({ approveUrl: httpUrl }) })).reply_markup.inline_keyboard[0][0]).toEqual({ text: "Approve", url: httpUrl });
  });

  it("sends no keyboard without an approval", async () => {
    expect(await sent(interactive, "hello", {})).toEqual({ chat_id: "-100123", text: "hello" });
  });

  it("sends again without URL buttons when Telegram refuses a button URL", async () => {
    const { fetch, calls } = mockFetch(json({ ok: false, error_code: 400, description: "Bad Request: BUTTON_URL_INVALID" }, 400), ok);
    expect(await telegram.create(plain, context(fetch)).send("1", TEXT, { approval: approval() })).toEqual({ id: "77", channel: "telegram" });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body)).toHaveProperty("reply_markup");
    expect(JSON.parse(calls[1]!.body)).toEqual({ chat_id: "1", text: TEXT });
  });

  it("doesn't retry other errors, or callback buttons", async () => {
    const chatNotFound = mockFetch(json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400));
    await expect(telegram.create(plain, context(chatNotFound.fetch)).send("1", TEXT, { approval: approval() })).rejects.toThrow(/chat not found/);
    expect(chatNotFound.calls).toHaveLength(1);
    const badButton = mockFetch(json({ ok: false, error_code: 400, description: "Bad Request: BUTTON_DATA_INVALID" }, 400));
    await expect(telegram.create(interactive, context(badButton.fetch)).send("1", TEXT, { approval: approval() })).rejects.toThrow(/BUTTON_DATA_INVALID/);
    expect(badButton.calls).toHaveLength(1);
  });
});

// A callback query as Telegram delivers it: https://core.telegram.org/bots/api#callbackquery
function callbackUpdate(data: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    update_id: 10001,
    callback_query: {
      id: "4382bfdwdsb323b2d9",
      from: { id: 42, is_bot: false, first_name: "Wei", last_name: "Tan", username: "weitan", language_code: "en" },
      message: {
        message_id: 77,
        from: { id: 123456789, is_bot: true, first_name: "Refund bot", username: "refund_bot" },
        chat: { id: -100123, title: "Ops", type: "supergroup" },
        date: 1793664000,
        text: TEXT,
        reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `ap1:local:${NONCE}:a` }]] },
      },
      chat_instance: "-7428390749209",
      data,
      ...extra,
    },
  });
}
const withSecret = (body: string, secret: string | null = SECRET) => jsonRequest(body, secret === null ? {} : { "x-telegram-bot-api-secret-token": secret });

describe("telegram parseInteraction", () => {
  it("checks the secret token: missing or wrong is a verification error", async () => {
    const body = callbackUpdate(`ap1:local:${NONCE}:a`);
    await expect(telegram.parseInteraction!(withSecret(body, null), interactive)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(telegram.parseInteraction!(withSecret(body, "wrong"), interactive)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(telegram.parseInteraction!(withSecret(body, `${SECRET}x`), interactive)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(telegram.parseInteraction!(withSecret(body), interactive)).resolves.toHaveProperty("click");
  });

  it("takes no clicks without a secret token", async () => {
    await expect(telegram.parseInteraction!(withSecret(callbackUpdate(`ap1:local:${NONCE}:a`)), plain)).resolves.toBeNull();
  });

  it("returns the click with the verified actor and what the reply needs, leaving the body for parseWebhook", async () => {
    const request = withSecret(callbackUpdate(`ap1:local:${NONCE}:r`));
    const out = (await telegram.parseInteraction!(request, interactive)) as { click: ButtonClick };
    expect(out.click).toEqual({
      route: "local",
      nonce: NONCE,
      action: "reject",
      actor: { id: "42", name: "Wei Tan" },
      context: { callbackQueryId: "4382bfdwdsb323b2d9", chatId: -100123, messageId: 77, text: TEXT },
    });
    expect(request.bodyUsed).toBe(false);
    expect(JSON.parse(await request.text())).toHaveProperty("callback_query");
  });

  it("names the clicker by username when they have no name, and decides inaccessible messages without an edit target", async () => {
    const body = callbackUpdate(`ap1:local:${NONCE}:a`, {
      from: { id: 7, is_bot: false, first_name: " ", username: "ops" },
      message: { message_id: 77, chat: { id: -100123, type: "supergroup" }, date: 0 },
    });
    const out = (await telegram.parseInteraction!(withSecret(body), interactive)) as { click: ButtonClick };
    expect(out.click.actor).toEqual({ id: "7", name: "@ops" });
    expect(out.click.context).toEqual({ callbackQueryId: "4382bfdwdsb323b2d9", chatId: null, messageId: null, text: "" });
  });

  it("answers a callback query that isn't one of our buttons with a bare answerCallbackQuery", async () => {
    const bare = { reply: { status: 200, contentType: "application/json", body: '{"method":"answerCallbackQuery","callback_query_id":"4382bfdwdsb323b2d9"}' } };
    for (const data of ["approve", `ap1:local:${NONCE}:x`, `ap1:local:${NONCE}:a `, "AP1:local:" + NONCE + ":a", 42, undefined]) {
      await expect(telegram.parseInteraction!(withSecret(callbackUpdate(data)), interactive)).resolves.toEqual(bare);
    }
    await expect(telegram.parseInteraction!(withSecret(callbackUpdate(undefined, { game_short_name: "g" })), interactive)).resolves.toEqual(bare);
    // Our payload but no usable sender: answered, never a click.
    await expect(telegram.parseInteraction!(withSecret(callbackUpdate(`ap1:local:${NONCE}:a`, { from: { first_name: "x" } })), interactive)).resolves.toEqual(bare);
    // Still verified first, and still nothing without a secret token.
    await expect(telegram.parseInteraction!(withSecret(callbackUpdate("other"), "wrong"), interactive)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(telegram.parseInteraction!(withSecret(callbackUpdate("other")), plain)).resolves.toBeNull();
    // No query id to answer: nothing to reply with.
    await expect(telegram.parseInteraction!(withSecret(callbackUpdate("other", { id: undefined })), interactive)).resolves.toBeNull();
  });

  it("returns null for updates that aren't callback queries", async () => {
    const message = JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 5 }, text: "hi" } });
    await expect(telegram.parseInteraction!(withSecret(message), interactive)).resolves.toBeNull();
    await expect(telegram.parseInteraction!(withSecret("not json"), interactive)).resolves.toBeNull();
  });

  it("parseWebhook ignores callback queries, ours or not", async () => {
    await expect(telegram.parseWebhook!(withSecret(callbackUpdate(`ap1:local:${NONCE}:a`)), interactive)).resolves.toBeNull();
    await expect(telegram.parseWebhook!(withSecret(callbackUpdate("other")), interactive)).resolves.toBeNull();
    // An update with both (impossible in practice) still isn't a message event.
    const both = JSON.parse(callbackUpdate("other"));
    both.message = { message_id: 1, date: 1, chat: { id: 5 }, text: "hi" };
    await expect(telegram.parseWebhook!(withSecret(JSON.stringify(both)), interactive)).resolves.toBeNull();
  });

  it("routeHint reads the route without verifying anything", () => {
    expect(telegram.routeHint!(callbackUpdate(`ap1:act_0123456789abcdef:${NONCE}:a`), "application/json")).toBe("act_0123456789abcdef");
    expect(telegram.routeHint!(callbackUpdate("other"), "application/json")).toBeNull();
    expect(telegram.routeHint!(JSON.stringify({ message: { text: `ap1:local:${NONCE}:a` } }), "application/json")).toBeNull();
    expect(telegram.routeHint!("{", null)).toBeNull();
  });

  it("isApprover: everyone without a list, else only listed user IDs", () => {
    expect(telegram.isApprover!({ id: "999" }, interactive)).toBe(true);
    expect(telegram.isApprover!({ id: "43", name: "Bob" }, listed)).toBe(true);
    expect(telegram.isApprover!({ id: "999", name: "43" }, listed)).toBe(false);
  });
});

describe("telegram respondInteraction", () => {
  const click: ButtonClick = {
    route: "local",
    nonce: NONCE,
    action: "approve",
    actor: { id: "42", name: "Wei Tan" },
    context: { callbackQueryId: "q-1", chatId: -100123, messageId: 77, text: TEXT },
  };
  const at = "2026-11-07T14:02:31.000Z";
  const replies: Array<[ClickOutcome, string]> = [
    [{ status: "decided", decision: "approved", by: "telegram:42 (Wei Tan)", at }, "Approved by Wei Tan at 14:02 UTC"],
    [{ status: "decided", decision: "rejected", by: "telegram:42 (Wei Tan)", at }, "Rejected by Wei Tan at 14:02 UTC"],
    [{ status: "already", decision: "approved", by: "telegram:43 (Bob)", at }, "Already approved by Bob"],
    [{ status: "already", decision: "rejected", by: "Aina", at }, "Already rejected by Aina"],
    [{ status: "expired" }, "This request has expired or was already decided."],
    [{ status: "unknown" }, "This request has expired or was already decided."],
    [{ status: "not-approver" }, "You're not on the approver list for this."],
    [{ status: "foreign" }, "This button belongs to another actuator."],
  ];

  it.each(replies)("answers the callback query in the webhook response: %j", (outcome, text) => {
    const { fetch, calls } = mockFetch(ok);
    const { reply, after } = telegram.respondInteraction!(click, outcome, interactive, { fetch });
    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe("application/json");
    expect(reply.body).toBe(JSON.stringify({ method: "answerCallbackQuery", callback_query_id: "q-1", text }));
    expect(JSON.parse(reply.body).text.length).toBeLessThanOrEqual(200);
    expect(reply.body).not.toMatch(/https?:|token|ap1:/);
    expect(after === undefined).toBe(outcome.status !== "decided");
    expect(calls).toHaveLength(0); // nothing sent before the reply
  });

  it("edits the decided message: links and buttons gone, the decision in", async () => {
    const { fetch, calls } = mockFetch(json({ ok: true, result: { message_id: 77 } }));
    const { after } = telegram.respondInteraction!(click, replies[0]![0], interactive, { fetch });
    await after!();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      chat_id: -100123,
      message_id: 77,
      text: "Refund RM 20?\n\nApproved by Wei Tan at 14:02 UTC",
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("keeps an edit within Telegram's 4096 characters", async () => {
    const { fetch, calls } = mockFetch(ok);
    const long = { ...click, context: { ...(click.context as object), text: `${"x".repeat(5000)}\n\nApprove: ${APPROVE}` } };
    await telegram.respondInteraction!(long, replies[1]![0], interactive, { fetch }).after!();
    const text = JSON.parse(calls[0]!.body).text as string;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/x…\n\nRejected by Wei Tan at 14:02 UTC$/);
  });

  it("has nothing to edit when the message isn't accessible", () => {
    const blind = { ...click, context: { callbackQueryId: "q-1", chatId: null, messageId: null, text: "" } };
    expect(telegram.respondInteraction!(blind, replies[0]![0], interactive, { fetch: mockFetch(ok).fetch }).after).toBeUndefined();
  });

  it("never puts the bot token in an edit's errors", async () => {
    const api = mockFetch(json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, 400));
    const apiErr = await failure(telegram.respondInteraction!(click, replies[0]![0], interactive, { fetch: api.fetch }).after!());
    expect(apiErr.message).toBe("Telegram API error (HTTP 400): Bad Request: message is not modified");
    const network = (async (url: string) => {
      throw new TypeError(`connect failed ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const netErr = await failure(telegram.respondInteraction!(click, replies[0]![0], interactive, { fetch: network }).after!());
    expect(netErr.message).toMatch(/^Telegram request failed: connect failed <url>$/);
    for (const err of [apiErr, netErr]) {
      expect(err.message).not.toContain(BOT_TOKEN);
      expect(String(err.stack)).not.toContain(BOT_TOKEN);
    }
  });
});
