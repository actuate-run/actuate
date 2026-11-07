// Spec: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
// Sign and verify with WebCrypto only, so this runs in Workers as well as Node (no runtime dependency).
import { timingSafeEqual } from "./contract.js";
import { base64ToBytes } from "./util.js";

const PREFIX = "whsec_";
/** Signed requests older or newer than this are refused (the spec's recommended tolerance). */
export const STANDARD_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * The key bytes of a `whsec_<base64>` secret, or null when it is not one. Standard base64, 24 to 64 bytes:
 * shorter keys are too weak, and the spec's own libraries generate 24 to 32.
 */
export function standardWebhookKey(secret: string): Uint8Array<ArrayBuffer> | null {
  if (!secret.startsWith(PREFIX)) return null;
  const b64 = secret.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return null;
  }
  return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}

function keyOrThrow(secret: string): Uint8Array<ArrayBuffer> {
  const key = standardWebhookKey(secret);
  if (!key) throw new Error("A Standard Webhooks secret looks like whsec_ followed by 24 to 64 bytes of base64");
  return key;
}

async function hmacBase64(key: Uint8Array<ArrayBuffer>, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...sig));
}

/** The `webhook-signature` value for a message: `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`. */
export async function signStandardWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  return `v1,${await hmacBase64(keyOrThrow(secret), `${id}.${timestamp}.${body}`)}`;
}

export type StandardWebhookVerification = { ok: true; id: string; timestamp: number } | { ok: false; reason: string };

/**
 * Check a request's `webhook-id`, `webhook-timestamp` and `webhook-signature` headers against the raw body.
 * The signature header may list several space-separated signatures (sent during a secret rotation): one
 * matching `v1,` entry is enough. Never throws for a bad request; `reason` is safe to show the sender.
 */
export async function verifyStandardWebhook(
  secret: string,
  headers: Headers,
  body: string,
  now: number = Date.now(),
): Promise<StandardWebhookVerification> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !ts || !signatures) return { ok: false, reason: "missing webhook-id, webhook-timestamp or webhook-signature header" };
  if (!/^\d{1,12}$/.test(ts.trim())) return { ok: false, reason: "webhook-timestamp must be Unix seconds" };
  const timestamp = Number(ts.trim());
  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - timestamp) > STANDARD_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "webhook-timestamp is more than 5 minutes from now (check the sender's clock)" };
  }
  const expected = await hmacBase64(keyOrThrow(secret), `${id}.${timestamp}.${body}`);
  let match = false;
  for (const entry of signatures.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    // Keep comparing after a match so the time taken does not reveal which entry matched.
    if (timingSafeEqual(entry.slice(comma + 1), expected)) match = true;
  }
  return match ? { ok: true, id, timestamp } : { ok: false, reason: "no webhook-signature matches the body" };
}
