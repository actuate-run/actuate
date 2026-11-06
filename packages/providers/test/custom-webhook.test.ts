import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookVerificationError } from "../src/contract.js";
import {
  combineMessaging,
  configuredFromEnv,
  customWebhook,
  envVarsFor,
  parseProviderWebhookFromEnv,
  ProviderApiError,
  providersFromEnv,
  signStandardWebhook,
  telegram,
  verifyStandardWebhook,
} from "../src/index.js";
import { context, failure, json, mockFetch, text } from "./helpers.js";

const URL_ = "https://hooks.example.com/in/tok3n-abcdef";
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const REPLY_URL = "https://gw.actuate.test/a/act_1/providers/x/webhook";

const parse = (input: Record<string, unknown>) => customWebhook.parseCredentials({ url: URL_, ...input });
const problem = (input: Record<string, unknown>) => {
  try {
    customWebhook.parseCredentials(input);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the credentials to be refused");
};

/** Send once and return what reached the endpoint. */
async function sendOnce(input: Record<string, unknown>, to: string, message: string, options?: Parameters<ReturnType<typeof customWebhook.create>["send"]>[2]) {
  const { fetch, calls } = mockFetch(json({ ok: true }));
  const receipt = await customWebhook.create(parse(input), context(fetch)).send(to, message, options);
  return { receipt, call: calls[0]! };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("custom-webhook credentials", () => {
  it("needs only a URL, and parsing its own output again changes nothing", () => {
    expect(parse({})).toEqual({ url: URL_ });
    const full = parse({ secret: ` ${SECRET} `, headers: "X-Gotify-Key: k1\n\n  Authorization: Bearer abc  ", format: "Template", template: '{"text":"{{text}}"}' });
    expect(full).toMatchObject({ secret: SECRET, format: "template" });
    expect(customWebhook.parseCredentials(full)).toEqual(full);
    expect(problem({})).toMatch(/url is required/);
  });

  it.each([
    ["http://example.com/hook", /https:\/\//],
    ["ftp://example.com/hook", /https:\/\//],
    ["https://user:pass@example.com/hook", /user name or password/],
    ["https://10.0.0.7/hook", /host name, not an IP/],
    ["https://[2001:db8::1]/hook", /host name, not an IP/],
    ["https://1.2.3.4:8443/hook", /host name, not an IP/],
    ["not a url", /full URL/],
    [`https://example.com/${"a".repeat(2048)}`, /at most 2048/],
  ])("refuses %s without repeating it", (url, message) => {
    const err = problem({ url });
    expect(err).toMatch(message);
    expect(err).toMatch(/^Invalid Custom webhook credentials: url: /);
    expect(err).not.toContain(url.slice(0, 30).replace(/^\w+:\/\//, ""));
  });

  it.each(["http://localhost:3000/hook", "http://127.0.0.1:8080/x", "http://[::1]:9000/", "https://localhost/hook", "https://ntfy.sh/my-topic"])("accepts %s", (url) => {
    expect(customWebhook.parseCredentials({ url }).url).toBe(url);
  });

  it("checks the signing secret's format without echoing it", () => {
    for (const secret of ["hunter2-secret", "whsec_tooShort", `whsec_${btoa("x".repeat(16))}`]) {
      const err = problem({ url: URL_, secret });
      expect(err).toMatch(/secret: secret must be whsec_/);
      expect(err).not.toContain(secret);
    }
  });

  it("parses extra headers and refuses the ones it must own, never echoing values", () => {
    expect(() => parse({ headers: "X-Gotify-Key: k1\r\nCF-Access-Client-Id: id.access\nContent-Type: application/vnd.custom+json" })).not.toThrow();
    const cases: Array<[string, RegExp]> = [
      ["Host: evil.example", /line 1: host is set by the HTTP client/],
      ["X-Ok: 1\ncontent-length: 5", /line 2: content-length/],
      ["Transfer-Encoding: chunked", /transfer-encoding/],
      ["Connection: close", /connection/],
      ["webhook-signature: v1,forged", /webhook-\* headers/],
      ["Webhook-Id: forged", /webhook-\* headers/],
      ["Bearer s3cr3t-value", /line 1: write it as Name: value/],
      ["X Bad Name: s3cr3t-value", /line 1: the header name has characters/],
      ["X-Empty:", /needs a value/],
      ["X-Key: s3cr3t-value\nx-key: s3cr3t-value", /line 2: this header is already set/],
      ["X-Key: s3cr3t-välue✓", /plain ASCII/],
      [Array.from({ length: 21 }, (_, i) => `X-H${i}: v`).join("\n"), /at most 20 lines/],
    ];
    for (const [headers, message] of cases) {
      const err = problem({ url: URL_, headers });
      expect(err).toMatch(message);
      expect(err).toMatch(/headers: /);
      expect(err).not.toContain("s3cr3t");
      expect(err).not.toContain("forged");
    }
  });

  it("treats an empty format as automatic: template when a template is set, otherwise standard", async () => {
    expect(parse({ format: "" }).format).toBeUndefined();
    expect(JSON.parse((await sendOnce({ format: "" }, "me", "hi")).call.body)).toMatchObject({ to: "me", text: "hi" });
    expect(parse({ format: " ", template: '{"m":"{{text}}"}' }).format).toBeUndefined();
    expect(JSON.parse((await sendOnce({ format: "", template: '{"m":"{{text}}"}' }, "me", "hi")).call.body)).toEqual({ m: "hi" });
    expect(problem({ url: URL_, format: "", template: '{"m":{{text}}}' })).toMatch(/template: .*inside a JSON string/);
  });

  it("validates the body format and the JSON template", () => {
    expect(problem({ url: URL_, format: "xml" })).toMatch(/format must be one of standard, text, template/);
    expect(problem({ url: URL_, format: "template" })).toMatch(/template: template is required when format is template/);
    expect(problem({ url: URL_, format: "template", template: '{"text":"{{message}}"}' })).toMatch(/unknown placeholder \{\{message\}\}\. Use \{\{text\}\}/);
    expect(problem({ url: URL_, format: "template", template: '{"text": {{text}}}' })).toMatch(/inside a JSON string/);
    expect(problem({ url: URL_, format: "template", template: '{"text":"{{text}}"' })).toMatch(/valid JSON/);
    expect(problem({ url: URL_, format: "template", template: `{"t":"${"x".repeat(17_000)}"}` })).toMatch(/at most 16384/);
    // A template is only checked when it is used.
    expect(() => parse({ format: "standard", template: "{broken" })).not.toThrow();
    expect(() => parse({ format: "template", template: '{"text":"{{ text }}","n":1,"list":["{{to}}"]}' })).not.toThrow();
  });

  it("describes its fields for a generic form", () => {
    expect(customWebhook.credentialFields.map((f) => [f.key, f.secret, Boolean(f.optional)])).toEqual([
      ["url", true, false],
      ["secret", true, true],
      ["headers", true, true],
      ["format", false, true],
      ["template", false, true],
    ]);
    const field = (key: string) => customWebhook.credentialFields.find((f) => f.key === key)!;
    expect(field("secret").generate).toBe("whsec");
    expect(field("headers").multiline).toBe(true);
    expect(field("template").multiline).toBe(true);
    expect(field("format").options).toEqual(["standard", "text", "template"]);
  });
});

describe("custom-webhook send", () => {
  it("posts the standard JSON body, signed like the official Standard Webhooks library", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1793664000 * 1000);
    const { receipt, call } = await sendOnce({ secret: SECRET }, "me", "Hi", { idempotencyKey: "run_1:notify:send:0" });
    expect(call.url).toBe(URL_);
    expect(call.method).toBe("POST");
    // Produced by the `standardwebhooks` npm package for this id, timestamp and body.
    expect(call.body).toBe('{"id":"msg_6c2534bbadaf0782358e373bc0c75b26","to":"me","text":"Hi","replyUrl":"https://gw.actuate.test/a/act_1/providers/x/webhook"}');
    expect(call.headers).toEqual({
      "content-type": "application/json",
      "webhook-id": "msg_6c2534bbadaf0782358e373bc0c75b26",
      "webhook-timestamp": "1793664000",
      "webhook-signature": "v1,vRAbDW15IyB3ZUCZj8i51Hi2aYmGrLTLL1xlb9UUKVY=",
    });
    expect(receipt).toEqual({ id: "msg_6c2534bbadaf0782358e373bc0c75b26", channel: "custom-webhook" });
  });

  it("sends plain text in `text` and the original in `html`, plus the subject", async () => {
    const { call } = await sendOnce({ secret: SECRET }, "me", 'Pay <b>RM 5</b> <a href="https://pay.example/1">here</a> &amp; thanks', {
      format: "html",
      subject: "Invoice",
    });
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({
      to: "me",
      text: "Pay RM 5 here (https://pay.example/1) & thanks",
      html: 'Pay <b>RM 5</b> <a href="https://pay.example/1">here</a> &amp; thanks',
      subject: "Invoice",
      replyUrl: REPLY_URL,
    });
    expect(Object.keys(body)).toEqual(["id", "to", "text", "html", "subject", "replyUrl"]);
  });

  it("without a secret: no signature and no reply URL", async () => {
    const { call } = await sendOnce({}, "", "hello");
    expect(JSON.parse(call.body)).toEqual({ id: expect.stringMatching(/^msg_[0-9a-f]{32}$/), to: "", text: "hello" });
    expect(call.headers["webhook-signature"]).toBeUndefined();
    expect(call.headers["webhook-id"]).toBe(JSON.parse(call.body).id);
    expect(call.headers["webhook-timestamp"]).toMatch(/^\d{10}$/);
  });

  it("leaves the reply URL out when the host gives none", async () => {
    const { fetch, calls } = mockFetch(json({}));
    await customWebhook.create(parse({ secret: SECRET }), { ...context(fetch), webhookUrl: "" }).send("me", "hi");
    expect(JSON.parse(calls[0]!.body).replyUrl).toBeUndefined();
  });

  it("passes `to` through untouched", async () => {
    for (const to of ["me", " +60 12-345 6789 ", "#ops", ""]) {
      expect(JSON.parse((await sendOnce({}, to, "x")).call.body).to).toBe(to);
    }
  });

  it("derives the id from the idempotency key, so a retried step sends the same id", async () => {
    const key = "run_019a4b2c:notify:send:0";
    const expected = `msg_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    const a = await sendOnce({}, "me", "x", { idempotencyKey: key });
    const b = await sendOnce({}, "me", "x", { idempotencyKey: key });
    const c = await sendOnce({}, "me", "x", { idempotencyKey: "run_019a4b2c:notify:send:1" });
    expect(a.receipt.id).toBe(expected);
    expect(a.call.headers["webhook-id"]).toBe(expected);
    expect(b.receipt.id).toBe(expected);
    expect(c.receipt.id).not.toBe(expected);
    // Without a key, every send is new.
    const [d, e] = [await sendOnce({}, "me", "x"), await sendOnce({}, "me", "x")];
    expect(d.receipt.id).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(d.receipt.id).not.toBe(e.receipt.id);
  });

  it("returns the endpoint's own id when it answers with one", async () => {
    const { fetch } = mockFetch(json({ id: "evt_42", status: "queued" }));
    expect(await customWebhook.create(parse({}), context(fetch)).send("me", "x")).toEqual({ id: "evt_42", channel: "custom-webhook" });
    for (const reply of [json({ id: 42 }), json(["evt"]), text("OK"), () => new Response(null, { status: 204 })]) {
      const { fetch: f } = mockFetch(reply);
      expect((await customWebhook.create(parse({}), context(f)).send("me", "x")).id).toMatch(/^msg_/);
    }
  });

  it("text format: the plain text, with the subject as a Title header (ntfy)", async () => {
    const { call } = await sendOnce({ format: "text", secret: SECRET }, "me", "<i>Backup</i> done", { format: "html", subject: "Server" });
    expect(call.body).toBe("Backup done");
    expect(call.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(call.headers.title).toBe("Server");
    expect(call.headers["webhook-signature"]).toBe(await signStandardWebhook(SECRET, call.headers["webhook-id"]!, Number(call.headers["webhook-timestamp"]), call.body));
    // Header values are bytes: other scripts go as an RFC 2047 encoded word, and line breaks are flattened.
    expect((await sendOnce({ format: "text" }, "", "x", { subject: "Résumé ✓" })).call.headers.title).toBe("=?UTF-8?B?UsOpc3Vtw6kg4pyT?=");
    expect((await sendOnce({ format: "text" }, "", "x", { subject: "a\r\nb" })).call.headers.title).toBe("a b");
    expect((await sendOnce({ format: "text" }, "", "x")).call.headers.title).toBeUndefined();
    // A very long subject is capped (to 1024 characters) instead of overflowing the stack while encoding.
    const long = (await sendOnce({ format: "text" }, "", "x", { subject: "é".repeat(200_000) })).call.headers.title!;
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(long.slice(10, -2)), (c) => c.charCodeAt(0)));
    expect(long.startsWith("=?UTF-8?B?")).toBe(true);
    expect(decoded).toBe("é".repeat(1024));
    expect((await sendOnce({ format: "text" }, "", "x", { subject: "a".repeat(5000) })).call.headers.title).toBe("a".repeat(1024));
  });

  it.each([
    ["Google Chat / Mattermost / Rocket.Chat", '{"text":"{{text}}"}', (v: any) => v.text],
    ["Gotify", '{"title":"{{subject}}","message":"{{text}}"}', (v: any) => v.message],
    ["Apprise", '{"title":"{{subject}}","body":"{{text}}"}', (v: any) => v.body],
    [
      "Teams Workflows",
      '{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{"type":"AdaptiveCard","$schema":"http://adaptivecards.io/schemas/adaptive-card.json","version":"1.4","body":[{"type":"TextBlock","text":"{{text}}","wrap":true}]}}]}',
      (v: any) => v.attachments[0].content.body[0].text,
    ],
  ])("template format: the %s preset", async (_, template, pick) => {
    const message = 'Line "one"\nback\\slash {{subject}} ✓';
    const { call } = await sendOnce({ format: "template", template }, "me", message, { subject: "S" });
    expect(call.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(call.body);
    // Values are JSON-escaped, and a placeholder inside a value is never expanded.
    expect(pick(body)).toBe(message);
    if ("title" in body) expect(body.title).toBe("S");
  });

  it("template format: every placeholder, missing values empty", async () => {
    const template = '{"t":"{{text}}","h":"{{html}}","s":"{{subject}}","to":"{{to}}","id":"{{id}}","r":"{{replyUrl}}","x":"[{{ text }}]"}';
    const plain = await sendOnce({ format: "template", template }, "me", "hi");
    expect(JSON.parse(plain.call.body)).toEqual({ t: "hi", h: "", s: "", to: "me", id: plain.receipt.id, r: "", x: "[hi]" });
    const rich = await sendOnce({ template, secret: SECRET }, "me", "<b>hi</b>", { format: "html", subject: "S" });
    expect(JSON.parse(rich.call.body)).toEqual({ t: "hi", h: "<b>hi</b>", s: "S", to: "me", id: rich.receipt.id, r: REPLY_URL, x: "[hi]" });
  });

  it("adds extra headers, which may override the content type but never the signature", async () => {
    const { call } = await sendOnce({ secret: SECRET, headers: "X-Gotify-Key: gk\nContent-Type: application/vnd.custom+json\nCF-Access-Client-Secret: cfs" }, "me", "x");
    expect(call.headers["x-gotify-key"]).toBe("gk");
    expect(call.headers["cf-access-client-secret"]).toBe("cfs");
    expect(call.headers["content-type"]).toBe("application/vnd.custom+json");
    expect((await verifyStandardWebhook(SECRET, new Headers(call.headers), call.body)).ok).toBe(true);
  });

  it("asks fetch not to follow redirects and to give up after 10 seconds", async () => {
    let init: RequestInit | undefined;
    const fetch = (async (_: string, i: RequestInit) => {
      init = i;
      return Response.json({});
    }) as unknown as typeof globalThis.fetch;
    await customWebhook.create(parse({}), context(fetch)).send("me", "x");
    expect(init!.redirect).toBe("manual");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("calls fetch unbound, as Workers' global fetch requires", async () => {
    const fetch = function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({}));
    } as unknown as typeof globalThis.fetch;
    await expect(customWebhook.create(parse({}), context(fetch)).send("me", "x")).resolves.toMatchObject({ channel: "custom-webhook" });
  });

  it("refuses to post to this actuator's own reply URL", async () => {
    const { fetch, calls } = mockFetch(json({}));
    const creds = customWebhook.parseCredentials({ url: "https://gw.actuate.test/a/act_1/providers/custom-webhook/webhook", secret: SECRET });
    await expect(customWebhook.create(creds, context(fetch)).send("me", "x")).rejects.toThrow(/points at this actuator/);
    expect(calls).toHaveLength(0);
    // The same host name on another port is another server (actuate dev on 8787, a receiver on 3000).
    const local = customWebhook.parseCredentials({ url: "http://localhost:3000/in" });
    await customWebhook.create(local, { ...context(fetch), webhookUrl: "http://localhost:8787/providers/custom-webhook/webhook" }).send("me", "x");
    expect(calls).toHaveLength(1);
  });

  it("refuses redirects", async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    const err = await failure(customWebhook.create(parse({}), context(fetch)).send("me", "x"));
    expect(err).toBeInstanceOf(ProviderApiError);
    expect((err as ProviderApiError).status).toBe(302);
    expect(err.message).toBe("Custom webhook API error (HTTP 302): redirects are not followed; use the final URL");
  });

  it("reports a 401 as a ProviderApiError with the endpoint's message", async () => {
    const { fetch } = mockFetch(json({ error: "invalid token" }, 401));
    const err = await failure(customWebhook.create(parse({}), context(fetch)).send("me", "x"));
    expect(err).toBeInstanceOf(ProviderApiError);
    expect((err as ProviderApiError).status).toBe(401);
    expect((err as ProviderApiError).provider).toBe("Custom webhook");
    expect(err.message).toBe("Custom webhook API error (HTTP 401): invalid token");
  });

  it("does not quote an HTML error page", async () => {
    const { fetch } = mockFetch(() => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, statusText: "Bad Gateway" }));
    expect((await failure(customWebhook.create(parse({}), context(fetch)).send("me", "x"))).message).toBe("Custom webhook API error (HTTP 502): Bad Gateway");
  });

  it("never puts the URL, the secret or header values in errors", async () => {
    const creds = parse({ secret: SECRET, headers: "Authorization: Bearer hdr-value-123\nX-Key: other-value-456" });
    const leaks = [URL_, "tok3n-abcdef", SECRET, "hdr-value-123", "other-value-456"];
    const echo = mockFetch(json({ message: `bad request to ${URL_} (path /in/tok3n-abcdef) with Bearer hdr-value-123, X-Key other-value-456, ${SECRET}` }, 400));
    const network = (async () => {
      throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${URL_} hdr-value-123`);
    }) as unknown as typeof globalThis.fetch;
    for (const fetch of [echo.fetch, network]) {
      const err = await failure(customWebhook.create(creds, context(fetch)).send("me", "x"));
      for (const leak of leaks) expect(err.message).not.toContain(leak);
      expect(err.message).toMatch(/^Custom webhook (API error \(HTTP 400\)|request failed): /);
    }
  });

  it("reports a timeout while reading the response readably too", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    const { fetch } = mockFetch(() => new Response(stalled, { status: 200 }));
    expect((await failure(customWebhook.create(parse({}), context(fetch)).send("me", "x"))).message).toBe("Custom webhook request timed out after 10 s");
    const broken = new ReadableStream<Uint8Array>({
      pull() {
        throw new TypeError(`terminated: ${URL_}`);
      },
    });
    const { fetch: f2 } = mockFetch(() => new Response(broken, { status: 200 }));
    const err = await failure(customWebhook.create(parse({}), context(f2)).send("me", "x"));
    expect(err.message).toBe("Custom webhook request failed: terminated: <url>");
  });

  it("reports a timeout readably", async () => {
    const fetch = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof globalThis.fetch;
    expect((await failure(customWebhook.create(parse({}), context(fetch)).send("me", "x"))).message).toBe("Custom webhook request timed out after 10 s");
  });

  it("reads at most 64 KB of the response", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const { fetch } = mockFetch(() => new Response(endless, { status: 200 }));
    const receipt = await customWebhook.create(parse({}), context(fetch)).send("me", "x");
    expect(receipt.id).toMatch(/^msg_/);
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 4 * chunk.length);
    // An error body is capped the same way, and the message quotes at most 500 characters of it.
    for (const size of [60_000, 200_000]) {
      const { fetch: big } = mockFetch(() => new Response(`{"message":"${"y".repeat(size)}"}`, { status: 500 }));
      const err = await failure(customWebhook.create(parse({}), context(big)).send("me", "x"));
      // Valid JSON gives its message; a body cut at 64 KB is no longer JSON and is quoted as text.
      expect(err.message).toMatch(/^Custom webhook API error \(HTTP 500\): (\{"message":")?y+$/);
      expect(err.message.length).toBeLessThanOrEqual("Custom webhook API error (HTTP 500): ".length + 500);
    }
  });
});

describe("custom-webhook replies", () => {
  const creds = parse({ secret: SECRET });
  const reply = (body: unknown, headers: Record<string, string> = {}, url = REPLY_URL) =>
    new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const signed = async (body: string, { id = "msg_reply_1", at = Math.floor(Date.now() / 1000), signature }: { id?: string; at?: number; signature?: string } = {}) =>
    reply(body, { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": signature ?? (await signStandardWebhook(SECRET, id, at, body)) });

  it("accepts the minimal curl reply with a bearer token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1793664000123);
    const out = await customWebhook.parseWebhook!(reply({ from: "me", text: "yes" }, { authorization: `Bearer ${SECRET}` }), creds);
    expect(out).toEqual({
      event: "message.custom-webhook.me",
      payload: { channel: "custom-webhook", from: "me", text: "yes", type: "text", id: expect.stringMatching(/^msg_[0-9a-f]{32}$/), at: 1793664000123 },
    });
    expect(await customWebhook.parseWebhook!(reply({ from: "me" }, { authorization: `bearer  ${SECRET}` }), creds)).toMatchObject({ payload: { text: "" } });
  });

  it("refuses ?secret=, even with the right secret: a secret in the URL ends up in logs", async () => {
    for (const given of [SECRET, encodeURIComponent(SECRET)]) {
      const err = await failure(customWebhook.parseWebhook!(reply({ from: "me", text: "ok" }, {}, `${REPLY_URL}?secret=${given}`), creds));
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect(err.message).not.toContain(SECRET);
    }
    // A valid bearer token still works when the URL also carries one.
    const both = reply({ from: "me" }, { authorization: `Bearer ${SECRET}` }, `${REPLY_URL}?secret=wrong`);
    expect(await customWebhook.parseWebhook!(both, creds)).toMatchObject({ event: "message.custom-webhook.me" });
  });

  it("accepts a Standard Webhooks signature, taking the id from webhook-id", async () => {
    const body = JSON.stringify({ from: 60123456789, text: "Approve", name: "Wei", type: "button", at: 1793664000000 });
    expect(await customWebhook.parseWebhook!(await signed(body), creds)).toEqual({
      event: "message.custom-webhook.60123456789",
      payload: { channel: "custom-webhook", from: "60123456789", text: "Approve", type: "button", id: "msg_reply_1", at: 1793664000000, name: "Wei" },
    });
    // An id in the body wins.
    const withId = JSON.stringify({ from: "me", id: "wa-1" });
    expect(await customWebhook.parseWebhook!(await signed(withId), creds)).toMatchObject({ payload: { id: "wa-1" } });
  });

  it("accepts one good signature among several (during a secret rotation)", async () => {
    const body = JSON.stringify({ from: "me", text: "hi" });
    const at = Math.floor(Date.now() / 1000);
    const good = await signStandardWebhook(SECRET, "msg_r", at, body);
    const old = await signStandardWebhook("whsec_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "msg_r", at, body);
    expect(await customWebhook.parseWebhook!(await signed(body, { id: "msg_r", at, signature: `${old} ${good}` }), creds)).toMatchObject({ event: "message.custom-webhook.me" });
  });

  it("refuses bad, stale or missing credentials", async () => {
    const body = JSON.stringify({ from: "me", text: "hi" });
    const refused = async (request: Request, message: RegExp) => {
      const err = await failure(customWebhook.parseWebhook!(request, creds));
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect(err.message).toMatch(message);
      expect(err.message).not.toContain(SECRET);
    };
    await refused(reply(body), /send Authorization: Bearer <signing secret> or a Standard Webhooks signature/);
    await refused(reply(body, { authorization: "Bearer wrong" }), /not authorized/);
    await refused(reply(body, { authorization: SECRET }), /not authorized/);
    await refused(await signed(body, { signature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }), /signature check failed: no webhook-signature matches/);
    await refused(await signed(body, { at: Math.floor(Date.now() / 1000) - 301 }), /more than 5 minutes/);
    await refused(await signed(body, { at: Math.floor(Date.now() / 1000) + 400 }), /more than 5 minutes/);
    // Signed for a different body.
    const other = await signed(JSON.stringify({ from: "me", text: "no" }));
    const copied: Record<string, string> = {};
    other.headers.forEach((v, k) => (copied[k] = v));
    await refused(reply(body, copied), /no webhook-signature matches/);
  });

  it("ignores replies without a usable `from`, and anything when no secret is set", async () => {
    const auth = { authorization: `Bearer ${SECRET}` };
    for (const body of [{ text: "hi" }, { from: "", text: "hi" }, { from: "   " }, { from: "x".repeat(257) }, { from: { id: 1 } }, "not json", "[1]", "null"]) {
      expect(await customWebhook.parseWebhook!(reply(body, auth), creds)).toBeNull();
    }
    expect(await customWebhook.parseWebhook!(reply({ from: "x".repeat(256) }, auth), creds)).toMatchObject({ payload: { from: "x".repeat(256) } });
    // No signing secret: inbound is off, whatever the request carries.
    expect(await customWebhook.parseWebhook!(reply({ from: "me" }, auth), parse({}))).toBeNull();
    expect(await customWebhook.parseWebhook!(new Request(REPLY_URL, { headers: auth }), creds)).toBeNull();
  });
});

describe("custom-webhook from environment variables", () => {
  const env = {
    ACTUATE_MESSAGING: "custom-webhook",
    CUSTOM_WEBHOOK_URL: URL_,
    CUSTOM_WEBHOOK_SECRET: SECRET,
    CUSTOM_WEBHOOK_HEADERS: "X-Gotify-Key: gk",
    CUSTOM_WEBHOOK_FORMAT: "template",
    CUSTOM_WEBHOOK_TEMPLATE: '{"message":"{{text}}","reply":"{{replyUrl}}"}',
  };

  it("reads CUSTOM_WEBHOOK_* variables", async () => {
    expect(envVarsFor("custom-webhook").map((v) => [v.name, v.optional])).toEqual([
      ["CUSTOM_WEBHOOK_URL", false],
      ["CUSTOM_WEBHOOK_SECRET", true],
      ["CUSTOM_WEBHOOK_HEADERS", true],
      ["CUSTOM_WEBHOOK_FORMAT", true],
      ["CUSTOM_WEBHOOK_TEMPLATE", true],
    ]);
    expect(configuredFromEnv(env)[0]).toMatchObject({ capability: "messaging", credentials: { url: URL_, secret: SECRET, format: "template" } });
    const { fetch, calls } = mockFetch(json({}));
    const p = providersFromEnv(env, "https://bot.example.org", fetch);
    expect(await p.messaging!.send("me", "hi")).toMatchObject({ channel: "custom-webhook" });
    expect(calls[0]!.headers["x-gotify-key"]).toBe("gk");
    expect(JSON.parse(calls[0]!.body)).toEqual({ message: "hi", reply: "https://bot.example.org/providers/custom-webhook/webhook" });
    expect(() => configuredFromEnv({ ACTUATE_MESSAGING: "custom-webhook" })).toThrow(/Invalid Custom webhook credentials: url: url is required/);
  });

  it("verifies replies through parseProviderWebhookFromEnv", async () => {
    const request = new Request("https://bot.example.org/providers/custom-webhook/webhook", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ from: "me", text: "yes" }),
    });
    expect(await parseProviderWebhookFromEnv(env, "custom-webhook", request)).toMatchObject({ event: "message.custom-webhook.me", payload: { text: "yes" } });
  });

  it("is picked with { channel: \"custom-webhook\" } next to other channels", async () => {
    const { fetch, calls } = mockFetch((call) => (call.url.includes("telegram") ? json({ ok: true, result: { message_id: 1 } })() : json({})()));
    const messaging = combineMessaging([
      { kind: "telegram", provider: telegram.create(telegram.parseCredentials({ botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" }), context(fetch)) },
      { kind: "custom-webhook", provider: customWebhook.create(parse({}), context(fetch)) },
    ]);
    expect(await messaging.send("1", "a")).toMatchObject({ channel: "telegram" });
    expect(await messaging.send("me", "b", { channel: "custom-webhook" })).toMatchObject({ channel: "custom-webhook" });
    expect(await messaging.send("me", "c", { channel: " Custom-Webhook " })).toMatchObject({ channel: "custom-webhook" });
    await expect(messaging.send("me", "d", { channel: "webhook" })).rejects.toThrow(/Configured: telegram, custom-webhook/);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["api.telegram.org", "hooks.example.com", "hooks.example.com"]);
  });
});
