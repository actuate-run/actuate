/** Signed, single-use-by-construction approval tokens (HMAC-SHA256, WebCrypto). */

export interface ApprovalClaims {
  /** Run ID. */
  r: string;
  /** Step name. */
  s: string;
  /** Decision: 1 approve, 0 reject. */
  d: 0 | 1;
  /** Expiry, epoch ms. */
  e: number;
}

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signApproval(secret: string, claims: ApprovalClaims): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifyApproval(secret: string, token: string, now: number): Promise<ApprovalClaims | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig), encoder.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as ApprovalClaims;
  if (typeof claims.e !== "number" || claims.e < now) return null;
  return claims;
}
