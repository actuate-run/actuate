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
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(creds, null, 2));
  chmodSync(p, 0o600);
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
  if (!res.ok) {
    const message = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : text;
    throw new ApiError(res.status, `${res.status}: ${message}`);
  }
  return body as T;
}
