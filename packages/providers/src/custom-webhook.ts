// Signing follows Standard Webhooks: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
import { z } from "zod";
import { WebhookVerificationError, timingSafeEqual, type ProviderDefinition } from "./contract.js";
import type { InboundMessage, MessagingProvider } from "@actuate/sdk";
import { signStandardWebhook, standardWebhookKey, verifyStandardWebhook } from "./standard-webhooks.js";
import { describeErrorBody, htmlToText, idempotencyNonce, messageEvent, optionalString, parseWith, ProviderApiError } from "./util.js";

const PROVIDER = "Custom webhook";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_HEADER_LINES = 20;
const MAX_TEMPLATE_LENGTH = 16 * 1024;
const MAX_ERROR_DETAIL = 500;
const MAX_TITLE_LENGTH = 1024;

export const CUSTOM_WEBHOOK_FORMATS = ["standard", "text", "template"] as const;
export type CustomWebhookFormat = (typeof CUSTOM_WEBHOOK_FORMATS)[number];
const PLACEHOLDERS = ["text", "html", "subject", "to", "id", "replyUrl"] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

// Plain http only for a receiver on this machine; IP literals elsewhere are refused so a tenant URL
// cannot aim at a private address without a name (the platform also blocks its own hosts).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/** Why a URL is unusable, or null. Never repeats the URL: it often carries the endpoint's token. */
function urlProblem(value: string): string | null {
  if (value.length > MAX_URL_LENGTH) return `url must be at most ${MAX_URL_LENGTH} characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "url must be a full URL such as https://example.com/hook";
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "url must start with https:// (http:// only for localhost)";
  if (url.username || url.password) return "url must not contain a user name or password; put credentials in Extra headers";
  if (!local && IP_LITERAL.test(url.hostname)) return "url must use a host name, not an IP address";
  return null;
}

// RFC 9110 token characters.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection"]);

/**
 * `Name: value` lines to header pairs, or a list of problems. The field is secret, so problems name the
 * line number (and a header name only when it is one we refuse), never what the line contains.
 */
function parseHeaderLines(input: string): { headers: Array<[string, string]>; problems: string[] } {
  const headers: Array<[string, string]> = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const lines = input.split(/\r?\n/).map((l) => l.trim());
  if (lines.filter(Boolean).length > MAX_HEADER_LINES) return { headers, problems: [`at most ${MAX_HEADER_LINES} lines`] };
  lines.forEach((line, i) => {
    if (!line) return;
    const at = `line ${i + 1}`;
    const colon = line.indexOf(":");
    if (colon < 0) return problems.push(`${at}: write it as Name: value`);
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name)) return problems.push(`${at}: the header name has characters a header name cannot have`);
    if (RESERVED_HEADERS.has(lower)) return problems.push(`${at}: ${lower} is set by the HTTP client and cannot be overridden`);
    if (lower.startsWith("webhook-")) return problems.push(`${at}: webhook-* headers carry Actuate's signature and cannot be set`);
    if (seen.has(lower)) return problems.push(`${at}: this header is already set on an earlier line`);
    // eslint-disable-next-line no-control-regex
    if (!value || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return problems.push(`${at}: the header needs a value without control characters`);
    if (/[^\u0000-ÿ]/.test(value)) return problems.push(`${at}: header values must be plain ASCII (or Latin-1) characters`);
    seen.add(lower);
    headers.push([name, value]);
  });
  return { headers, problems };
}

/** Escape a value for use inside a JSON string, without the surrounding quotes. */
const jsonInner = (value: string) => JSON.stringify(value).slice(1, -1);

/** Fill a template in one pass, so a value that itself contains `{{text}}` is never expanded again. */
function fillTemplate(template: string, values: Record<Placeholder, string>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => jsonInner(values[name.trim() as Placeholder] ?? ""));
}

function templateProblem(template: string): string | null {
  if (template.length > MAX_TEMPLATE_LENGTH) return `template must be at most ${MAX_TEMPLATE_LENGTH} characters`;
  for (const [, raw] of template.matchAll(PLACEHOLDER)) {
    const name = raw!.trim();
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
      return `unknown placeholder {{${name.slice(0, 40)}}}. Use ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}`;
    }
  }
  // Sample values with quotes and a newline: they only stay valid JSON when each placeholder sits inside a string.
  const sample = 'a "quoted"\nline';
  try {
    JSON.parse(fillTemplate(template, Object.fromEntries(PLACEHOLDERS.map((p) => [p, sample])) as Record<Placeholder, string>));
  } catch {
    return 'template must be valid JSON with each placeholder inside a JSON string, e.g. {"text":"{{text}}"}';
  }
  return null;
}

const schema = z
  .object({
    url: z.string({ error: "url is required" }).trim().min(1, "url is required"),
    secret: optionalString(),
    headers: optionalString(),
    format: z
      .string()
      .trim()
      .toLowerCase()
      .optional()
      .transform((v) => (v ? v : undefined))
      .refine((v) => v === undefined || (CUSTOM_WEBHOOK_FORMATS as readonly string[]).includes(v), `format must be one of ${CUSTOM_WEBHOOK_FORMATS.join(", ")}`)
      .transform((v) => v as CustomWebhookFormat | undefined),
    template: optionalString(),
  })
  .superRefine((c, ctx) => {
    const url = urlProblem(c.url);
    if (url) ctx.addIssue({ code: "custom", path: ["url"], message: url });
    if (c.secret && !standardWebhookKey(c.secret)) {
      ctx.addIssue({ code: "custom", path: ["secret"], message: "secret must be whsec_ followed by base64 of 24 to 64 random bytes (generate one, or run: openssl rand -base64 32)" });
    }
    if (c.headers) for (const message of parseHeaderLines(c.headers).problems) ctx.addIssue({ code: "custom", path: ["headers"], message });
    if (formatOf(c) === "template") {
      const problem = c.template ? templateProblem(c.template) : "template is required when format is template";
      if (problem) ctx.addIssue({ code: "custom", path: ["template"], message: problem });
    }
  });
// Credentials stay plain strings (headers and template are parsed again in create), so parsing is idempotent.
export type CustomWebhookCredentials = z.output<typeof schema>;

/** A template with no format given means the template format: setting one and forgetting the other is the common slip. */
function formatOf(c: { format?: CustomWebhookFormat | undefined; template?: string | undefined }): CustomWebhookFormat {
  return c.format ?? (c.template ? "template" : "standard");
}

/** Header values must be bytes: non-ASCII text (a subject in another script) goes as an RFC 2047 encoded word, which ntfy decodes. */
function headerText(value: string): string {
  // A title, not a message: cap it before encoding (a spread of a long byte array would also overflow the stack).
  const flat = Array.from(value.replace(/[\r\n]+/g, " ").trim()).slice(0, MAX_TITLE_LENGTH).join("");
  if (/^[ -~]*$/.test(flat)) return flat;
  let binary = "";
  for (const byte of new TextEncoder().encode(flat)) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/** Read at most `max` bytes of a response body, then stop: a receiver's reply is a receipt, not a download. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, max - size);
      size += chunk.length;
      out += decoder.decode(chunk, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out + decoder.decode();
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Strip anything that could carry a credential from a message we did not write (runtime errors, the endpoint's reply). */
function redactor(credentials: CustomWebhookCredentials, headerValues: string[]): (text: string) => string {
  const url = new URL(credentials.url);
  // A header value and its long words: "Bearer <token>" is often quoted as just the token.
  const words = headerValues.flatMap((v) => v.split(/\s+/).filter((w) => w.length >= 8));
  const secrets = [credentials.url, credentials.secret, url.pathname.length > 1 ? url.pathname : "", url.search, ...headerValues, ...words]
    .filter((s): s is string => !!s && s.length >= 4)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text.replace(/https?:\/\/\S+/g, "<url>");
    for (const s of secrets) out = out.split(s).join("<redacted>");
    return out;
  };
}

export const customWebhook: ProviderDefinition<CustomWebhookCredentials, "messaging"> = {
  kind: "custom-webhook",
  capability: "messaging",
  label: "Custom webhook",
  credentialFields: [
    {
      key: "url",
      label: "URL",
      secret: true,
      help: "Where Actuate POSTs each message: your own server, Zapier, n8n, Make, ntfy, Google Chat, Mattermost... Must be https://.",
    },
    {
      key: "secret",
      label: "Signing secret",
      secret: true,
      optional: true,
      generate: "whsec",
      help: "Signs what Actuate sends (Standard Webhooks) and lets your server reply. Generate one, or use whsec_ followed by the output of: openssl rand -base64 32",
    },
    {
      key: "headers",
      label: "Extra headers",
      secret: true,
      optional: true,
      multiline: true,
      help: "One Name: value per line, e.g. Authorization: Bearer ... or X-Gotify-Key: ...",
    },
    {
      key: "format",
      label: "Body format",
      secret: false,
      optional: true,
      options: CUSTOM_WEBHOOK_FORMATS,
      help: "Leave empty for automatic: template when a JSON template is set, otherwise standard. standard: JSON with id, to, text. text: the plain text (ntfy). template: your own JSON.",
    },
    {
      key: "template",
      label: "JSON template",
      secret: false,
      optional: true,
      multiline: true,
      help: 'For the template format. Placeholders go inside JSON strings: {"text":"{{text}}"}. Also {{subject}}, {{html}}, {{to}}, {{id}}, {{replyUrl}}.',
    },
  ],
  parseCredentials: (input) => parseWith(PROVIDER, schema, input),
  create(credentials, ctx): MessagingProvider {
    const format = formatOf(credentials);
    const extraHeaders = credentials.headers ? parseHeaderLines(credentials.headers).headers : [];
    const redact = redactor(credentials, extraHeaders.map(([, v]) => v));
    // Replies need the signing secret, so the reply URL is only offered with one.
    const replyUrl = credentials.secret && ctx.webhookUrl ? ctx.webhookUrl : "";
    return {
      async send(to, text, options) {
        const target = new URL(credentials.url);
        // Posting to our own reply URL would feed every message back in as an inbound one.
        if (ctx.webhookUrl && URL.canParse(ctx.webhookUrl) && new URL(ctx.webhookUrl).host === target.host) {
          throw new Error("Custom webhook url points at this actuator; use your receiver's URL, not the Reply URL");
        }
        // Idempotency: a step retry sends the same id (derived from the key), so receivers can drop duplicates by
        // `id` / `webhook-id`. Without a key every send gets a fresh id.
        const id = `msg_${options?.idempotencyKey ? await idempotencyNonce(options.idempotencyKey, 32) : randomHex(16)}`;
        const timestamp = Math.floor(Date.now() / 1000);
        const html = options?.format === "html" ? text : undefined;
        const plain = html !== undefined ? htmlToText(text) : text;
        const subject = options?.subject;
        const headers = new Headers();
        let body: string;
        if (format === "text") {
          body = plain;
          headers.set("content-type", "text/plain; charset=utf-8");
          if (subject) headers.set("title", headerText(subject));
        } else if (format === "template") {
          body = fillTemplate(credentials.template!, { text: plain, html: html ?? "", subject: subject ?? "", to: to ?? "", id, replyUrl });
          headers.set("content-type", "application/json");
        } else {
          body = JSON.stringify({
            id,
            to: to ?? "",
            text: plain,
            ...(html !== undefined ? { html } : {}),
            ...(subject ? { subject } : {}),
            ...(replyUrl ? { replyUrl } : {}),
          });
          headers.set("content-type", "application/json");
        }
        for (const [name, value] of extraHeaders) headers.set(name, value);
        headers.set("webhook-id", id);
        headers.set("webhook-timestamp", String(timestamp));
        if (credentials.secret) headers.set("webhook-signature", await signStandardWebhook(credentials.secret, id, timestamp, body));

        // Network errors and timeouts, whether while connecting or while reading the body, read the same way.
        const failed = (err: unknown) => {
          const e = err as Error;
          if (e?.name === "TimeoutError" || e?.name === "AbortError") return new Error(`${PROVIDER} request timed out after ${TIMEOUT_MS / 1000} s`);
          return new Error(`${PROVIDER} request failed: ${redact(e instanceof Error ? e.message : String(err))}`);
        };
        let res: Response;
        // Call fetch unbound: Workers' global fetch throws "Illegal invocation" when called as ctx.fetch(...).
        const fetcher = ctx.fetch;
        try {
          res = await fetcher(credentials.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (err) {
          throw failed(err);
        }
        // A redirect could carry the signed message somewhere else; with redirect "manual" a browser-style fetch reports status 0.
        if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
          res.body?.cancel().catch(() => {});
          throw new ProviderApiError(PROVIDER, res.status, "redirects are not followed; use the final URL");
        }
        let raw: string;
        try {
          raw = await readCapped(res, MAX_RESPONSE_BYTES);
        } catch (err) {
          throw failed(err);
        }
        const reply = parseMaybeJson(raw);
        if (!res.ok) {
          const fallback = res.statusText || "request failed";
          // An HTML error page (a proxy's 502) says nothing useful in 500 characters of markup.
          const detail = typeof reply === "string" && /^\s*</.test(reply) ? fallback : describeErrorBody(reply, fallback);
          throw new ProviderApiError(PROVIDER, res.status, redact(detail).slice(0, MAX_ERROR_DETAIL));
        }
        const receipt = reply && typeof reply === "object" && !Array.isArray(reply) ? (reply as { id?: unknown }).id : undefined;
        return { id: typeof receipt === "string" && receipt ? receipt.slice(0, 256) : id, channel: "custom-webhook" };
      },
    };
  },
  async parseWebhook(request, credentials) {
    // Without a secret anyone who learns the reply URL could post fake replies, so inbound needs one.
    if (!credentials.secret || request.method !== "POST") return null;
    const raw = await request.text();
    // Either a bearer token (simplest, for curl) or a Standard Webhooks signature (for senders that sign).
    // Never ?secret=: a secret in the URL ends up in proxy, sender and request logs.
    const auth = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
    const bearerOk = auth !== undefined && timingSafeEqual(auth, credentials.secret);
    if (!bearerOk) {
      if (!request.headers.has("webhook-signature")) {
        throw new WebhookVerificationError("Custom webhook reply not authorized: send Authorization: Bearer <signing secret> or a Standard Webhooks signature");
      }
      const check = await verifyStandardWebhook(credentials.secret, request.headers, raw);
      if (!check.ok) throw new WebhookVerificationError(`Custom webhook signature check failed: ${check.reason}`);
    }
    let body: CustomWebhookReply;
    try {
      body = JSON.parse(raw) as CustomWebhookReply;
    } catch {
      return null;
    }
    // The shared contract has no "bad request" answer, so a reply without a usable `from` is ignored
    // (the host answers {"ignored": true}) rather than reported as a signature failure.
    if (!body || typeof body !== "object") return null;
    const from = typeof body.from === "number" && Number.isFinite(body.from) ? String(body.from) : typeof body.from === "string" ? body.from.trim() : "";
    if (!from || from.length > 256) return null;
    const id = typeof body.id === "string" || typeof body.id === "number" ? String(body.id) : (request.headers.get("webhook-id") ?? `msg_${randomHex(16)}`);
    const message: InboundMessage = {
      channel: "custom-webhook",
      from,
      text: typeof body.text === "string" ? body.text : "",
      type: typeof body.type === "string" && body.type ? body.type : "text",
      id,
      at: typeof body.at === "number" && Number.isFinite(body.at) ? body.at : Date.now(),
      ...(typeof body.name === "string" && body.name ? { name: body.name } : {}),
    };
    return { event: messageEvent("custom-webhook", from), payload: { ...message } };
  },
};

interface CustomWebhookReply {
  from?: unknown;
  text?: unknown;
  id?: unknown;
  at?: unknown;
  name?: unknown;
  type?: unknown;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
