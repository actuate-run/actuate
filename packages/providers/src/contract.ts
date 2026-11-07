/**
 * The provider adapter contract. Credentials always belong to the person
 * running the actuator; an adapter never holds a shared account.
 */
import type { ButtonActor, ButtonClick, Capability, ClickOutcome, Json, ProviderReply, Providers } from "@actuate/sdk";

// The interactive button types live in @actuate/sdk so the runtime and the platform share one definition.
export type { ButtonActor, ButtonClick, ClickOutcome, ProviderInteractions, ProviderReply } from "@actuate/sdk";

export type ProviderCapability = Exclude<Capability, "http">;

/** An inbound provider webhook mapped to an actuator event. */
export interface ProviderEvent {
  event: string;
  payload: Json;
}

/** One webhook can carry several events (WhatsApp batches messages), or none. */
export type ProviderWebhookResult = ProviderEvent | ProviderEvent[] | null;

export interface ProviderContext {
  fetch: typeof fetch;
  /**
   * Absolute URL that receives this provider's webhooks for this actuator.
   * Payment providers pass it as the per-bill callback URL where the API supports one.
   */
  webhookUrl: string;
  /** Where payers return after paying, when the request does not give one. */
  defaultReturnUrl: string;
}

export interface ProviderDefinition<C = unknown, K extends ProviderCapability = ProviderCapability> {
  kind: string;
  capability: K;
  /** Human name for forms. */
  label: string;
  /** Validate and normalise credentials. Throws with a readable message. */
  parseCredentials(input: unknown): C;
  /** Fields for a credential form; also the source of environment variable names (see `providersFromEnv`). */
  credentialFields: Array<{
    key: string;
    label: string;
    secret: boolean;
    help?: string;
    optional?: boolean;
    /** Render a textarea: the value spans several lines (extra headers, a JSON template). */
    multiline?: boolean;
    /** The accepted values, for a select. Leaving the field empty picks the provider's default, which its help explains. */
    options?: readonly string[];
    /** Offer a "Generate" button: "whsec" makes a Standard Webhooks secret (whsec_ + base64 of 32 random bytes). */
    generate?: "whsec";
  }>;
  create(credentials: C, ctx: ProviderContext): Providers[K];
  /**
   * Verify and translate an inbound webhook. Return null for webhooks that are
   * valid but irrelevant; throw `WebhookVerificationError` when the signature is wrong.
   * Payment providers emit `payment.<referenceId>` with a `PaymentEvent` payload.
   */
  parseWebhook?(request: Request, credentials: C, ctx?: Pick<ProviderContext, "fetch">): Promise<ProviderWebhookResult>;
  /**
   * Answer a subscription handshake, such as Meta's `GET ?hub.mode=subscribe&hub.challenge=...`.
   * Returns the plain-text reply, or null when the request is not a handshake. Throws
   * `WebhookVerificationError` when the verify token is wrong.
   */
  handshake?(request: Request, credentials: C): string | null;

  // ---------------------------------------------------------------- interactive approval buttons
  // Optional. A chat provider that takes button clicks implements parseInteraction, isApprover and
  // respondInteraction all three (without any one of them, `providerInteractions` treats it as taking no clicks);
  // routeHint too, for the hosted platform's interactions URL. Rendering is send()'s job: when
  // `options.approval.buttons` is set and the credentials allow interactive buttons, put
  // `encodeButtonPayload({ ...options.approval.buttons, action })` on an Approve and a Reject button; otherwise
  // (no buttons, or credentials that can't receive clicks) render link buttons to `approveUrl` / `rejectUrl`
  // where the channel can. The text always keeps the links.

  /**
   * UNVERIFIED: the button route (`ButtonClick.route`) read from a raw interaction body, before any signature
   * check, so the hosted platform's tenant-level interactions URL can forward the request to the right actuator,
   * which then verifies it. Null when the body carries no button payload (a Discord PING). Never trust it for
   * anything else.
   */
  routeHint?(body: string, contentType: string | null): string | null;
  /**
   * Verify an inbound request and recognise a button click. Returns `{ click }` for an Approve or Reject click
   * whose payload parses (`parseButtonPayload`), `{ reply }` for a request the provider needs answered verbatim
   * (a Discord PING, a click on something that isn't ours, which still needs an ack), or null when the request is
   * not an interaction at all, so the caller falls through to `parseWebhook` (Telegram messages and callback
   * queries share one webhook). Throws `WebhookVerificationError` when the signature, secret token or timestamp is
   * wrong (the caller answers 401).
   *
   * The body: read it from `request.clone()`, never from `request` itself, because on null the caller hands the
   * same request to `parseWebhook`. Read it once, as text, and verify the signature over those exact bytes.
   */
  parseInteraction?(request: Request, credentials: C, ctx?: Pick<ProviderContext, "fetch">): Promise<{ reply: ProviderReply } | { click: ButtonClick } | null>;
  /**
   * Whether this verified person may decide with a button: listed in the credentials' `approvers`
   * (`parseApprovers`, `isListedApprover`), or true when no approver list is configured. The list restricts
   * buttons only: the signed links in the message still work for whoever holds them.
   */
  isApprover?(actor: ButtonActor, credentials: C): boolean;
  /**
   * Build the HTTP reply to a click, and optionally follow-up work run after it is sent (in `waitUntil`), such as
   * editing the message through the API. Synchronous: the reply has to go out within the provider's deadline
   * (3 seconds for Slack and Discord). Use `clickOutcomeText` and `decidedMessageText` for the wording: on
   * "decided", edit the original message (links removed, buttons removed, "Approved by ... at HH:MM UTC");
   * otherwise tell only the clicker, without editing. No reply, edit or thrown error may contain a token, a secret,
   * a signed link or a response_url.
   */
  respondInteraction?(
    click: ButtonClick,
    outcome: ClickOutcome,
    credentials: C,
    ctx: Pick<ProviderContext, "fetch">,
  ): { reply: ProviderReply; after?: () => Promise<void> };
}

export class WebhookVerificationError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const enc = new TextEncoder();

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- button payloads

/** Version prefix of a button payload. */
export const BUTTON_PAYLOAD_PREFIX = "ap1";
/** Longest button payload, bytes: Telegram's `callback_data` limit (Discord's `custom_id` allows 100, Slack's `value` 2000). */
export const MAX_BUTTON_PAYLOAD_BYTES = 64;
/** A route: the actuator a button belongs to ("local" self-hosted, the actuator ID on the platform). */
const ROUTE = /^[A-Za-z0-9_-]{1,24}$/;
/** A button nonce: 96 random bits, base64url (16 characters). */
const NONCE = /^[A-Za-z0-9_-]{16}$/;
const PAYLOAD = /^ap1:([A-Za-z0-9_-]{1,24}):([A-Za-z0-9_-]{16}):([ar])$/;

/** What an Approve or Reject button carries. */
export interface ButtonPayload {
  route: string;
  nonce: string;
  action: "approve" | "reject";
}

/**
 * `ap1:<route>:<nonce>:<a|r>`, the value for a button's `callback_data` (Telegram), `value` (Slack) or `custom_id`
 * (Discord). At most 47 bytes. Throws for a route that isn't 1-24 characters of `[A-Za-z0-9_-]`, a nonce that
 * isn't 16 base64url characters, or an unknown action.
 */
export function encodeButtonPayload(payload: ButtonPayload): string {
  const { route, nonce, action } = payload ?? ({} as ButtonPayload);
  if (typeof route !== "string" || !ROUTE.test(route)) throw new Error("Button route must be 1-24 characters of A-Z, a-z, 0-9, _ and -");
  if (typeof nonce !== "string" || !NONCE.test(nonce)) throw new Error("Button nonce must be 16 base64url characters");
  if (action !== "approve" && action !== "reject") throw new Error('Button action must be "approve" or "reject"');
  const out = `${BUTTON_PAYLOAD_PREFIX}:${route}:${nonce}:${action === "approve" ? "a" : "r"}`;
  if (new TextEncoder().encode(out).length > MAX_BUTTON_PAYLOAD_BYTES) throw new Error("Button payload is too long");
  return out;
}

/** The payload of an Approve or Reject button, or null for anything else (another app's button, a bad value). Strict: no whitespace, no case folding. */
export function parseButtonPayload(value: unknown): ButtonPayload | null {
  if (typeof value !== "string" || value.length > MAX_BUTTON_PAYLOAD_BYTES) return null;
  const m = PAYLOAD.exec(value);
  if (!m) return null;
  return { route: m[1]!, nonce: m[2]!, action: m[3] === "a" ? "approve" : "reject" };
}

// ---------------------------------------------------------------- approver lists

/** A parsed `approvers` credential: user IDs, and role IDs from `role:<id>` entries. */
export interface ApproverList {
  users: string[];
  roles: string[];
}

export interface ApproverRules {
  /** The provider name for messages, e.g. "Slack". */
  provider: string;
  /** What a user ID looks like, e.g. `/^[UW][A-Z0-9]{2,}$/` for Slack member IDs. */
  user: RegExp;
  /** How to describe a user ID in an error, e.g. "Slack member IDs (U... or W...)". */
  userHint: string;
  /** What a role ID looks like; when set, `role:<id>` entries are accepted (Discord). */
  role?: RegExp;
}

/** Most entries in one approver list. */
export const MAX_APPROVERS = 100;

/**
 * Parse an `approvers` credential: entries separated by whitespace or commas, each a user ID or, when the
 * provider has roles, `role:<id>`. Returns null for an empty or missing list (everyone in the chat may click).
 * Throws one readable error naming the bad entries (they are IDs, not secrets), for a provider's parseCredentials.
 * Duplicates are dropped.
 */
export function parseApprovers(value: unknown, rules: ApproverRules): ApproverList | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid ${rules.provider} credentials: approvers must be a string of IDs`);
  const entries = value.split(/[\s,]+/).filter(Boolean);
  if (entries.length === 0) return null;
  if (entries.length > MAX_APPROVERS) throw new Error(`Invalid ${rules.provider} credentials: approvers lists at most ${MAX_APPROVERS} entries`);
  const users = new Set<string>();
  const roles = new Set<string>();
  const bad: string[] = [];
  for (const entry of entries) {
    const role = /^role:(.*)$/i.exec(entry);
    if (role) {
      if (rules.role && rules.role.test(role[1]!)) roles.add(role[1]!);
      else bad.push(entry);
    } else if (rules.user.test(entry)) users.add(entry);
    else bad.push(entry);
  }
  if (bad.length) {
    const shown = bad.slice(0, 5).map((b) => JSON.stringify(b.slice(0, 40))).join(", ");
    const accepted = rules.role ? `${rules.userHint}, or role:<role ID>` : rules.userHint;
    throw new Error(`Invalid ${rules.provider} credentials: approvers must be ${accepted}, separated by spaces or commas (not ${shown}${bad.length > 5 ? ", ..." : ""})`);
  }
  return { users: [...users], roles: [...roles] };
}

/** `parseApprovers` normalised back to one string ("U1 U2 role:9"), or undefined when empty: what a credential stores. */
export function formatApprovers(list: ApproverList | null): string | undefined {
  if (!list) return undefined;
  const all = [...list.users, ...list.roles.map((r) => `role:${r}`)];
  return all.length ? all.join(" ") : undefined;
}

/** True when the actor is listed (by user ID, or by one of their roles), or when there is no list. */
export function isListedApprover(list: ApproverList | null, actor: ButtonActor): boolean {
  if (!list || (list.users.length === 0 && list.roles.length === 0)) return true;
  if (list.users.includes(actor.id)) return true;
  return (actor.roles ?? []).some((r) => list.roles.includes(r));
}

/** The `approvers` credential field for a provider's form, with the provider's own help text. */
export function approversCredentialField(help: string): ProviderDefinition["credentialFields"][number] {
  return { key: "approvers", label: "Approvers", secret: false, optional: true, help };
}

// ---------------------------------------------------------------- what the clicker sees

/** The display name in an approver label: "Alice" from "telegram:123 (Alice)"; the label itself otherwise. */
export function approverDisplayName(by: string): string {
  const clean = String(by ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const m = /^[a-z0-9-]+:\S+ \((.+)\)$/.exec(clean);
  return (m ? m[1]! : clean).slice(0, 80) || "someone";
}

/** "14:02 UTC" from an ISO timestamp. */
function hhmmUtc(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** How "already" names a decision made without a chat button: never by who made it. */
const ALREADY_VIA: Record<"link" | "dashboard" | "api", string> = {
  dashboard: "in the dashboard",
  api: "through the API",
  link: "with a link",
};

/**
 * The short plain-text line a click's outcome shows (no links, no markup: escape it for the channel's format):
 *
 * - decided: "Approved by Alice at 14:02 UTC" / "Rejected by Alice at 14:02 UTC" (for the edited message)
 * - already: "Already approved by Alice" / "Already rejected by Alice" after a chat decision, "Already approved in
 *   the dashboard", "Already approved through the API" or "Already approved with a link" after any other (to the
 *   clicker only, never naming who decided that way)
 * - expired, unknown: "This request has expired or was already decided."
 * - not-approver: "You're not on the approver list for this."
 * - foreign: "This button belongs to another actuator."
 */
export function clickOutcomeText(outcome: ClickOutcome): string {
  switch (outcome.status) {
    case "decided": {
      const at = hhmmUtc(outcome.at);
      return `${outcome.decision === "approved" ? "Approved" : "Rejected"} by ${approverDisplayName(outcome.by)}${at ? ` at ${at}` : ""}`;
    }
    case "already":
      if (outcome.via === "chat") return `Already ${outcome.decision} by ${approverDisplayName(outcome.by)}`;
      return `Already ${outcome.decision} ${ALREADY_VIA[outcome.via] ?? ALREADY_VIA.link}`;
    case "not-approver":
      return "You're not on the approver list for this.";
    case "foreign":
      return "This button belongs to another actuator.";
    default:
      return "This request has expired or was already decided.";
  }
}

const LINK_LINE = /^\s*(?:approve|reject|answer)\s*:\s*<?https?:\/\//i;
const TOKEN_URL = /https?:\/\/\S*[?&]token=/i;

/**
 * The message text without the lines that carry signed links ("Approve: https://...", "Reject: ...",
 * "Answer: ...", or any line with a `?token=` URL), blank runs collapsed: what an edited message keeps.
 */
export function withoutLinkLines(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !LINK_LINE.test(line) && !TOKEN_URL.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The edited message for a decided click: the original text without its link lines, then "Approved by ... at HH:MM UTC". */
export function decidedMessageText(original: string, outcome: Extract<ClickOutcome, { decision: string }> & { status: "decided" }): string {
  const kept = withoutLinkLines(original);
  const line = clickOutcomeText(outcome);
  return kept ? `${kept}\n\n${line}` : line;
}

/** A plain-text {@link ProviderReply}. */
export function textReply(body: string, status = 200): ProviderReply {
  return { status, contentType: "text/plain; charset=utf-8", body };
}

/** A JSON {@link ProviderReply}. */
export function jsonReply(body: unknown, status = 200): ProviderReply {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}
