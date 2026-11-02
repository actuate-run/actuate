import type { ProviderContext } from "../src/contract.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch mock that records each call and answers from a queue of responders (the last one repeats). */
export function mockFetch(...responders: Responder[]) {
  const calls: RecordedCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: RecordedCall = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)];
    if (!responder) throw new Error("no mock response configured");
    return responder(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const json = (body: unknown, status = 200) =>
  () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const text = (body: string, status = 200) => () => new Response(body, { status, headers: { "content-type": "text/html" } });

export function context(fetch: typeof globalThis.fetch): ProviderContext {
  return {
    fetch,
    webhookUrl: "https://gw.actuate.test/a/act_1/providers/x/webhook",
    defaultReturnUrl: "https://gw.actuate.test/return",
  };
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function formRequest(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request("https://gw.actuate.test/webhook", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

export function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://gw.actuate.test/webhook", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

/** Await a promise that must reject and return its error. */
export async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject");
}
