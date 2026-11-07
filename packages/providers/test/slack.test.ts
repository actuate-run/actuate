/**
 * Slack approval buttons: request signing (docs.slack.dev/authentication/verifying-requests-from-slack), Block Kit
 * rendering within the button element limits, block_actions payload parsing, and the response_url follow-ups.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPrompt } from "@actuate/sdk";
import { WebhookVerificationError, envVarsFor, parseButtonPayload, slack, type ButtonClick, type ClickOutcome } from "../src/index.js";
import {
  SLACK_ACTION_ID_MAX,
  SLACK_BUTTON_TEXT_MAX,
  SLACK_BUTTON_URL_MAX,
  SLACK_BUTTON_VALUE_MAX,
  SLACK_SECTION_TEXT_MAX,
  slackResponseBody,
  verifySlackSignature,
} from "../src/slack.js";
import { context, failure, hmacHex, json, mockFetch } from "./helpers.js";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NONCE = "AbCdEfGhIjKl-_09";
const WEBHOOK = "https://hooks.slack.com/services/T/B/x";
const RESPONSE_URL = "https://hooks.slack.com/actions/T1/123/abcDEF";
const APPROVE_URL = "http://self.test/approve?token=aaa.bbb";
const REJECT_URL = "http://self.test/approve?token=ccc.ddd";

const approval = (over: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  kind: "approval",
  actuator: "refunds",
  step: "ok",
  message: "Refund RM 20?",
  approveUrl: APPROVE_URL,
  rejectUrl: REJECT_URL,
  expiresAt: Date.UTC(2026, 10, 8),
  buttons: { route: "local", nonce: NONCE },
  ...over,
});
const textOf = (a: ApprovalPrompt) => `${a.message}\n\nApprove: ${a.approveUrl}\nReject: ${a.rejectUrl}`;

type Element = { type: string; action_id: string; text: { type: string; text: string }; value?: string; url?: string; style?: string };
type Blocks = Array<{ type: string; block_id?: string; text?: { type: string; text: string }; elements?: Element[] }>;

/** Every Block Kit limit the docs give for what we render. */
function expectWithinLimits(blocks: Blocks) {
  expect(blocks.length).toBeLessThanOrEqual(50);
  for (const block of blocks) {
    if (block.type === "section") {
      expect(block.text!.type).toBe("mrkdwn");
      expect(block.text!.text.length).toBeGreaterThanOrEqual(1);
      expect(block.text!.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX);
    } else {
      expect(block.type).toBe("actions");
      expect(block.block_id!.length).toBeLessThanOrEqual(255);
      expect(block.elements!.length).toBeGreaterThan(0);
      expect(block.elements!.length).toBeLessThanOrEqual(25);
      for (const el of block.elements!) {
        expect(el.type).toBe("button");
        expect(el.text.type).toBe("plain_text");
        expect(el.text.text.length).toBeLessThanOrEqual(SLACK_BUTTON_TEXT_MAX);
        expect(el.action_id.length).toBeLessThanOrEqual(SLACK_ACTION_ID_MAX);
        if (el.value !== undefined) expect(el.value.length).toBeLessThanOrEqual(SLACK_BUTTON_VALUE_MAX);
        if (el.url !== undefined) expect(el.url.length).toBeLessThanOrEqual(SLACK_BUTTON_URL_MAX);
        if (el.style !== undefined) expect(["primary", "danger"]).toContain(el.style);
      }
      expect(new Set(block.elements!.map((e) => e.action_id)).size).toBe(block.elements!.length);
    }
  }
}

async function signedRequest(body: string, opts: { secret?: string; ts?: number; contentType?: string; signature?: string | null } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts };
  const signature = opts.signature === undefined ? `v0=${await hmacHex(opts.secret ?? SECRET, `v0:${ts}:${body}`)}` : opts.signature;
  if (signature !== null) headers["x-slack-signature"] = signature;
  return new Request("https://gw.actuate.test/providers/slack/webhook", { method: "POST", headers, body });
}

const blockActions = (over: Record<string, unknown> = {}) => ({
  type: "block_actions",
  team: { id: "T9TK3CUKW", domain: "example" },
  user: { id: "UA8RXUSPL", username: "jtorrance", name: "Jack Torrance", team_id: "T9TK3CUKW" },
  api_app_id: "AABA1ABCD",
  container: { type: "message", message_ts: "1548261231.000200", channel_id: "CBR2V3XEX", is_ephemeral: false },
  channel: { id: "CBR2V3XEX", name: "review-updates" },
  message: { type: "message", text: `Refund RM 20?\n\nApprove: <${APPROVE_URL}>\nReject: <${REJECT_URL}>`, ts: "1548261231.000200" },
  response_url: RESPONSE_URL,
  actions: [
    { action_id: "actuate_approve", block_id: "actuate_approval", text: { type: "plain_text", text: "Approve" }, value: `ap1:local:${NONCE}:a`, type: "button", action_ts: "1548426417.840180" },
  ],
  ...over,
});
const form = (payload: unknown) => new URLSearchParams({ payload: typeof payload === "string" ? payload : JSON.stringify(payload) }).toString();

const withSecret = (extra: Record<string, unknown> = {}) => slack.parseCredentials({ webhookUrl: WEBHOOK, signingSecret: SECRET, ...extra });

describe("slack request signing", () => {
  // The example in Slack's "Verifying requests from Slack" doc: its signing secret, timestamp, slash-command body
  // and the signature it shows.
  const docBody =
    "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
  const docTs = 1531420618;
  const docSignature = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";
  const headers = (over: Record<string, string | null> = {}) => {
    const h = new Headers({ "x-slack-request-timestamp": String(docTs), "x-slack-signature": docSignature });
    for (const [k, v] of Object.entries(over)) (v === null ? h.delete(k) : h.set(k, v));
    return h;
  };

  it("accepts the docs' example signature", async () => {
    await expect(verifySlackSignature(SECRET, headers(), docBody, docTs * 1000 + 30_000)).resolves.toBeUndefined();
    // The window is five minutes either way.
    await expect(verifySlackSignature(SECRET, headers(), docBody, (docTs + 300) * 1000)).resolves.toBeUndefined();
    await expect(verifySlackSignature(SECRET, headers(), docBody, (docTs - 300) * 1000)).resolves.toBeUndefined();
  });

  it("rejects a tampered body, signature, secret or timestamp", async () => {
    const now = docTs * 1000;
    for (const [secret, h, body] of [
      [SECRET, headers(), docBody.replace("text=", "text=x")],
      [SECRET, headers({ "x-slack-signature": docSignature.replace(/3$/, "4") }), docBody],
      [SECRET, headers({ "x-slack-signature": docSignature.toUpperCase() }), docBody],
      [SECRET, headers({ "x-slack-signature": docSignature.slice(3) }), docBody],
      [`${SECRET}x`, headers(), docBody],
      [SECRET, headers({ "x-slack-request-timestamp": String(docTs + 1) }), docBody],
    ] as const) {
      const err = await failure(verifySlackSignature(secret, h, body, now));
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect(err.message).toBe("Slack signature mismatch");
    }
  });

  it("rejects a timestamp more than five minutes off", async () => {
    for (const now of [(docTs + 301) * 1000, (docTs - 301) * 1000, (docTs + 86_400) * 1000]) {
      const err = await failure(verifySlackSignature(SECRET, headers(), docBody, now));
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect(err.message).toMatch(/five-minute window/);
    }
    for (const ts of ["", "abc", "1531420618.5", "-1531420618", "1".repeat(13)]) {
      const err = await failure(verifySlackSignature(SECRET, headers({ "x-slack-request-timestamp": ts }), docBody, docTs * 1000));
      expect(err).toBeInstanceOf(WebhookVerificationError);
    }
  });

  it("rejects missing headers", async () => {
    for (const h of [headers({ "x-slack-signature": null }), headers({ "x-slack-request-timestamp": null }), new Headers()]) {
      const err = await failure(verifySlackSignature(SECRET, h, docBody, docTs * 1000));
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect(err.message).toMatch(/missing/);
    }
  });
});

describe("slack credentials", () => {
  it("takes an optional signing secret and approver list", () => {
    const plain = slack.parseCredentials({ webhookUrl: WEBHOOK, signingSecret: " ", approvers: "" });
    expect(plain.signingSecret).toBeUndefined();
    expect(plain.approvers).toBeUndefined();
    expect(withSecret({ approvers: " U01ABC,W02DEF\nU01ABC " })).toMatchObject({ signingSecret: SECRET, approvers: "U01ABC W02DEF" });
    expect(() => withSecret({ approvers: "U01ABC alice" })).toThrow('Invalid Slack credentials: approvers must be Slack member IDs (U... or W...), separated by spaces or commas (not "alice")');
    expect(slack.credentialFields.find((f) => f.key === "signingSecret")).toMatchObject({ secret: true, optional: true });
    expect(slack.credentialFields.find((f) => f.key === "approvers")).toMatchObject({ secret: false, optional: true });
    expect(envVarsFor("slack").map((v) => v.name)).toEqual(["SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL", "SLACK_DEFAULT_CHANNEL", "SLACK_SIGNING_SECRET", "SLACK_APPROVERS"]);
  });

  it("isApprover: listed member IDs, or anyone without a list", () => {
    const listed = withSecret({ approvers: "U01ABC W02DEF" });
    expect(slack.isApprover!({ id: "U01ABC" }, listed)).toBe(true);
    expect(slack.isApprover!({ id: "W02DEF", name: "x" }, listed)).toBe(true);
    expect(slack.isApprover!({ id: "U09ZZZ", name: "U01ABC" }, listed)).toBe(false);
    expect(slack.isApprover!({ id: "U09ZZZ" }, withSecret())).toBe(true);
  });
});

describe("slack approval rendering", () => {
  it("sends interactive Approve and Reject buttons through the webhook with a signing secret", async () => {
    const { fetch, calls } = mockFetch(() => new Response("ok"));
    const a = approval();
    await slack.create(withSecret(), context(fetch)).send("", textOf(a), { approval: a, subject: "Approval needed: refunds" });
    expect(calls[0]!.url).toBe(WEBHOOK);
    const body = JSON.parse(calls[0]!.body) as { text: string; blocks: Blocks };
    // The fallback text is unchanged, links included.
    expect(body.text).toBe(textOf(a));
    expect(body.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: textOf(a) } },
      {
        type: "actions",
        block_id: "actuate_approval",
        elements: [
          { type: "button", action_id: "actuate_approve", text: { type: "plain_text", text: "Approve", emoji: false }, value: `ap1:local:${NONCE}:a`, style: "primary" },
          { type: "button", action_id: "actuate_reject", text: { type: "plain_text", text: "Reject", emoji: false }, value: `ap1:local:${NONCE}:r`, style: "danger" },
        ],
      },
    ]);
    expectWithinLimits(body.blocks);
    expect(body.blocks[1]!.elements!.map((e) => parseButtonPayload(e.value))).toEqual([
      { route: "local", nonce: NONCE, action: "approve" },
      { route: "local", nonce: NONCE, action: "reject" },
    ]);
    // Interactive buttons carry no link: the link is in the text only.
    expect(JSON.stringify(body.blocks[1])).not.toContain("http");
  });

  it("sends url buttons with a bot token and no signing secret, keeping the mrkdwn conversion", async () => {
    const { fetch, calls } = mockFetch(json({ ok: true, channel: "C01", ts: "1.2" }));
    const a = approval({ message: "Refund <b>RM 20</b> & more?" });
    const html = `Refund <b>RM 20</b> &amp; more?<br><br>Approve: ${APPROVE_URL}<br>Reject: ${REJECT_URL}`;
    expect(await slack.create(slack.parseCredentials({ botToken: "xoxb-1" }), context(fetch)).send("C01", html, { approval: a, format: "html" })).toEqual({ id: "C01:1.2", channel: "slack" });
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    const body = JSON.parse(calls[0]!.body) as { channel: string; text: string; blocks: Blocks; unfurl_links: boolean };
    const mrkdwn = `Refund *RM 20* &amp; more?\n\nApprove: ${APPROVE_URL}\nReject: ${REJECT_URL}`;
    expect(body).toMatchObject({ channel: "C01", text: mrkdwn, unfurl_links: false });
    expect(body.blocks[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: mrkdwn } });
    expect(body.blocks[1]!.elements).toEqual([
      { type: "button", action_id: "actuate_approve_link", text: { type: "plain_text", text: "Approve", emoji: false }, url: APPROVE_URL, style: "primary" },
      { type: "button", action_id: "actuate_reject_link", text: { type: "plain_text", text: "Reject", emoji: false }, url: REJECT_URL, style: "danger" },
    ]);
    expectWithinLimits(body.blocks);
  });

  it("uses url buttons when the runtime made no nonce, even with a signing secret", async () => {
    const { fetch, calls } = mockFetch(json({ ok: true, ts: "1.2" }));
    const a = approval({ buttons: undefined });
    await slack.create(withSecret({ botToken: "xoxb-1" }), context(fetch)).send("C01", textOf(a), { approval: a });
    const blocks = (JSON.parse(calls[0]!.body) as { blocks: Blocks }).blocks;
    expect(blocks[1]!.elements!.map((e) => [e.action_id, e.url, e.value])).toEqual([
      ["actuate_approve_link", APPROVE_URL, undefined],
      ["actuate_reject_link", REJECT_URL, undefined],
    ]);
  });

  it("gives a question an Answer url button", async () => {
    const { fetch, calls } = mockFetch(() => new Response("ok"));
    const answerUrl = "http://self.test/approve?token=eee.fff";
    const a: ApprovalPrompt = { kind: "input", actuator: "refunds", step: "why", message: "Why?", answerUrl, expiresAt: 1 };
    await slack.create(withSecret(), context(fetch)).send("", `Why?\n\nAnswer: ${answerUrl}`, { approval: a });
    const body = JSON.parse(calls[0]!.body) as { text: string; blocks: Blocks };
    expect(body.text).toBe(`Why?\n\nAnswer: ${answerUrl}`);
    expect(body.blocks[1]!.elements).toEqual([{ type: "button", action_id: "actuate_answer_link", text: { type: "plain_text", text: "Answer", emoji: false }, url: answerUrl, style: "primary" }]);
    expectWithinLimits(body.blocks);
  });

  it("stays within Block Kit limits for long messages and links", async () => {
    const { fetch, calls } = mockFetch(() => new Response("ok"));
    const long = `${"word ".repeat(700)}\n${"x".repeat(5000)}`;
    const a = approval({ buttons: undefined, approveUrl: `http://self.test/approve?token=${"a".repeat(SLACK_BUTTON_URL_MAX)}` });
    const text = `${long}\n\nApprove: ${a.approveUrl}\nReject: ${a.rejectUrl}`;
    await slack.create(slack.parseCredentials({ webhookUrl: WEBHOOK }), context(fetch)).send("", text, { approval: a });
    const body = JSON.parse(calls[0]!.body) as { text: string; blocks: Blocks };
    expectWithinLimits(body.blocks);
    // Split into sections, nothing lost; the over-long approve url gets no button (its link is still in the text).
    const sections = body.blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(2);
    expect(sections.map((s) => s.text!.text).join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    expect(body.blocks.at(-1)!.elements!.map((e) => e.action_id)).toEqual(["actuate_reject_link"]);
    expect(body.text).toBe(text);
  });

  it("sends the text alone, once, when Slack refuses the blocks", async () => {
    const a = approval();
    // chat.postMessage: 200 { ok: false, error: "invalid_blocks" }, nothing posted.
    const bot = mockFetch(json({ ok: false, error: "invalid_blocks" }), json({ ok: true, channel: "C01", ts: "1.2" }));
    expect(await slack.create(withSecret({ botToken: "xoxb-1" }), context(bot.fetch)).send("C01", textOf(a), { approval: a })).toEqual({ id: "C01:1.2", channel: "slack" });
    expect(bot.calls).toHaveLength(2);
    expect(JSON.parse(bot.calls[0]!.body)).toHaveProperty("blocks");
    expect(JSON.parse(bot.calls[1]!.body)).toEqual({ channel: "C01", text: textOf(a), unfurl_links: false });
    // An incoming webhook: 400 "invalid_blocks" as plain text.
    const hook = mockFetch(() => new Response("invalid_blocks", { status: 400 }), () => new Response("ok"));
    await slack.create(withSecret(), context(hook.fetch)).send("", textOf(a), { approval: a });
    expect(hook.calls.map((c) => Object.keys(JSON.parse(c.body)))).toEqual([["text", "blocks"], ["text"]]);
    // Refused again: the error, with no third try.
    const twice = mockFetch(json({ ok: false, error: "invalid_blocks" }));
    expect((await failure(slack.create(withSecret({ botToken: "xoxb-1" }), context(twice.fetch)).send("C01", textOf(a), { approval: a }))).message).toMatch(/invalid_blocks/);
    expect(twice.calls).toHaveLength(2);
  });

  it("doesn't resend for other errors, or a message without blocks", async () => {
    const a = approval();
    const denied = mockFetch(json({ ok: false, error: "channel_not_found" }));
    expect((await failure(slack.create(withSecret({ botToken: "xoxb-1" }), context(denied.fetch)).send("C01", textOf(a), { approval: a }))).message).toMatch(/channel_not_found/);
    expect(denied.calls).toHaveLength(1);
    const plain = mockFetch(() => new Response("invalid_blocks", { status: 400 }));
    await failure(slack.create(withSecret(), context(plain.fetch)).send("", "hello"));
    expect(plain.calls).toHaveLength(1);
    const gone = mockFetch(() => new Response("no_service", { status: 404 }));
    await failure(slack.create(withSecret(), context(gone.fetch)).send("", textOf(a), { approval: a }));
    expect(gone.calls).toHaveLength(1);
  });

  it("sends no blocks for an ordinary message", async () => {
    const { fetch, calls } = mockFetch(() => new Response("ok"));
    await slack.create(withSecret(), context(fetch)).send("", "hello");
    expect(JSON.parse(calls[0]!.body)).toEqual({ text: "hello" });
  });
});

describe("slack interactions", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("is off without a signing secret", async () => {
    const req = await signedRequest(form(blockActions()));
    expect(await slack.parseInteraction!(req, slack.parseCredentials({ webhookUrl: WEBHOOK }))).toBeNull();
  });

  it("turns a signed block_actions click into a ButtonClick, leaving the body unread", async () => {
    const body = form(blockActions());
    const req = await signedRequest(body);
    const out = await slack.parseInteraction!(req, withSecret());
    expect(out).toEqual({
      click: {
        route: "local",
        nonce: NONCE,
        action: "approve",
        actor: { id: "UA8RXUSPL", name: "Jack Torrance" },
        context: { responseUrl: RESPONSE_URL, text: `Refund RM 20?\n\nApprove: <${APPROVE_URL}>\nReject: <${REJECT_URL}>` },
      },
    });
    expect(await req.text()).toBe(body);
  });

  it("names the clicker by username when Slack sends no name, and reads a reject", async () => {
    const payload = blockActions({
      user: { id: "W02DEF", username: "aina", team_id: "T1" },
      actions: [
        { action_id: "other_app", type: "button", value: "something else" },
        { action_id: "actuate_reject", type: "button", value: `ap1:act_0123456789abcdef:${NONCE}:r` },
      ],
    });
    const out = (await slack.parseInteraction!(await signedRequest(form(payload)), withSecret())) as { click: ButtonClick };
    expect(out.click).toMatchObject({ route: "act_0123456789abcdef", action: "reject", actor: { id: "W02DEF", name: "aina" } });
    const nameless = blockActions({ user: { id: "U1AA" } });
    expect(((await slack.parseInteraction!(await signedRequest(form(nameless)), withSecret())) as { click: ButtonClick }).click.actor).toEqual({ id: "U1AA" });
  });

  it("acks a url-button click (and any block_actions that isn't ours) with an empty 200", async () => {
    const ack = { reply: { status: 200, contentType: "text/plain; charset=utf-8", body: "" } };
    for (const payload of [
      blockActions({ actions: [{ action_id: "actuate_approve_link", type: "button", block_id: "actuate_approval", action_ts: "1" }] }),
      blockActions({ actions: [{ action_id: "x", type: "button", value: `ap1:local:${NONCE}:x` }] }),
      blockActions({ actions: [] }),
      blockActions({ user: {} }),
    ]) {
      expect(await slack.parseInteraction!(await signedRequest(form(payload)), withSecret())).toEqual(ack);
    }
  });

  it("returns null for signed requests that aren't block_actions", async () => {
    const creds = withSecret();
    for (const req of [
      await signedRequest(JSON.stringify({ type: "url_verification", challenge: "abc" }), { contentType: "application/json" }),
      await signedRequest(JSON.stringify(blockActions()), { contentType: "application/json" }),
      await signedRequest("command=%2Fdeploy&text=x"),
      await signedRequest(form("{not json")),
      await signedRequest(form([1, 2])),
      await signedRequest(form(blockActions({ type: "view_submission" }))),
      await signedRequest(form(blockActions({ type: "interactive_message" }))),
    ]) {
      expect(await slack.parseInteraction!(req, creds)).toBeNull();
    }
  });

  it("throws WebhookVerificationError for a bad, old or missing signature", async () => {
    const body = form(blockActions());
    for (const req of [
      await signedRequest(body, { secret: "another-secret" }),
      await signedRequest(body, { ts: Math.floor(Date.now() / 1000) - 301 }),
      await signedRequest(body, { signature: null }),
      await signedRequest(body, { signature: "v0=" + "0".repeat(64) }),
    ]) {
      expect(await failure(slack.parseInteraction!(req, withSecret()))).toBeInstanceOf(WebhookVerificationError);
    }
  });

  it("verifies against the clock, five minutes either way", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const body = form(blockActions());
    expect(await slack.parseInteraction!(await signedRequest(body, { ts: now - 299 }), withSecret())).toHaveProperty("click");
    expect(await slack.parseInteraction!(await signedRequest(body, { ts: now + 299 }), withSecret())).toHaveProperty("click");
    expect(await failure(slack.parseInteraction!(await signedRequest(body, { ts: now + 301 }), withSecret()))).toBeInstanceOf(WebhookVerificationError);
  });

  it("routeHint reads the route from the unverified body", () => {
    expect(slack.routeHint!(form(blockActions()), "application/x-www-form-urlencoded")).toBe("local");
    expect(slack.routeHint!(form(blockActions({ actions: [{ value: `ap1:act_0123456789abcdef:${NONCE}:r` }] })), "application/x-www-form-urlencoded; charset=utf-8")).toBe("act_0123456789abcdef");
    expect(slack.routeHint!(form(blockActions({ actions: [{ url: "x" }] })), "application/x-www-form-urlencoded")).toBeNull();
    expect(slack.routeHint!(form(blockActions()), "application/json")).toBeNull();
    expect(slack.routeHint!(form(blockActions()), null)).toBeNull();
    expect(slack.routeHint!("payload=%7Bbroken", "application/x-www-form-urlencoded")).toBeNull();
    expect(slack.routeHint!("", "application/x-www-form-urlencoded")).toBeNull();
    expect(slack.routeHint!(form({ type: "block_actions", actions: "nope" }), "application/x-www-form-urlencoded")).toBeNull();
  });
});

describe("slack responses", () => {
  const at = "2026-11-07T14:02:31.000Z";
  const original = `Refund RM 20 &amp; more?\n\nApprove: <${APPROVE_URL}>\nReject: <${REJECT_URL}>`;
  const click = (over: Partial<ButtonClick> = {}): ButtonClick => ({
    route: "local",
    nonce: NONCE,
    action: "approve",
    actor: { id: "U01ABC", name: "Alice" },
    context: { responseUrl: RESPONSE_URL, text: original },
    ...over,
  });

  async function respond(outcome: ClickOutcome, c = click(), answer: () => Response = () => new Response("ok")) {
    const { fetch, calls } = mockFetch(answer);
    const out = slack.respondInteraction!(c, outcome, withSecret(), { fetch });
    return { out, calls, fetch };
  }

  it("acks with an empty 200 and replaces the message on decided", async () => {
    for (const [decision, word] of [["approved", "Approved"], ["rejected", "Rejected"]] as const) {
      const { out, calls } = await respond({ status: "decided", decision, by: "slack:U01ABC (Alice <x>)", at });
      expect(out.reply).toEqual({ status: 200, contentType: "text/plain; charset=utf-8", body: "" });
      expect(calls).toHaveLength(0);
      await out.after!();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(RESPONSE_URL);
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.headers["content-type"]).toMatch(/^application\/json/);
      const text = `Refund RM 20 &amp; more?\n\n${word} by Alice &lt;x&gt; at 14:02 UTC`;
      expect(JSON.parse(calls[0]!.body)).toEqual({ replace_original: true, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
      expect(calls[0]!.body).not.toContain("http");
    }
  });

  it("tells only the clicker about every other outcome", async () => {
    const cases: Array<[ClickOutcome, string]> = [
      [{ status: "already", decision: "approved", via: "chat", by: "slack:U02 (Bob)", at }, "Already approved by Bob"],
      [{ status: "already", decision: "rejected", via: "link", at }, "Already rejected with a link"],
      [{ status: "expired" }, "This request has expired or was already decided."],
      [{ status: "unknown" }, "This request has expired or was already decided."],
      [{ status: "not-approver" }, "You're not on the approver list for this."],
      [{ status: "foreign" }, "This button belongs to another actuator."],
    ];
    for (const [outcome, text] of cases) {
      const { out, calls } = await respond(outcome);
      expect(out.reply).toEqual({ status: 200, contentType: "text/plain; charset=utf-8", body: "" });
      await out.after!();
      expect(calls[0]!.url).toBe(RESPONSE_URL);
      expect(JSON.parse(calls[0]!.body)).toEqual({ response_type: "ephemeral", replace_original: false, text });
      expect(slackResponseBody(outcome, original)).toEqual({ response_type: "ephemeral", replace_original: false, text });
    }
  });

  it("posts only to Slack's response URLs, and never names one in a reply or error", async () => {
    const decided: ClickOutcome = { status: "decided", decision: "approved", by: "slack:U01ABC (Alice)", at };
    for (const responseUrl of [null, "", "https://evil.example/hook", "http://hooks.slack.com/actions/x", "https://hooks.slack.com.evil.example/x"]) {
      const { out, calls } = await respond(decided, click({ context: { responseUrl, text: original } }));
      expect(out.after).toBeUndefined();
      expect(out.reply.body).toBe("");
      expect(calls).toHaveLength(0);
    }
    const gov = await respond(decided, click({ context: { responseUrl: "https://hooks.slack-gov.com/actions/x", text: original } }));
    await gov.out.after!();
    expect(gov.calls[0]!.url).toBe("https://hooks.slack-gov.com/actions/x");

    const refused = await respond(decided, click(), () => new Response("expired_url", { status: 404 }));
    const err = await failure(refused.out.after!());
    expect(err.message).toBe("Slack API error (HTTP 404): expired_url");
    const echoed = await respond(decided, click(), () => new Response(`bad ${RESPONSE_URL}`, { status: 400 }));
    expect((await failure(echoed.out.after!())).message).not.toContain("hooks.slack.com");
    const down = await respond(decided, click(), () => {
      throw new TypeError(`fetch failed: ${RESPONSE_URL}`);
    });
    const downErr = await failure(down.out.after!());
    expect(downErr.message).toBe("Slack response_url request failed");
    expect(JSON.stringify(refused.out)).not.toContain("hooks.slack.com");
  });

  it("replaces a message whose text Slack didn't send with the decision alone", async () => {
    const { out, calls } = await respond({ status: "decided", decision: "approved", by: "slack:U01ABC", at }, click({ context: { responseUrl: RESPONSE_URL, text: "" } }));
    await out.after!();
    expect(JSON.parse(calls[0]!.body).text).toBe("Approved by slack:U01ABC at 14:02 UTC");
  });
});
