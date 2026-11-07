/**
 * Slack approval buttons end to end under workerd: the self-hosted worker with the real Slack provider posts the
 * approval to a fake incoming webhook with Block Kit buttons, then a correctly signed block_actions click on
 * POST /providers/slack/webhook resumes the run, and the follow-up goes to the click's response_url.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { hmacSha256Hex } from "@actuate/providers";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const WEBHOOK = "https://hooks.slack.com/services/T0001/B0001/XXXXXXXX";
const local = "http://localhost";
const hook = `${local}/providers/slack/webhook`;

interface Button { action_id: string; value?: string; url?: string; style?: string; text: { text: string } }
interface Posted { text: string; blocks: Array<{ type: string; text?: { text: string }; elements?: Button[] }> }
const posted: Posted[] = [];
const responses: Array<{ url: string; body: any }> = [];
const unexpected: string[] = [];
let mf: Miniflare;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/slack-buttons-entry.ts", import.meta.url))],
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
      ACTUATE_PUBLIC_URL: "http://self.test",
      ACTUATE_MESSAGING: "slack",
      SLACK_WEBHOOK_URL: WEBHOOK,
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      SLACK_APPROVERS: "U01ALICE, U02BOB",
    },
    // The fake Slack: the incoming webhook records messages, response URLs record follow-ups. Both answer "ok".
    outboundService: async (req: Request) => {
      const body = await req.text();
      if (req.url === WEBHOOK) posted.push(JSON.parse(body));
      else if (req.url.startsWith("https://hooks.slack.com/actions/")) responses.push({ url: req.url, body: JSON.parse(body) });
      else unexpected.push(req.url);
      return new Response("ok");
    },
  });
}, 60_000);

afterAll(() => mf?.dispose());

const start = async (input: Record<string, string>) =>
  (await (await mf.dispatchFetch(`${local}/run`, { method: "POST", body: JSON.stringify(input) })).json()) as any;
const getRun = async (runId: string) => (await (await mf.dispatchFetch(`${local}/runs/${runId}`)).json()) as any;

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

let clicks = 0;
/** A block_actions click, signed the way Slack signs it (v0 HMAC of "v0:<timestamp>:<raw body>"). */
async function click(action: { action_id: string; value?: string }, user: { id: string; username?: string; name?: string }, opts: { secret?: string; age?: number } = {}) {
  const responseUrl = `https://hooks.slack.com/actions/T0001/${++clicks}/resp${clicks}`;
  const payload = {
    type: "block_actions",
    team: { id: "T0001", domain: "example" },
    user: { team_id: "T0001", ...user },
    api_app_id: "A0001",
    container: { type: "message", message_ts: "1793664000.000100", channel_id: "C0001", is_ephemeral: false },
    channel: { id: "C0001", name: "approvals" },
    // What Slack sends back: the message as posted, its fallback text included.
    message: { type: "message", text: posted.at(-1)!.text, blocks: posted.at(-1)!.blocks, ts: "1793664000.000100" },
    response_url: responseUrl,
    actions: [{ block_id: "actuate_approval", type: "button", text: { type: "plain_text", text: "Approve" }, action_ts: "1793664001.000200", ...action }],
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = String(Math.floor(Date.now() / 1000) - (opts.age ?? 0));
  const res = await mf.dispatchFetch(hook, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": `v0=${await hmacSha256Hex(opts.secret ?? SIGNING_SECRET, `v0:${ts}:${body}`)}`,
    },
    body,
  });
  return { status: res.status, body: await res.text(), responseUrl };
}

/** The follow-up posted to a click's response_url (after() runs in waitUntil, once the ack is sent). */
const responseTo = (url: string) => until(async () => responses.find((r) => r.url === url), Boolean);

it("posts Block Kit buttons, resumes the run on a signed approver click and answers through response_url", async () => {
  const run = await start({ to: "C0001" });
  expect(run.status).toBe("WAITING");

  // The webhook post: the fallback text with its links, a section with the message, interactive buttons.
  const message = posted.at(-1)!;
  expect(message.text).toMatch(/^Refund RM 20 to Aina\?\n\nApprove: http:\/\/self\.test\/approve\?token=\S+\nReject: http:\/\/self\.test\/approve\?token=\S+$/);
  expect(message.blocks[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: message.text } });
  const [approve, reject] = message.blocks[1]!.elements!;
  expect(approve).toMatchObject({ action_id: "actuate_approve", style: "primary", text: { text: "Approve" } });
  expect(reject).toMatchObject({ action_id: "actuate_reject", style: "danger", text: { text: "Reject" } });
  expect(approve!.value).toMatch(/^ap1:local:[A-Za-z0-9_-]{16}:a$/);
  expect(reject!.value).toBe(approve!.value!.replace(/:a$/, ":r"));
  expect(approve!.url).toBeUndefined();
  const nonce = approve!.value!.split(":")[2]!;
  expect(JSON.stringify(await getRun(run.runId))).not.toContain(nonce);

  // A bad signature or a stale timestamp: 401, nothing decided, nothing posted.
  expect((await click(approve!, { id: "U01ALICE", name: "alice" }, { secret: "wrong-secret" })).status).toBe(401);
  expect((await click(approve!, { id: "U01ALICE", name: "alice" }, { age: 301 })).status).toBe(401);
  // A url button click (no value of ours) still gets Slack's ack, and nothing else happens.
  const urlClick = await click({ action_id: "actuate_approve_link" }, { id: "U01ALICE", name: "alice" });
  expect(urlClick).toMatchObject({ status: 200, body: "" });

  // Someone not on the approver list: acked, told privately, the run still waits.
  const mallory = await click(approve!, { id: "U09MALLORY", username: "mallory" });
  expect(mallory).toMatchObject({ status: 200, body: "" });
  expect((await responseTo(mallory.responseUrl))!.body).toEqual({ response_type: "ephemeral", replace_original: false, text: "You're not on the approver list for this." });
  expect((await getRun(run.runId)).status).toBe("WAITING");

  // The approver: an empty 200 at once, the run resumes from the alarm with a verified `by`.
  const alice = await click(approve!, { id: "U01ALICE", username: "alice.k", name: "alice" });
  expect(alice).toMatchObject({ status: 200, body: "" });
  const done = await until(() => getRun(run.runId), (r) => r.status === "COMPLETED");
  expect(done.output).toMatchObject({ approved: true, via: "chat", by: "slack:U01ALICE (alice)" });
  expect(JSON.stringify(done)).not.toContain(nonce);

  // The message is replaced: links and buttons gone, the decision in.
  const replaced = (await responseTo(alice.responseUrl))!.body;
  expect(replaced.replace_original).toBe(true);
  expect(replaced.text).toMatch(/^Refund RM 20 to Aina\?\n\nApproved by alice at \d\d:\d\d UTC$/);
  expect(replaced.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: replaced.text } }]);
  expect(JSON.stringify(replaced)).not.toMatch(/token=|http/);

  // A second click: "already", told only to the clicker.
  const bob = await click(reject!, { id: "U02BOB", name: "bob" });
  expect(bob).toMatchObject({ status: 200, body: "" });
  expect((await responseTo(bob.responseUrl))!.body).toEqual({ response_type: "ephemeral", replace_original: false, text: "Already approved by alice" });

  // Another actuator's button: refused privately.
  const foreign = await click({ action_id: "actuate_approve", value: approve!.value!.replace(":local:", ":act_0123456789abcdef:") }, { id: "U01ALICE", name: "alice" });
  expect((await responseTo(foreign.responseUrl))!.body).toMatchObject({ response_type: "ephemeral", text: "This button belongs to another actuator." });

  // The url-button click and the refused requests posted nothing; nothing went anywhere but Slack.
  expect(responses.map((r) => r.url)).not.toContain(urlClick.responseUrl);
  expect(responses).toHaveLength(4);
  expect(unexpected).toEqual([]);
}, 60_000);

it("says 'already' for a step decided through its link", async () => {
  const run = await start({ to: "C0001" });
  const { text, blocks } = posted.at(-1)!;
  const token = new URL(/Reject: (\S+)/.exec(text)![1]!).searchParams.get("token")!;
  const form = new URLSearchParams({ token, by: "Aina" });
  expect((await mf.dispatchFetch(`${local}/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() })).status).toBe(200);
  expect((await getRun(run.runId)).output).toMatchObject({ approved: false, via: "link", by: "Aina" });
  const late = await click(blocks[1]!.elements![0]!, { id: "U01ALICE", name: "alice" });
  expect(late).toMatchObject({ status: 200, body: "" });
  expect((await responseTo(late.responseUrl))!.body).toEqual({ response_type: "ephemeral", replace_original: false, text: "Already rejected by Aina" });
}, 60_000);
