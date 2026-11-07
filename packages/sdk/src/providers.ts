import type { Json } from "./actuator.js";

/**
 * Capability provider interfaces. A tenant configures each with their own
 * credentials; the host injects a typed client into `ctx`.
 */

export interface MessagingProvider {
  /** Send a text message. `to` is a phone number, chat ID or email address, depending on the provider (a custom webhook passes it through as is). */
  send(to: string, text: string, options?: MessagingSendOptions): Promise<MessageReceipt>;
}

export interface MessagingSendOptions {
  /**
   * "html" sends a small HTML subset (<b>, <i>, <a href>, <code>, <pre>) where the
   * channel supports it (Telegram, email); other channels get the text with tags removed.
   * Default "text".
   */
  format?: "text" | "html";
  /** Which configured channel sends, when several are: "telegram", "whatsapp", "slack", "discord", "custom-webhook" or "email". Default: the first configured. */
  channel?: string;
  /** Email subject, when the channel is email. A custom webhook sends it too (`subject`, `{{subject}}`, or a Title header). */
  subject?: string;
  /** WhatsApp template name for messages outside the 24-hour service window. */
  template?: { name: string; language: string; variables?: string[] };
  /**
   * Passed to the provider when it supports deduplication (Resend; Discord with a bot token, for a few minutes; a custom
   * webhook derives its message `id` from it, so the receiver can drop a retried send).
   * Inside `ctx.step.do`, defaults to a key derived from the step's idempotency key: see `StepInfo.idempotencyKey`.
   */
  idempotencyKey?: string;
  /**
   * Set only by Actuate's own approval and input notifications (a `waitForApproval` or `waitForInput` with
   * `notify`), never by actuator code: the runtime removes it from sends made through `ctx.messaging`. A provider
   * that knows it can render the request (a card with link buttons); every other provider ignores it. The
   * message text always carries the same links too, so nothing is lost either way.
   */
  approval?: ApprovalPrompt;
}

/** A step waiting for a person, as an approval notification describes it to the messaging provider. */
export interface ApprovalPrompt {
  /** "approval" carries `approveUrl` and `rejectUrl`; "input" carries `answerUrl`. */
  kind: "approval" | "input";
  actuator: string;
  step: string;
  /** The approval message, or the question for input (secret config values redacted). */
  message?: string;
  /** Signed links to the confirm page: opening one shows the page (GET), and only the page's button decides (POST). */
  approveUrl?: string;
  rejectUrl?: string;
  answerUrl?: string;
  /** When the links stop working, epoch ms. */
  expiresAt: number;
  /**
   * Present on approvals (never on input) when the runtime made a button nonce for this request: a provider that
   * can take button clicks (Telegram with a webhook secret token, Slack with a signing secret, Discord with a bot
   * token and public key) puts `encodeButtonPayload({ route, nonce, action })` from `@actuate/providers` on its
   * Approve and Reject buttons. `route` names the actuator that owns the request ("local" when self-hosted, the
   * actuator ID on the hosted platform); `nonce` is random, single-use and expires with the links. The nonce alone
   * decides nothing: a click must also be verified by the provider and come from an allowed approver.
   */
  buttons?: { route: string; nonce: string };
}

// ---------------------------------------------------------------- interactive approval buttons
// The contract between chat provider adapters (`@actuate/providers`) and the runtimes that receive button clicks.
// Actuator code never sees these.

/** An HTTP reply a provider needs sent back verbatim (a Discord PONG, a Telegram method call, a Slack ack). */
export interface ProviderReply {
  status: number;
  /** Default `text/plain; charset=utf-8`. */
  contentType?: string;
  body: string;
}

/** The person who clicked, as the provider verified them. */
export interface ButtonActor {
  /** The provider's user ID: a Telegram numeric user ID, a Slack member ID (U.../W...), a Discord user ID. */
  id: string;
  /** Display name, when the provider gives one. Not verified: the person chose it. */
  name?: string;
  /** Role IDs, when the provider gives them (Discord guild members), for `role:<id>` approver entries. */
  roles?: string[];
}

/** A verified Approve or Reject click, from `ProviderDefinition.parseInteraction`. */
export interface ButtonClick {
  /** From the button payload: the actuator the request belongs to ("local" when self-hosted). */
  route: string;
  nonce: string;
  action: "approve" | "reject";
  actor: ButtonActor;
  /** Provider data respondInteraction needs (message ids, response_url, interaction token...). Never logged. */
  context: Json;
}

/**
 * What became of a click, for `ProviderDefinition.respondInteraction`: "decided" (this click decided), "already"
 * (decided before, by a button, a link or the dashboard), "expired" or "unknown" (expired, or no longer waiting),
 * "not-approver" (the clicker isn't on the provider's approver list) or "foreign" (the button belongs to another
 * actuator). `by` is a verified approver label (`<channel>:<user id> (<name>)`) or, for a decision made another
 * way, what that decision recorded; `at` is ISO 8601.
 */
export type ClickOutcome =
  | { status: "decided" | "already"; decision: "approved" | "rejected"; by: string; at: string }
  | { status: "expired" | "unknown" | "not-approver" | "foreign" };

/**
 * One configured chat provider's click handling, bound to its credentials: what a runtime calls on
 * `POST /providers/<kind>/webhook`. `@actuate/providers` builds one with `providerInteractions(definition,
 * credentials)` or `providerInteractionsFromEnv(env, kind)`.
 */
export interface ProviderInteractions {
  kind: string;
  /** `ProviderDefinition.parseInteraction`: leaves `request`'s body unread, so on null it can go to parseWebhook. */
  parse(request: Request): Promise<{ reply: ProviderReply } | { click: ButtonClick } | null>;
  /** `ProviderDefinition.isApprover`, true when the provider has no approver list. */
  isApprover(actor: ButtonActor): boolean;
  /** `ProviderDefinition.respondInteraction`: the reply to send now, and work to run after it (in `waitUntil`). */
  respond(click: ButtonClick, outcome: ClickOutcome): { reply: ProviderReply; after?: () => Promise<void> };
}

export interface MessageReceipt {
  id: string;
  channel: string;
}

export interface PaymentProvider {
  /** Create a payment link (a bill) and return its URL and provider ID. */
  createBill(request: CreateBillRequest): Promise<Bill>;
  /** Look up a bill's current status. */
  getBill(id: string): Promise<Bill>;
  /** Refund a paid bill, in full or in part. Not every provider supports this. */
  refund?(request: RefundRequest): Promise<{ id: string; status: "pending" | "succeeded" | "failed" }>;
}

export interface CreateBillRequest {
  /** Amount in major units, e.g. 50 for RM 50.00. */
  amount: number;
  /** ISO 4217 code. Defaults to "MYR". */
  currency?: string;
  /** Your own reference. The payment webhook carries it back as event `payment.<referenceId>`. */
  referenceId: string;
  description?: string;
  customer?: { name?: string; email?: string; phone?: string };
  /** Where the payer is sent after paying. */
  returnUrl?: string;
  /**
   * Passed to the provider when it supports deduplication (Stripe). Inside `ctx.step.do`, defaults to a key
   * derived from the step's idempotency key: see `StepInfo.idempotencyKey`.
   */
  idempotencyKey?: string;
}

export interface Bill {
  id: string;
  url: string;
  status: "pending" | "paid" | "failed" | "expired" | "refunded";
  amount: number;
  currency: string;
  referenceId: string;
}

/**
 * Payload of the `payment.<referenceId>` event a payment provider's webhook
 * delivers. Wait for it with `ctx.step.waitForEvent("paid", { event: \`payment.${referenceId}\` })`.
 * Before acting on it, check `status` and that `billId`, `amount` and `currency` match the bill you created:
 * use a reference nobody else can guess (e.g. include `ctx.runId`), and don't trust the event alone for a large amount.
 */
export interface PaymentEvent {
  provider: string;
  status: "paid" | "failed" | "expired" | "refunded" | "pending";
  referenceId: string;
  billId?: string;
  amount?: number;
  currency?: string;
}

/**
 * An inbound chat message, delivered as the event `message.<channel>.<from>` when the
 * messaging provider is set up to receive (WhatsApp app secret, Telegram webhook secret token, custom webhook signing secret).
 * Wait for a reply with `ctx.step.waitForEvent("reply", { event: \`message.whatsapp.${phone}\` })`.
 */
export interface InboundMessage {
  channel: string;
  /**
   * Who sent it, in the form `send(to)` accepts: a WhatsApp phone number (digits), a Telegram chat ID, or for a
   * custom webhook, the `from` its endpoint posted.
   */
  from: string;
  /** The text, a button's title, or a media caption. Empty for media without a caption. */
  text: string;
  /** "text", "button", "image", "audio", "location", ... as the provider reports it. */
  type: string;
  /** The provider's message ID. */
  id: string;
  /** When the provider says it was sent, in ms since the epoch. */
  at: number;
  /** The sender's display name, when the provider includes it. */
  name?: string;
}

export interface RefundRequest {
  billId: string;
  /** Major units. Omit for a full refund. */
  amount?: number;
  reason?: string;
  /**
   * Passed to the provider when it supports deduplication (Stripe). Inside `ctx.step.do`, defaults to a key
   * derived from the step's idempotency key: see `StepInfo.idempotencyKey`.
   */
  idempotencyKey?: string;
}

export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface LlmRequest {
  model?: string;
  system?: string;
  prompt?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Outbound HTTP restricted to the domains the actuator declares in `http.allow`. */
export interface HttpProvider {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface Providers {
  messaging: MessagingProvider;
  payment: PaymentProvider;
  llm: LlmProvider;
  http: HttpProvider;
}

export type Capability = keyof Providers;
export const CAPABILITIES: readonly Capability[] = ["messaging", "payment", "llm", "http"];
