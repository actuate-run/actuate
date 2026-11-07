/**
 * Deciding an approval from a custom webhook receiver, in the self-hosted runtime (workerd): the receiver gets
 * `approval.decide`, POSTs a payload back to the Reply URL with the signing secret and who decided, and the run
 * resumes with via "chat". Outbound HTTP (the receiver) is mocked and recorded.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { signStandardWebhook } from "@actuate/providers";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const base = "http://self.test";
const local = "http://localhost";
const received: any[] = [];
let mf: Miniflare;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/custom-buttons-entry.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"],
    conditions: ["workerd", "worker", "import"], mainFields: ["module", "main"], write: false,
  });
  mf = new Miniflare({
    modules: true,
    script: out.outputFiles[0]!.text,
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ACTUATOR: { className: "ActuatorObject", useSQLite: true } },
    bindings: {
      ACTUATE_DEV: "1",
      ACTUATE_PUBLIC_URL: base,
      ACTUATE_MESSAGING: "custom-webhook",
      CUSTOM_WEBHOOK_URL: "https://receiver.example.test/actuate",
      CUSTOM_WEBHOOK_SECRET: SECRET,
      CUSTOM_WEBHOOK_APPROVERS: "alice, bob",
    },
    outboundService: async (req: Request) => {
      received.push(JSON.parse(await req.text()));
      return Response.json({ ok: true });
    },
  });
}, 60_000);

afterAll(() => mf?.dispose());

const start = async (input: Record<string, string>) =>
  (await (await mf.dispatchFetch(`${local}/run`, { method: "POST", body: JSON.stringify(input) })).json()) as any;
const getRun = async (runId: string) => (await (await mf.dispatchFetch(`${local}/runs/${runId}`)).json()) as any;

async function decide(url: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
  const res = await mf.dispatchFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, type: res.headers.get("content-type"), body: (await res.json()) as any };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

it("resumes the run when the receiver posts the approve payload back", async () => {
  const run = await start({ to: "ops" });
  expect(run.status).toBe("WAITING");
  const message = received.at(-1)!;
  expect(message).toMatchObject({ to: "ops", replyUrl: `${base}/providers/custom-webhook/webhook`, approval: { kind: "approval", step: "ok" } });
  const { approve, reject, url } = message.approval.decide;
  expect(url).toBe(message.replyUrl);
  expect(approve).toMatch(/^ap1:local:[A-Za-z0-9_-]{16}:a$/);
  expect(reject).toBe(approve.replace(/:a$/, ":r"));
  // The links stay.
  expect(message.text).toContain(message.approval.approveUrl);
  const nonce = approve.split(":")[2];
  expect(JSON.stringify(await getRun(run.runId))).not.toContain(nonce);

  // Auth like replies: none, wrong, or the secret in the URL → 401, nothing decided.
  expect((await decide(url, { decision: approve, by: { id: "alice" } }, {})).status).toBe(401);
  expect((await decide(url, { decision: approve, by: { id: "alice" } }, { authorization: "Bearer wrong" })).status).toBe(401);
  expect((await decide(`${url}?secret=${encodeURIComponent(SECRET)}`, { decision: approve, by: { id: "alice" } }, {})).status).toBe(401);
  // No `by`: 400.
  expect(await decide(url, { decision: approve })).toMatchObject({ status: 400, body: { status: "invalid" } });
  // Not on the approver list.
  expect(await decide(url, { decision: approve, by: { id: "mallory", name: "Alice" } })).toMatchObject({
    status: 200,
    body: { status: "not-approver", message: "You're not on the approver list for this." },
  });
  // Another actuator's payload.
  expect((await decide(url, { decision: approve.replace(":local:", ":act_0123456789abcdef:"), by: { id: "alice" } })).body).toEqual({
    status: "foreign",
    message: "This button belongs to another actuator.",
  });
  expect((await getRun(run.runId)).status).toBe("WAITING");

  const decided = await decide(url, { decision: approve, by: { id: "alice", name: "Alice Tan" } });
  expect(decided).toMatchObject({ status: 200, type: "application/json" });
  expect(decided.body).toEqual({
    status: "decided",
    decision: "approved",
    by: "custom-webhook:alice (Alice Tan)",
    at: expect.any(String),
    message: expect.stringMatching(/^Approved by Alice Tan at \d\d:\d\d UTC$/),
  });
  expect(JSON.stringify(decided.body)).not.toContain(nonce);
  const done = await until(() => getRun(run.runId), (r) => r.status === "COMPLETED");
  expect(done.output).toMatchObject({ approved: true, via: "chat", by: "custom-webhook:alice (Alice Tan)" });
  expect(JSON.stringify(done)).not.toContain(nonce);

  // A second decision, signed the Standard Webhooks way this time: "already".
  const body = JSON.stringify({ decision: reject, by: { id: "bob" } });
  const at = Math.floor(Date.now() / 1000);
  const res = await mf.dispatchFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": "msg_d2", "webhook-timestamp": String(at), "webhook-signature": await signStandardWebhook(SECRET, "msg_d2", at, body) },
    body,
  });
  expect(await res.json()).toEqual({ status: "already", decision: "approved", by: "custom-webhook:alice (Alice Tan)", at: decided.body.at, message: "Already approved by Alice Tan" });
  expect((await getRun(run.runId)).output).toMatchObject({ approved: true });
}, 60_000);

it("rejects with the reject payload", async () => {
  const run = await start({ to: "ops" });
  const { reject, url } = received.at(-1)!.approval.decide;
  expect((await decide(url, { decision: reject, by: { id: "bob" } })).body).toMatchObject({ status: "decided", decision: "rejected", by: "custom-webhook:bob" });
  const done = await until(() => getRun(run.runId), (r) => r.status === "COMPLETED");
  expect(done.output).toMatchObject({ approved: false, via: "chat", by: "custom-webhook:bob" });
}, 60_000);

it("still takes ordinary { from, text } replies as message events", async () => {
  const run = await start({ to: "me", mode: "reply" });
  expect(run.status).toBe("WAITING");
  const res = await decide(`${base}/providers/custom-webhook/webhook`, { from: "me", text: "yes" });
  expect(res.body).toMatchObject({ event: "message.custom-webhook.me", resumed: [run.runId] });
  expect((await until(() => getRun(run.runId), (r) => r.status === "COMPLETED")).output).toEqual({ answer: "yes" });
}, 60_000);
