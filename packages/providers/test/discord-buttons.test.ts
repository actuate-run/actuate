/**
 * Discord approval buttons: Ed25519 verification of interactions (WebCrypto, a generated key pair), PING, rendering
 * (bot interactive buttons, webhook link buttons, the 512-character URL rule), approvers with roles, and the reply to
 * each click outcome. Field limits from discord.com/developers/docs/components/reference.
 */
import { describe, expect, it } from "vitest";
import type { ApprovalPrompt } from "@actuate/sdk";
import { discord, parseButtonPayload, type ButtonClick, type ClickOutcome } from "../src/index.js";
import { DISCORD_MAX_CUSTOM_ID, verifyDiscordSignature } from "../src/discord.js";
import { context, failure, json, mockFetch } from "./helpers.js";

const NONCE = "AbCdEfGhIjKl-_09";
const CHANNEL = "1100000000000000000";
const ALICE = "123456789012345678";
const ROLE = "876543210987654321";
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicHex: toHex(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

const KEYS = await keyPair();
const OTHER = await keyPair();

async function sign(privateKey: CryptoKey, timestamp: string, body: string) {
  return toHex(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(timestamp + body)));
}

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

async function signedRequest(body: unknown, opts: { key?: CryptoKey; timestamp?: string; tamper?: boolean; headers?: Record<string, string> } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = opts.timestamp ?? nowSeconds();
  const signature = await sign(opts.key ?? KEYS.privateKey, timestamp, raw);
  return new Request("https://gw.actuate.test/providers/discord/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp, ...opts.headers },
    body: opts.tamper ? raw.replace("PLACEHOLDER", "tampered") : raw,
  });
}

const bot = discord.parseCredentials({ botToken: "bot.token", publicKey: KEYS.publicHex, defaultChannel: CHANNEL });
const webhookOnly = discord.parseCredentials({ webhookUrl: "https://discord.com/api/webhooks/123/abc-DEF", publicKey: KEYS.publicHex });

const approval = (over: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  kind: "approval",
  actuator: "refunds",
  step: "ok",
  message: "Refund RM 20?",
  approveUrl: "https://self.test/approve?token=aaa",
  rejectUrl: "https://self.test/approve?token=rrr",
  expiresAt: Date.now() + 3_600_000,
  buttons: { route: "local", nonce: NONCE },
  ...over,
});
const TEXT = "Refund RM 20?\n\nApprove: https://self.test/approve?token=aaa\nReject: https://self.test/approve?token=rrr";

const click = (custom_id: string, over: Record<string, unknown> = {}) => ({
  type: 3,
  id: "1",
  application_id: "2",
  token: "interaction-token-secret",
  data: { custom_id, component_type: 2 },
  member: { user: { id: ALICE, username: "alice", global_name: "Alice" }, roles: [ROLE] },
  message: { id: "m1", content: TEXT },
  ...over,
});

describe("discord credentials", () => {
  it("takes an optional public key and approvers", () => {
    const c = discord.parseCredentials({ botToken: "t", publicKey: KEYS.publicHex.toUpperCase(), approvers: `${ALICE}, role:${ROLE}` });
    expect(c.publicKey).toBe(KEYS.publicHex);
    expect(c.approvers).toBe(`${ALICE} role:${ROLE}`);
    expect(discord.parseCredentials({ botToken: "t" })).not.toHaveProperty("publicKey", expect.anything());
    expect(() => discord.parseCredentials({ botToken: "t", publicKey: "abc" })).toThrow(/64-character hex Public Key/);
    expect(() => discord.parseCredentials({ botToken: "t", approvers: "alice" })).toThrow(/Discord user IDs, or role:<role ID>/);
    expect(() => discord.parseCredentials({ botToken: "t", approvers: "role:x" })).toThrow(/approvers/);
    const fields = discord.credentialFields.filter((f) => f.key === "publicKey" || f.key === "approvers");
    expect(fields.map((f) => [f.key, f.secret, f.optional])).toEqual([["publicKey", false, true], ["approvers", false, true]]);
  });
});

describe("discord signature verification", () => {
  const ping = { type: 1, id: "1", application_id: "2", token: "t", version: 1 };

  it("answers a signed PING with a PONG", async () => {
    const out = await discord.parseInteraction!(await signedRequest(ping), bot);
    expect(out).toEqual({ reply: { status: 200, contentType: "application/json", body: '{"type":1}' } });
  });

  it("refuses a tampered body, the wrong key, an old or future timestamp, and missing headers", async () => {
    const body = { ...ping, PLACEHOLDER: true };
    const bad = [
      await signedRequest(body, { tamper: true }),
      await signedRequest(ping, { key: OTHER.privateKey }),
      await signedRequest(ping, { timestamp: String(Math.floor(Date.now() / 1000) - 6 * 60) }),
      await signedRequest(ping, { timestamp: String(Math.floor(Date.now() / 1000) + 6 * 60) }),
      await signedRequest(ping, { headers: { "x-signature-ed25519": "" } }),
      await signedRequest(ping, { headers: { "x-signature-timestamp": "" } }),
      await signedRequest(ping, { headers: { "x-signature-ed25519": "zz".repeat(64) } }),
      await signedRequest(ping, { headers: { "x-signature-ed25519": "00".repeat(63) } }),
      new Request("https://gw.actuate.test/", { method: "POST", body: JSON.stringify(ping) }),
    ];
    for (const request of bad) {
      const err = await failure(discord.parseInteraction!(request, bot));
      expect(err.name).toBe("WebhookVerificationError");
      expect(err.message).toBe("Discord signature verification failed");
    }
  });

  it("accepts a timestamp within 5 minutes", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 4 * 60);
    expect(await discord.parseInteraction!(await signedRequest(ping, { timestamp: ts }), bot)).toMatchObject({ reply: { body: '{"type":1}' } });
    await expect(verifyDiscordSignature(KEYS.publicHex, await sign(KEYS.privateKey, ts, "x"), ts, "x")).resolves.toBeUndefined();
  });

  it("takes no interactions without a public key, and leaves the request body unread", async () => {
    const noKey = discord.parseCredentials({ botToken: "t" });
    const request = await signedRequest(ping);
    expect(await discord.parseInteraction!(request, noKey)).toBeNull();
    const signed = await signedRequest(ping);
    await discord.parseInteraction!(signed, bot);
    expect(signed.bodyUsed).toBe(false);
    expect(await signed.json()).toEqual(ping);
  });
});

describe("discord clicks", () => {
  const approve = `ap1:local:${NONCE}:a`;

  it("recognises an Approve click from a guild member, with roles", async () => {
    const out = await discord.parseInteraction!(await signedRequest(click(approve)), bot);
    expect(out).toEqual({
      click: { route: "local", nonce: NONCE, action: "approve", actor: { id: ALICE, name: "Alice", roles: [ROLE] }, context: { text: TEXT } },
    });
    // The interaction token stays out of the click.
    expect(JSON.stringify(out)).not.toContain("interaction-token-secret");
  });

  it("takes a DM click from `user`, falling back to the username", async () => {
    const body = click(`ap1:act_0123456789abcdef:${NONCE}:r`, { member: undefined, user: { id: ALICE, username: "alice", global_name: null } });
    const out = (await discord.parseInteraction!(await signedRequest(body), bot)) as { click: ButtonClick };
    expect(out.click).toMatchObject({ route: "act_0123456789abcdef", action: "reject", actor: { id: ALICE, name: "alice" } });
    expect(out.click.actor.roles).toBeUndefined();
  });

  it("answers other interactions politely, for the clicker only", async () => {
    const polite = { type: 4, data: { content: "This app only handles Actuate approval buttons.", flags: 64, allowed_mentions: { parse: [] } } };
    for (const body of [click("someone-elses-button"), click(`${approve} `), { type: 2, data: { name: "hello" }, member: click(approve).member }, { type: 5, data: { custom_id: approve } }]) {
      const out = (await discord.parseInteraction!(await signedRequest(body), bot)) as { reply: { body: string } };
      expect(JSON.parse(out.reply.body)).toEqual(polite);
    }
    const auto = (await discord.parseInteraction!(await signedRequest({ type: 4, data: {} }), bot)) as { reply: { body: string } };
    expect(JSON.parse(auto.reply.body)).toEqual({ type: 8, data: { choices: [] } });
  });

  it("reads the route hint from the raw body, unverified", () => {
    expect(discord.routeHint!(JSON.stringify(click(`ap1:act_0123456789abcdef:${NONCE}:a`)), "application/json")).toBe("act_0123456789abcdef");
    expect(discord.routeHint!(JSON.stringify({ type: 1 }), "application/json")).toBeNull();
    expect(discord.routeHint!(JSON.stringify(click("other")), null)).toBeNull();
    expect(discord.routeHint!("not json", null)).toBeNull();
  });

  it("matches approvers by user ID or role", () => {
    const listed = discord.parseCredentials({ botToken: "t", approvers: `999999999999999999 role:${ROLE}` });
    expect(discord.isApprover!({ id: ALICE, roles: [ROLE] }, listed)).toBe(true);
    expect(discord.isApprover!({ id: "999999999999999999" }, listed)).toBe(true);
    expect(discord.isApprover!({ id: ALICE, roles: ["111111111111111111"] }, listed)).toBe(false);
    expect(discord.isApprover!({ id: ALICE }, listed)).toBe(false);
    expect(discord.isApprover!({ id: ALICE }, bot)).toBe(true);
  });
});

describe("discord replies", () => {
  const c: ButtonClick = { route: "local", nonce: NONCE, action: "approve", actor: { id: ALICE, name: "Alice" }, context: { text: TEXT } };
  const at = "2026-11-07T14:02:33.000Z";
  const reply = (outcome: ClickOutcome) => {
    const { reply, after } = discord.respondInteraction!(c, outcome, bot, context(mockFetch().fetch));
    expect(after).toBeUndefined();
    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe("application/json");
    return JSON.parse(reply.body);
  };
  const ephemeral = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });

  it("edits the message on a decision: links and buttons gone", () => {
    const out = reply({ status: "decided", decision: "approved", by: `discord:${ALICE} (Alice)`, at });
    expect(out).toEqual({ type: 7, data: { content: "Refund RM 20?\n\nApproved by Alice at 14:02 UTC", components: [], allowed_mentions: { parse: [] } } });
    expect(reply({ status: "decided", decision: "rejected", by: `discord:${ALICE} (Alice)`, at }).data.content).toBe("Refund RM 20?\n\nRejected by Alice at 14:02 UTC");
  });

  it("tells only the clicker otherwise", () => {
    expect(reply({ status: "already", decision: "approved", via: "chat", by: `discord:${ALICE} (Alice)`, at })).toEqual(ephemeral("Already approved by Alice"));
    expect(reply({ status: "already", decision: "rejected", via: "link", at })).toEqual(ephemeral("Already rejected with a link"));
    expect(reply({ status: "expired" })).toEqual(ephemeral("This request has expired or was already decided."));
    expect(reply({ status: "unknown" })).toEqual(ephemeral("This request has expired or was already decided."));
    expect(reply({ status: "not-approver" })).toEqual(ephemeral("You're not on the approver list for this."));
    expect(reply({ status: "foreign" })).toEqual(ephemeral("This button belongs to another actuator."));
  });

  it("escapes markdown in names and never carries a link", () => {
    const out = reply({ status: "decided", decision: "approved", by: `discord:${ALICE} (*Bo* @everyone)`, at });
    expect(out.data.content).toBe("Refund RM 20?\n\nApproved by \\*Bo\\* \\@everyone at 14:02 UTC");
    expect(out.data.content).not.toMatch(/https?:/);
  });
});

describe("discord approval rendering", () => {
  const sentBody = (call: { body: string }) => JSON.parse(call.body);

  it("puts interactive Approve and Reject buttons on a bot message", async () => {
    const { fetch, calls } = mockFetch(json({ id: "9" }));
    const out = await discord.create(bot, context(fetch)).send(CHANNEL, TEXT, { approval: approval(), idempotencyKey: "approval:r1:ok" });
    expect(out).toEqual({ id: "9", channel: "discord" });
    expect(calls[0]!.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
    const body = sentBody(calls[0]!);
    expect(body.content).toBe(TEXT);
    expect(body).toMatchObject({ enforce_nonce: true, nonce: expect.any(String), allowed_mentions: { parse: ["users"] } });
    expect(body.flags).toBeUndefined();
    expect(body.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "Approve", custom_id: `ap1:local:${NONCE}:a` },
          { type: 2, style: 4, label: "Reject", custom_id: `ap1:local:${NONCE}:r` },
        ],
      },
    ]);
  });

  it("keeps custom_id within 100 characters at the longest route", async () => {
    const { fetch, calls } = mockFetch(json({ id: "9" }));
    await discord.create(bot, context(fetch)).send(CHANNEL, TEXT, { approval: approval({ buttons: { route: "R".repeat(24), nonce: NONCE } }) });
    for (const b of sentBody(calls[0]!).components[0].components) {
      expect(b.custom_id.length).toBeGreaterThanOrEqual(1);
      expect(b.custom_id.length).toBeLessThanOrEqual(DISCORD_MAX_CUSTOM_ID);
      expect(parseButtonPayload(b.custom_id)).toMatchObject({ route: "R".repeat(24) });
    }
  });

  it("uses link buttons through the bot without a public key or a nonce", async () => {
    const links = [{ type: 1, components: [{ type: 2, style: 5, label: "Approve", url: "https://self.test/approve?token=aaa" }, { type: 2, style: 5, label: "Reject", url: "https://self.test/approve?token=rrr" }] }];
    const { fetch, calls } = mockFetch(json({ id: "9" }));
    await discord.create(discord.parseCredentials({ botToken: "t" }), context(fetch)).send(CHANNEL, TEXT, { approval: approval() });
    await discord.create(bot, context(fetch)).send(CHANNEL, TEXT, { approval: approval({ buttons: undefined }) });
    expect(calls.map((c) => sentBody(c).components)).toEqual([links, links]);
  });

  it("sends link buttons through a channel webhook with with_components", async () => {
    const { fetch, calls } = mockFetch(json({ id: "9" }));
    await discord.create(webhookOnly, context(fetch)).send("", TEXT, { approval: approval() });
    expect(calls[0]!.url).toBe("https://discord.com/api/webhooks/123/abc-DEF?wait=true&with_components=true");
    const body = sentBody(calls[0]!);
    expect(body.content).toBe(TEXT);
    expect(body.components[0].components.map((b: { style: number; url: string; custom_id?: string }) => [b.style, b.url, b.custom_id])).toEqual([
      [5, "https://self.test/approve?token=aaa", undefined],
      [5, "https://self.test/approve?token=rrr", undefined],
    ]);
  });

  it("falls back to text when a URL is longer than 512 characters", async () => {
    const long = `https://self.test/approve?token=${"x".repeat(512 - 32 + 1)}`;
    expect(long.length).toBe(513);
    const fits = `https://self.test/approve?token=${"x".repeat(512 - 32)}`;
    const { fetch, calls } = mockFetch(json({ id: "9" }));
    await discord.create(webhookOnly, context(fetch)).send("", TEXT, { approval: approval({ rejectUrl: long }) });
    await discord.create(webhookOnly, context(fetch)).send("", TEXT, { approval: approval({ approveUrl: fits }) });
    await discord.create(discord.parseCredentials({ botToken: "t" }), context(fetch)).send(CHANNEL, TEXT, { approval: approval({ approveUrl: long }) });
    expect(calls[0]!.url).toBe("https://discord.com/api/webhooks/123/abc-DEF?wait=true");
    expect(sentBody(calls[0]!)).toEqual({ content: TEXT, allowed_mentions: { parse: ["users"] } });
    expect(sentBody(calls[1]!).components[0].components[0].url).toBe(fits);
    expect(sentBody(calls[2]!).components).toBeUndefined();
  });

  it("gives an input request an Answer link button", async () => {
    const input: ApprovalPrompt = { kind: "input", actuator: "a", step: "s", answerUrl: "https://self.test/answer?token=q", expiresAt: 1 };
    const { fetch, calls } = mockFetch(json({ id: "9" }));
    await discord.create(bot, context(fetch)).send(CHANNEL, "Which one?\n\nAnswer: https://self.test/answer?token=q", { approval: input });
    await discord.create(webhookOnly, context(fetch)).send("", "x", { approval: { ...input, answerUrl: `https://self.test/${"q".repeat(600)}` } });
    expect(sentBody(calls[0]!).components).toEqual([{ type: 1, components: [{ type: 2, style: 5, label: "Answer", url: "https://self.test/answer?token=q" }] }]);
    expect(sentBody(calls[1]!).components).toBeUndefined();
  });

  it("sends the text alone when Discord refuses the components", async () => {
    const { fetch, calls } = mockFetch(json({ message: "Invalid Form Body" }, 400), json({ id: "10" }));
    const out = await discord.create(bot, context(fetch)).send(CHANNEL, TEXT, { approval: approval(), idempotencyKey: "k" });
    expect(out.id).toBe("10");
    expect(calls).toHaveLength(2);
    expect(sentBody(calls[1]!).components).toBeUndefined();
    expect(sentBody(calls[1]!).nonce).toBe(sentBody(calls[0]!).nonce);
    // Other errors are not retried, and never carry the token.
    const down = mockFetch(json({ message: "Missing Access" }, 403));
    const err = await failure(discord.create(bot, context(down.fetch)).send(CHANNEL, TEXT, { approval: approval() }));
    expect(down.calls).toHaveLength(1);
    expect(err.message).not.toContain("bot.token");
  });

  it("leaves ordinary messages alone", async () => {
    const { fetch, calls } = mockFetch(json({ id: "9" }));
    await discord.create(bot, context(fetch)).send(CHANNEL, "hello");
    await discord.create(webhookOnly, context(fetch)).send("", "hello");
    expect(sentBody(calls[0]!)).toEqual({ content: "hello", allowed_mentions: { parse: ["users"] } });
    expect(calls[1]!.url).toBe("https://discord.com/api/webhooks/123/abc-DEF?wait=true");
  });
});
