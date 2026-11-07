import { describe, expect, it } from "vitest";
import {
  MAX_BUTTON_PAYLOAD_BYTES,
  approverDisplayName,
  clickOutcomeText,
  decidedMessageText,
  encodeButtonPayload,
  formatApprovers,
  isListedApprover,
  parseApprovers,
  parseButtonPayload,
  providerInteractions,
  withoutLinkLines,
  type ApproverRules,
  type ProviderDefinition,
} from "../src/index.js";

const NONCE = "AbCdEfGhIjKl-_09";
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("button payloads", () => {
  it("encodes and parses approve and reject", () => {
    expect(encodeButtonPayload({ route: "local", nonce: NONCE, action: "approve" })).toBe(`ap1:local:${NONCE}:a`);
    expect(encodeButtonPayload({ route: "act_0123456789abcdef", nonce: NONCE, action: "reject" })).toBe(`ap1:act_0123456789abcdef:${NONCE}:r`);
    for (const action of ["approve", "reject"] as const) {
      const p = { route: "act_0123456789abcdef", nonce: NONCE, action };
      expect(parseButtonPayload(encodeButtonPayload(p))).toEqual(p);
    }
  });

  it("stays within 64 bytes at the longest route", () => {
    const longest = encodeButtonPayload({ route: "R".repeat(24), nonce: NONCE, action: "approve" });
    expect(bytes(longest)).toBe(47);
    expect(bytes(longest)).toBeLessThanOrEqual(MAX_BUTTON_PAYLOAD_BYTES);
    expect(parseButtonPayload(longest)).toMatchObject({ route: "R".repeat(24) });
  });

  it("refuses to encode bad parts", () => {
    const bad = [
      { route: "", nonce: NONCE, action: "approve" },
      { route: "R".repeat(25), nonce: NONCE, action: "approve" },
      { route: "has:colon", nonce: NONCE, action: "approve" },
      { route: "spa ce", nonce: NONCE, action: "approve" },
      { route: "ünï", nonce: NONCE, action: "approve" },
      { route: "local", nonce: NONCE.slice(1), action: "approve" },
      { route: "local", nonce: `${NONCE}x`, action: "approve" },
      { route: "local", nonce: "AbCdEfGhIjKl+/09", action: "approve" },
      { route: "local", nonce: NONCE, action: "a" },
      { route: 1, nonce: NONCE, action: "approve" },
    ];
    for (const p of bad) expect(() => encodeButtonPayload(p as never)).toThrow();
    expect(() => encodeButtonPayload(undefined as never)).toThrow();
  });

  it("parses strictly", () => {
    const bad = [
      undefined,
      null,
      42,
      "",
      `ap2:local:${NONCE}:a`,
      `AP1:local:${NONCE}:a`,
      `ap1:local:${NONCE}:x`,
      `ap1:local:${NONCE}:approve`,
      `ap1:local:${NONCE}`,
      `ap1::${NONCE}:a`,
      `ap1:${"R".repeat(25)}:${NONCE}:a`,
      `ap1:lo:cal:${NONCE}:a`,
      `ap1:local:${NONCE.slice(1)}:a`,
      `ap1:local:${NONCE}x:a`,
      ` ap1:local:${NONCE}:a`,
      `ap1:local:${NONCE}:a `,
      `ap1:local:${NONCE}:a\n`,
      `ap1:lócal:${NONCE}:a`,
      `ap1:local:${NONCE}:a`.padEnd(65, "x"),
      "approve",
    ];
    for (const v of bad) expect(parseButtonPayload(v), String(v)).toBeNull();
  });
});

describe("approver lists", () => {
  const slack: ApproverRules = { provider: "Slack", user: /^[UW][A-Z0-9]{2,}$/, userHint: "Slack member IDs (U... or W...)" };
  const discord: ApproverRules = { provider: "Discord", user: /^\d{17,20}$/, userHint: "Discord user IDs", role: /^\d{17,20}$/ };

  it("splits on whitespace and commas, drops duplicates, and is null when empty", () => {
    expect(parseApprovers("U01ABC, W02DEF\n U01ABC\tU03GHI", slack)).toEqual({ users: ["U01ABC", "W02DEF", "U03GHI"], roles: [] });
    for (const empty of [undefined, null, "", "  ", " , ,\n"]) expect(parseApprovers(empty, slack)).toBeNull();
  });

  it("takes role:<id> entries only where the provider has roles", () => {
    const list = parseApprovers("123456789012345678 role:876543210987654321,ROLE:111111111111111111", discord);
    expect(list).toEqual({ users: ["123456789012345678"], roles: ["876543210987654321", "111111111111111111"] });
    expect(formatApprovers(list)).toBe("123456789012345678 role:876543210987654321 role:111111111111111111");
    expect(formatApprovers(null)).toBeUndefined();
    expect(() => parseApprovers("role:U01ABC", slack)).toThrow(/Slack member IDs/);
    expect(() => parseApprovers("role:abc", discord)).toThrow(/role:<role ID>/);
  });

  it("names the bad entries in one readable error", () => {
    expect(() => parseApprovers("U01ABC alice @bob", slack)).toThrow('Invalid Slack credentials: approvers must be Slack member IDs (U... or W...), separated by spaces or commas (not "alice", "@bob")');
    expect(() => parseApprovers(42, slack)).toThrow(/must be a string/);
    expect(() => parseApprovers(Array.from({ length: 101 }, (_, i) => `U${i}AA`).join(" "), slack)).toThrow(/at most 100/);
  });

  it("matches users and roles, and lets everyone through without a list", () => {
    const list = parseApprovers("123456789012345678 role:876543210987654321", discord);
    expect(isListedApprover(list, { id: "123456789012345678" })).toBe(true);
    expect(isListedApprover(list, { id: "999999999999999999", roles: ["876543210987654321"] })).toBe(true);
    expect(isListedApprover(list, { id: "999999999999999999", roles: ["5"] })).toBe(false);
    expect(isListedApprover(list, { id: "999999999999999999" })).toBe(false);
    expect(isListedApprover(null, { id: "anyone" })).toBe(true);
    expect(isListedApprover({ users: [], roles: [] }, { id: "anyone" })).toBe(true);
  });
});

describe("what the clicker sees", () => {
  const at = "2026-11-07T14:02:59.000Z";

  it("words each outcome", () => {
    expect(clickOutcomeText({ status: "decided", decision: "approved", by: "telegram:123 (Alice)", at })).toBe("Approved by Alice at 14:02 UTC");
    expect(clickOutcomeText({ status: "decided", decision: "rejected", by: "slack:U01ABC", at })).toBe("Rejected by slack:U01ABC at 14:02 UTC");
    expect(clickOutcomeText({ status: "already", decision: "approved", by: "discord:1 (Bo (the) Boss)", at })).toBe("Already approved by Bo (the) Boss");
    expect(clickOutcomeText({ status: "already", decision: "rejected", by: "owner@example.com", at })).toBe("Already rejected by owner@example.com");
    expect(clickOutcomeText({ status: "expired" })).toBe("This request has expired or was already decided.");
    expect(clickOutcomeText({ status: "unknown" })).toBe("This request has expired or was already decided.");
    expect(clickOutcomeText({ status: "not-approver" })).toBe("You're not on the approver list for this.");
    expect(clickOutcomeText({ status: "foreign" })).toBe("This button belongs to another actuator.");
    expect(approverDisplayName("")).toBe("someone");
    expect(approverDisplayName("a\u0000b")).toBe("a b");
  });

  it("drops the link lines from an edited message", () => {
    const text = "Refund RM 20 to Ali?\nOrder O-1\n\nApprove: https://bot.example/approve?token=abc\nReject: https://bot.example/approve?token=def";
    expect(withoutLinkLines(text)).toBe("Refund RM 20 to Ali?\nOrder O-1");
    expect(withoutLinkLines("Q?\n\nAnswer: <https://x.test/approve?token=t|open>")).toBe("Q?");
    expect(withoutLinkLines("See https://x.test/approve?a=1&token=t now\nkeep")).toBe("keep");
    expect(withoutLinkLines("Approve: the refund\nkeep https://example.com/page")).toBe("Approve: the refund\nkeep https://example.com/page");
    expect(decidedMessageText(text, { status: "decided", decision: "approved", by: "telegram:1 (Alice)", at })).toBe(
      "Refund RM 20 to Ali?\nOrder O-1\n\nApproved by Alice at 14:02 UTC",
    );
    expect(decidedMessageText("Approve: https://x/approve?token=1", { status: "decided", decision: "rejected", by: "a", at })).toBe("Rejected by a at 14:02 UTC");
  });
});

describe("providerInteractions", () => {
  it("binds a definition's click handling to its credentials", async () => {
    const def = {
      kind: "fake",
      capability: "messaging",
      label: "Fake",
      credentialFields: [],
      parseCredentials: (x: unknown) => x as { approvers?: string },
      create: () => ({ send: async () => ({ id: "1", channel: "fake" }) }),
      async parseInteraction(request: Request) {
        return { click: { route: "local", nonce: NONCE, action: "approve" as const, actor: { id: await request.clone().text() }, context: {} } };
      },
      isApprover: (actor: { id: string }, c: { approvers?: string }) => c.approvers === actor.id,
      respondInteraction: (_click: unknown, outcome: { status: string }) => ({ reply: { status: 200, body: outcome.status } }),
    } satisfies ProviderDefinition<{ approvers?: string }, "messaging">;
    const bound = providerInteractions(def, { approvers: "me" })!;
    const request = new Request("https://x.test", { method: "POST", body: "me" });
    const parsed = await bound.parse(request);
    expect(parsed).toMatchObject({ click: { actor: { id: "me" } } });
    expect(await request.text()).toBe("me"); // left for parseWebhook
    expect(bound.isApprover({ id: "me" })).toBe(true);
    expect(bound.isApprover({ id: "you" })).toBe(false);
    expect(bound.respond({} as never, { status: "foreign" }).reply).toEqual({ status: 200, body: "foreign" });
    // All three or none: leaving out the approver check never fails open.
    expect(providerInteractions({ ...def, isApprover: undefined }, {})).toBeNull();
    expect(providerInteractions({ ...def, respondInteraction: undefined }, {})).toBeNull();
    expect(providerInteractions({ ...def, parseInteraction: undefined }, {})).toBeNull();
  });
});
