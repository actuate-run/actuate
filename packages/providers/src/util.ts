/** Helpers shared by the provider adapters. Workers-safe: WebCrypto and fetch only. */
import { z } from "zod";
import type { ProviderCapability, ProviderContext, ProviderDefinition, ProviderEvent } from "./contract.js";
import type { LlmRequest } from "@actuate/sdk";

/** An error response from a third-party API, with a message safe to show the tenant (never contains credentials). */
export class ProviderApiError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider} API error (HTTP ${status}): ${detail}`);
    this.name = "ProviderApiError";
  }
}

/** Thrown for operations a provider's API does not offer. */
export class NotSupportedError extends Error {
  constructor(provider: string, operation: string) {
    super(`${operation} is not supported by ${provider}`);
    this.name = "NotSupportedError";
  }
}

/** Validate credentials with zod and throw one readable message listing every problem (values are never echoed). */
export function parseWith<S extends z.ZodType>(provider: string, schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const problems = result.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
  throw new Error(`Invalid ${provider} credentials: ${problems.join("; ")}`);
}

export const requiredString = (label: string) =>
  z.string({ error: `${label} is required` }).trim().min(1, `${label} is required`);

export const optionalString = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined));

/** Accepts booleans and the strings a dashboard form posts ("true"/"false"/"on"/""). */
export const looseBoolean = () =>
  z
    .union([z.boolean(), z.enum(["true", "false", "on", "off", "1", "0", ""])])
    .optional()
    .transform((v) => v === true || v === "true" || v === "on" || v === "1");

/** Pull a human-readable message out of a JSON or text error body. Never includes request details. */
export function describeErrorBody(body: unknown, fallback: string): string {
  if (typeof body === "string") return body.trim().slice(0, 500) || fallback;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const err = b.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      if (typeof e.message === "string") return e.message;
      if (Array.isArray(e.message)) return e.message.filter((m) => typeof m === "string").join("; ") || fallback;
    }
    for (const key of ["message", "description", "msg", "detail"]) {
      if (typeof b[key] === "string") return b[key] as string;
    }
    // CHIP-style field errors: { field: [{ message }] } or { field: ["msg"] }
    const parts: string[] = [];
    for (const [k, v] of Object.entries(b)) {
      if (Array.isArray(v)) {
        const msgs = v.map((x) => (typeof x === "string" ? x : (x as { message?: unknown })?.message)).filter((m) => typeof m === "string");
        if (msgs.length) parts.push(`${k}: ${msgs.join(", ")}`);
      }
    }
    if (parts.length) return parts.join("; ");
  }
  return fallback;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** fetch + parse; throws ProviderApiError on non-2xx with the provider's own message. */
export async function requestJson<T = any>(provider: string, fetcher: typeof fetch, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(url, init);
  } catch (err) {
    // Some URLs carry secrets (Telegram's bot token), so strip URLs from the runtime's message.
    const detail = (err instanceof Error ? err.message : String(err)).replace(/https?:\/\/\S+/g, "<url>");
    throw new Error(`${provider} request failed: ${detail}`);
  }
  const body = await readBody(res);
  if (!res.ok) throw new ProviderApiError(provider, res.status, describeErrorBody(body, res.statusText || "request failed"));
  return body as T;
}

/** Form-encode a nested object the way Stripe expects: a[b][0][c]=v. */
export function formEncode(data: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const walk = (value: unknown, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${key}[${k}]`);
    else params.append(key, String(value));
  };
  for (const [k, v] of Object.entries(data)) walk(v, k);
  return params.toString();
}

// ISO 4217 minor units. Stripe lists these as zero-decimal / three-decimal currencies.
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export function minorUnitFactor(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 1;
  if (THREE_DECIMAL.has(c)) return 1000;
  return 100;
}

/** Major units (50 = RM 50.00) to the integer minor units most APIs want. Rejects non-positive or non-finite amounts. */
export function toMinor(amount: number, currency: string): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`amount must be a positive number in major units (e.g. 50 for 50.00), got ${String(amount)}`);
  }
  return Math.round(amount * minorUnitFactor(currency));
}

export function fromMinor(minor: number, currency: string): number {
  return minor / minorUnitFactor(currency);
}

export function normaliseCurrency(currency: string | undefined): string {
  const c = (currency ?? "MYR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error(`currency must be a 3-letter ISO 4217 code, got "${currency}"`);
  return c;
}

export function requireMyr(provider: string, currency: string | undefined): "MYR" {
  const c = normaliseCurrency(currency);
  if (c !== "MYR") throw new Error(`${provider} only supports MYR, got ${c}`);
  return "MYR";
}

/** fetch to use for webhook-time lookups (parseWebhook has no ProviderContext in the shared contract). */
export function webhookFetch(ctx?: Pick<ProviderContext, "fetch">): typeof fetch {
  return ctx?.fetch ?? ((input, init) => fetch(input, init));
}

/** Read a form-encoded body into a plain object (last value wins). */
export async function readForm(request: Request): Promise<Record<string, string>> {
  const text = await request.text();
  const out: Record<string, string> = {};
  new URLSearchParams(text).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Turn an LlmRequest into a role-tagged message list (prompt appended as the final user turn). */
export function llmMessages(request: LlmRequest): Array<{ role: "user" | "assistant"; content: string }> {
  const messages = [...(request.messages ?? [])];
  if (request.prompt) messages.push({ role: "user", content: request.prompt });
  if (messages.length === 0) throw new Error("LLM request needs a prompt or at least one message");
  return messages;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/\s+/g, ""));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/**
 * A provider whose webhook handling needs to call the provider's API (ToyyibPay,
 * Billplz). The shared contract does not pass a context to parseWebhook yet, so
 * these accept an optional one and fall back to the global fetch.
 */
export type ProviderDefinitionWithWebhookLookup<C, K extends ProviderCapability> = Omit<ProviderDefinition<C, K>, "parseWebhook"> & {
  parseWebhook(request: Request, credentials: C, ctx?: Pick<ProviderContext, "fetch">): Promise<ProviderEvent | null>;
};

/** Event name for an inbound message: `message.<channel>.<from>`. */
export function messageEvent(channel: string, from: string): string {
  return `message.${channel}.${from}`;
}

/** Plain text from the small HTML subset `messaging.send` accepts (for channels without HTML, and email text parts). */
export function htmlToText(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
