import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_API_URL = "https://api.actuate.run";

export interface Credentials {
  apiUrl: string;
  token: string;
  /** The account's plan when last seen (login, deploy), so offline commands can use its limits. */
  plan?: string;
  email?: string;
}

export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "actuate", "credentials.json");
}

export function readCredentials(): Credentials | null {
  if (process.env.ACTUATE_API_TOKEN) {
    return { apiUrl: process.env.ACTUATE_API_URL ?? DEFAULT_API_URL, token: process.env.ACTUATE_API_TOKEN };
  }
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  let creds: Credentials;
  try {
    creds = JSON.parse(readFileSync(p, "utf8")) as Credentials;
  } catch {
    throw new Error(`${p} is not valid JSON. Run \`actuate login\` again.`);
  }
  return { ...creds, apiUrl: process.env.ACTUATE_API_URL ?? creds.apiUrl };
}

/** Remember the account's plan next to the saved token (not when the token comes from ACTUATE_API_TOKEN). */
export function rememberAccount(account: { plan?: string; email?: string }): void {
  if (process.env.ACTUATE_API_TOKEN || !existsSync(credentialsPath())) return;
  try {
    const saved = JSON.parse(readFileSync(credentialsPath(), "utf8")) as Credentials;
    if (saved.plan === account.plan && saved.email === account.email) return;
    writeCredentials({ ...saved, ...(account.plan ? { plan: account.plan } : {}), ...(account.email ? { email: account.email } : {}) });
  } catch {
    /* best effort */
  }
}

export function writeCredentials(creds: Credentials): string {
  const p = credentialsPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  // Created owner-only, so the token is never readable by others, even for a moment.
  writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600); // an existing file keeps its old mode on write
  return p;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The error line for a failed call: `error`, plus one line per validation issue (`path: message`). */
export function errorMessage(body: unknown, text: string): string {
  if (typeof body !== "object" || !body || !("error" in body)) return text;
  const { error, issues } = body as { error: unknown; issues?: unknown };
  const lines = Array.isArray(issues)
    ? issues.map((i: { path?: unknown; message?: unknown }) => {
        // Zod issues carry a path array; the platform's gateway sends a JSON pointer ("/name").
        const parts = Array.isArray(i?.path) ? i.path : typeof i?.path === "string" ? i.path.split("/").filter(Boolean) : [];
        const path = parts.length ? parts.join(".") : "(input)";
        return `\n  ${path}: ${String(i?.message ?? JSON.stringify(i))}`;
      })
    : [];
  return String(error) + lines.join("");
}

/** Call the Actuate control plane with the stored token, or the local `actuate dev` runtime (`--local`, no token). */
export async function api<T>(creds: Credentials, path: string, init: RequestInit = {}): Promise<T> {
  const base = creds.apiUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(creds.token ? { authorization: `Bearer ${creds.token}` } : {}),
        "content-type": "application/json",
        ...(init.headers as object),
      },
    });
  } catch (err) {
    const cause = (err as Error).name === "TimeoutError" ? "no answer in time" : ((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message);
    // `--local` calls carry no token: they go to `actuate dev`.
    if (!creds.token && /^http:\/\/(localhost|127\.0\.0\.1)/.test(base)) {
      throw new Error(`Nothing is answering at ${base} (${cause}). Start \`actuate dev\` in another terminal first, or pass --port.`);
    }
    throw new Error(`Could not reach ${base} (${cause}). Check your connection, or ACTUATE_API_URL.`);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error */
  }
  if (!res.ok) throw new ApiError(res.status, `${res.status}: ${errorMessage(body, text)}`);
  return body as T;
}

/** The parts of `GET /v1/me` the CLI reads. */
export interface Me {
  email?: string;
  plan?: string;
  planDetails?: unknown;
  usage?: { deploys?: number; runs?: number; passes?: number; rowsWritten?: number; rowsRead?: number };
}

/** GET /v1/me. `timeoutMs` bounds the wait, for commands that only want the plan and can do without it. */
export function fetchMe(creds: Credentials, timeoutMs?: number): Promise<Me> {
  return api<Me>(creds, "/v1/me", timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {});
}
