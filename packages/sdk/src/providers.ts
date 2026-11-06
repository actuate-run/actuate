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
