/**
 * Capability provider interfaces. A tenant configures each with their own
 * credentials; the host injects a typed client into `ctx`.
 */

export interface MessagingProvider {
  /** Send a text message. `to` is a phone number, chat ID or email address, depending on the provider. */
  send(to: string, text: string, options?: MessagingSendOptions): Promise<MessageReceipt>;
}

export interface MessagingSendOptions {
  /**
   * "html" sends a small HTML subset (<b>, <i>, <a href>, <code>, <pre>) where the
   * channel supports it (Telegram, email); other channels get the text with tags removed.
   * Default "text".
   */
  format?: "text" | "html";
  /** Provider-specific channel override, e.g. "telegram" | "whatsapp" | "email". */
  channel?: string;
  /** Email subject, when the channel is email. */
  subject?: string;
  /** WhatsApp template name for messages outside the 24-hour service window. */
  template?: { name: string; language: string; variables?: string[] };
  /** Passed to the provider when it supports deduplication. Defaults to the current step's idempotency key. */
  idempotencyKey?: string;
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
 * messaging provider is set up to receive (WhatsApp app secret, Telegram webhook secret token).
 * Wait for a reply with `ctx.step.waitForEvent("reply", { event: \`message.whatsapp.${phone}\` })`.
 */
export interface InboundMessage {
  channel: string;
  /** Who sent it, in the form `send(to)` accepts: a WhatsApp phone number (digits) or a Telegram chat ID. */
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
