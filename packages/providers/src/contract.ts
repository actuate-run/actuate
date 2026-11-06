/**
 * The provider adapter contract. Credentials always belong to the person
 * running the actuator; an adapter never holds a shared account.
 */
import type { Capability, Json, Providers } from "@actuate/sdk";

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
