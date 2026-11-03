import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_API_URL = "https://api.actuate.run";

export interface Credentials {
  apiUrl: string;
  token: string;
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
  const creds = JSON.parse(readFileSync(p, "utf8")) as Credentials;
  return { ...creds, apiUrl: process.env.ACTUATE_API_URL ?? creds.apiUrl };
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

/** Call the Actuate control plane (or a self-hosted runtime) with the stored token. */
export async function api<T>(creds: Credentials, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${creds.apiUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json", ...(init.headers as object) },
  });
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
