/**
 * Approve and Reject buttons in the self-hosted runtime (workerd), with a fake chat provider registered by the
 * fixture: a signed click resumes the run with via "chat", and refusals, replies and messages take their own paths.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { hmacSha256Hex } from "@actuate/providers";

const SECRET = "fake-signing-secret";
const local = "http://localhost";
const hook = `${local}/providers/fakechat/webhook`;
const sent: Array<{ to: string; text: string; buttons: string[]; channel?: string }> = [];
const edits: Array<{ id: string; text: string }> = [];
let mf: Miniflare;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/buttons-entry.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"],
    conditions: ["workerd", "worker", "import"], mainFields: ["module", "main"], write: false,
  });
  mf = new Miniflare({
    modules: true,
    script: out.outputFiles[0]!.text,
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ACTUATOR: { className: "ActuatorObject", useSQLite: true } },
    bindings: { ACTUATE_DEV: "1", ACTUATE_PUBLIC_URL: "http://self.test", FAKE_SECRET: SECRET, FAKE_APPROVERS: "42, 43 500 501" },
    outboundService: async (req: Request) => {
      const url = new URL(req.url);
      const body = JSON.parse(await req.text());
      if (url.pathname === "/send") sent.push(body);
      else if (url.pathname === "/edit") edits.push(body);
      return Response.json({ id: String(sent.length) });
    },
  });
}, 60_000);

afterAll(() => mf?.dispose());

const start = async (input: Record<string, string>) =>
  (await (await mf.dispatchFetch(`${local}/run`, { method: "POST", body: JSON.stringify(input) })).json()) as any;
const getRun = async (runId: string) => (await (await mf.dispatchFetch(`${local}/runs/${runId}`)).json()) as any;

async function click(callback: string, from: { id: string; name?: string }, opts: { sign?: string; via?: string } = {}) {
  const body = JSON.stringify({ callback, from, message: { id: "m1", text: sent.at(-1)!.text } });
  const res = await mf.dispatchFetch(opts.via ?? hook, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-signature": opts.sign ?? (await hmacSha256Hex(SECRET, body)) },
    body,
  });
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

it("resumes the run on a signed approver click, and refuses the rest", async () => {
  const run = await start({ to: "room-1" });
  expect(run.status).toBe("WAITING");
  const message = sent.at(-1)!;
  expect(message).toMatchObject({ to: "room-1" });
  expect(message.text).toMatch(/Approve: http:\/\/self\.test\/approve\?token=/);
  const [approve, reject] = message.buttons;
  expect(approve).toMatch(/^ap1:local:[A-Za-z0-9_-]{16}:a$/);
  expect(reject).toBe(approve!.replace(/:a$/, ":r"));
  const nonce = approve!.split(":")[2]!;

  // Nothing an agent can read holds the nonce.
  expect(JSON.stringify(await getRun(run.runId))).not.toContain(nonce);

  // A bad signature: 401, nothing decided.
  expect((await click(approve!, { id: "42", name: "Alice" }, { sign: "0".repeat(64) })).status).toBe(401);
  // Not on the approver list.
  expect(await click(approve!, { id: "999", name: "Mallory" })).toMatchObject({ status: 200, body: { text: "You're not on the approver list for this." } });
  // Another actuator's button.
  expect((await click(approve!.replace(":local:", ":act_0123456789abcdef:"), { id: "42" })).body).toEqual({ text: "This button belongs to another actuator." });
  // An unknown nonce.
  expect((await click(`ap1:local:${"A".repeat(16)}:a`, { id: "42" })).body).toEqual({ text: "This request has expired or was already decided." });
  // The same button replayed through another provider (no approver list there): decides nothing.
  expect((await click(approve!, { id: "999", name: "Mallory" }, { via: `${local}/providers/otherchat/webhook` })).body).toEqual({
    text: "This request has expired or was already decided.",
  });
  expect((await getRun(run.runId)).status).toBe("WAITING");

  // The approver: decided at once (the reply doesn't wait for the run), then the alarm resumes it.
  const decided = await click(approve!, { id: "42", name: "Alice" });
  expect(decided.status).toBe(200);
  expect(decided.type).toBe("application/json");
  expect(decided.body.text).toMatch(/^Approved by Alice at \d\d:\d\d UTC$/);
  const done = await until(() => getRun(run.runId), (r) => r.status === "COMPLETED");
  expect(done.output).toMatchObject({ approved: true, by: "fakechat:42 (Alice)", via: "chat" });
  expect(JSON.stringify(done)).not.toContain(nonce);

  // The follow-up edited the message: links gone, the decision in.
  await until(async () => edits.length, (n) => n > 0);
  expect(edits).toHaveLength(1);
  expect(edits[0]!.text).toMatch(/^Refund RM 20\?\n\nApproved by Alice at \d\d:\d\d UTC$/);

  // A second click: "already", and no second edit.
  expect((await click(reject!, { id: "43", name: "Bob" })).body).toEqual({ text: "Already approved by Alice" });
  expect(edits).toHaveLength(1);
}, 60_000);

it("says 'already' for a step decided through its link", async () => {
  const run = await start({ to: "room-2" });
  const { text, buttons } = sent.at(-1)!;
  const token = /Reject: (\S+)/.exec(text)![1]!;
  const form = new URLSearchParams({ token: new URL(token).searchParams.get("token")!, by: "Aina" });
  expect((await mf.dispatchFetch(`${local}/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() })).status).toBe(200);
  expect((await getRun(run.runId)).output).toMatchObject({ approved: false, via: "link", by: "Aina" });
  expect((await click(buttons[0]!, { id: "42" })).body).toEqual({ text: "Already rejected with a link" });
}, 60_000);

it("sends a provider's own reply verbatim, and passes other requests to the webhook", async () => {
  const ping = await mf.dispatchFetch(hook, { method: "POST", headers: { "x-fake-ping": "1" }, body: "{}" });
  expect(ping.status).toBe(200);
  expect(ping.headers.get("content-type")).toBe("application/json");
  expect(await ping.text()).toBe('{"type":1}');
  // An ordinary message isn't an interaction: parseWebhook makes it an event.
  const msg = await mf.dispatchFetch(hook, { method: "POST", body: JSON.stringify({ from: { id: "7" }, text: "hi" }) });
  expect(await msg.json()).toMatchObject({ event: "message.fakechat.7", buffered: true });
}, 60_000);

it("routes notify { to, channel } to that messaging channel", async () => {
  await start({ to: "room-3", channel: "fakechat" });
  expect(sent.at(-1)).toMatchObject({ to: "room-3", channel: "fakechat" });
  expect(sent.at(-1)!.buttons).toHaveLength(2);
}, 60_000);

it("answers 200 when the provider's reply or follow-up throws after the decision", async () => {
  const a = await start({ to: "room-4" });
  const failing = await mf.dispatchFetch(hook, {
    method: "POST",
    headers: { "x-fake-signature": await hmacSha256Hex(SECRET, JSON.stringify({ callback: sent.at(-1)!.buttons[0], from: { id: "500" } })) },
    body: JSON.stringify({ callback: sent.at(-1)!.buttons[0], from: { id: "500" } }),
  });
  expect(failing.status).toBe(200);
  expect(await failing.text()).toBe("");
  expect((await until(() => getRun(a.runId), (r) => r.status === "COMPLETED")).output).toMatchObject({ approved: true, by: "fakechat:500" });

  const b = await start({ to: "room-5" });
  const res = await click(sent.at(-1)!.buttons[1]!, { id: "501" });
  expect(res).toMatchObject({ status: 200, body: { text: expect.stringMatching(/^Rejected by fakechat:501 at/) } });
  expect((await until(() => getRun(b.runId), (r) => r.status === "COMPLETED")).output).toMatchObject({ approved: false, via: "chat" });
}, 60_000);
