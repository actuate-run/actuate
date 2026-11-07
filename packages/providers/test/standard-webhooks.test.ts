/**
 * Standard Webhooks signing. The vectors were produced by the official `standardwebhooks` npm package (1.1.1);
 * the first is the one in the spec itself.
 */
import { describe, expect, it } from "vitest";
import { signStandardWebhook, verifyStandardWebhook } from "../src/index.js";
import { standardWebhookKey } from "../src/standard-webhooks.js";

const SPEC_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

const VECTORS: Array<[secret: string, id: string, timestamp: number, body: string, signature: string]> = [
  [SPEC_SECRET, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}', "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="],
  [
    "whsec_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    "msg_0123456789abcdef0123456789abcdef",
    1793664000,
    '{"id":"msg_1","to":"me","text":"Héllo 👋\\nline"}',
    "v1,fGk5EYJxmzpzGq+16hvuOK5ubA5MHRV8PF4+tIrGfXI=",
  ],
  [
    "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw==",
    "evt",
    1700000000,
    "plain text body",
    "v1,7kIL7oBHYCv/x8gISp1IjFESs2NV+t4/IdXC/eudZWY=",
  ],
];

const headers = (id: string, timestamp: number, signature: string) =>
  new Headers({ "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": signature });

describe("Standard Webhooks", () => {
  it.each(VECTORS)("signs like the official library (%#)", async (secret, id, ts, body, signature) => {
    expect(await signStandardWebhook(secret, id, ts, body)).toBe(signature);
  });

  it.each(VECTORS)("verifies the official library's signatures (%#)", async (secret, id, ts, body, signature) => {
    await expect(verifyStandardWebhook(secret, headers(id, ts, signature), body, ts * 1000)).resolves.toEqual({ ok: true, id, timestamp: ts });
  });

  it("refuses a changed body, id or timestamp", async () => {
    const [secret, id, ts, body, signature] = VECTORS[0]!;
    for (const [h, b] of [
      [headers(id, ts, signature), `${body} `],
      [headers("msg_other", ts, signature), body],
      [headers(id, ts + 1, signature), body],
    ] as const) {
      expect(await verifyStandardWebhook(secret, h, b, ts * 1000)).toEqual({ ok: false, reason: "no webhook-signature matches the body" });
    }
    // Same message, different secret.
    expect((await verifyStandardWebhook(VECTORS[1]![0], headers(id, ts, signature), body, ts * 1000)).ok).toBe(false);
  });

  it("accepts any one matching v1 signature among several (secret rotation) and skips other versions", async () => {
    const [secret, id, ts, body, signature] = VECTORS[0]!;
    const sig = signature.slice(3);
    const several = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1a,${sig} ${signature}`;
    expect((await verifyStandardWebhook(secret, headers(id, ts, several), body, ts * 1000)).ok).toBe(true);
    // The right bytes under another version tag do not count.
    expect((await verifyStandardWebhook(secret, headers(id, ts, `v2,${sig} v1a,${sig}`), body, ts * 1000)).ok).toBe(false);
  });

  it("allows five minutes of clock skew either way", async () => {
    const [secret, id, ts, body, signature] = VECTORS[0]!;
    const at = (offsetSeconds: number) => verifyStandardWebhook(secret, headers(id, ts, signature), body, (ts + offsetSeconds) * 1000);
    expect((await at(300)).ok).toBe(true);
    expect((await at(-300)).ok).toBe(true);
    expect(await at(301)).toEqual({ ok: false, reason: expect.stringMatching(/more than 5 minutes/) });
    expect(await at(-301)).toEqual({ ok: false, reason: expect.stringMatching(/more than 5 minutes/) });
  });

  it("explains missing or malformed headers", async () => {
    const [secret, id, ts, body, signature] = VECTORS[0]!;
    expect(await verifyStandardWebhook(secret, new Headers({ "webhook-id": id }), body)).toEqual({ ok: false, reason: expect.stringMatching(/missing/) });
    expect(await verifyStandardWebhook(secret, new Headers({ "webhook-id": id, "webhook-timestamp": "soon", "webhook-signature": signature }), body)).toEqual({
      ok: false,
      reason: expect.stringMatching(/Unix seconds/),
    });
    expect(await verifyStandardWebhook(secret, headers(id, ts, "garbage"), body, ts * 1000)).toEqual({ ok: false, reason: expect.stringMatching(/no webhook-signature/) });
  });

  it("takes whsec_ secrets of 24 to 64 bytes", async () => {
    const b64 = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(1)));
    expect(standardWebhookKey(SPEC_SECRET)?.length).toBe(24);
    expect(standardWebhookKey(`whsec_${b64(32)}`)?.length).toBe(32);
    expect(standardWebhookKey(`whsec_${b64(64)}`)?.length).toBe(64);
    for (const bad of [`whsec_${b64(16)}`, `whsec_${b64(65)}`, b64(32), `whsec_${b64(32).replace(/=/g, "")}!`, "whsec_", `whsec_${b64(32)}===`]) {
      expect(standardWebhookKey(bad)).toBeNull();
    }
    await expect(signStandardWebhook("not-a-secret", "id", 1, "")).rejects.toThrow(/whsec_/);
  });
});
