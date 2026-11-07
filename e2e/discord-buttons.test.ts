/**
 * Discord approval buttons end to end in the self-hosted runtime (workerd): the bot posts the approval with
 * interactive buttons to a fake Discord API, Discord's endpoint check (a signed PING) gets its PONG, and signed
 * button interactions decide the run, Ed25519-verified inside workerd with the application's public key.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

const local = "http://localhost";
const hook = `${local}/providers/discord/webhook`;
const CHANNEL = "1100000000000000000";
const ALICE = "123456789012345678";
const MALLORY = "555555555555555555";
const ROLE = "876543210987654321";
const sent: Array<{ url: string; auth: string | null; body: any }> = [];
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
let mf: Miniflare;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/discord-buttons-entry.ts", import.meta.url))],
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
      ACTUATE_PUBLIC_URL: "https://self.test",
      ACTUATE_MESSAGING: "discord",
      DISCORD_BOT_TOKEN: "fake.bot.token",
      DISCORD_PUBLIC_KEY: toHex(await crypto.subtle.exportKey("raw", pair.publicKey)),
      DISCORD_APPROVERS: `role:${ROLE}`,
    },
    // The fake Discord API: Create Message records the message and answers with its id.
    outboundService: async (req: Request) => {
      const url = new URL(req.url);
      if (url.host !== "discord.com" || req.method !== "POST" || !/^\/api\/v10\/channels\/\d+\/messages$/.test(url.pathname)) {
        return new Response("unexpected", { status: 404 });
      }
      sent.push({ url: req.url, auth: req.headers.get("authorization"), body: await req.json() });
      return Response.json({ id: `m${sent.length}` });
    },
  });
}, 60_000);

afterAll(() => mf?.dispose());

const start = async (input: Record<string, string>) =>
  (await (await mf.dispatchFetch(`${local}/run`, { method: "POST", body: JSON.stringify(input) })).json()) as any;
const getRun = async (runId: string) => (await (await mf.dispatchFetch(`${local}/runs/${runId}`)).json()) as any;

async function signed(body: unknown, opts: { badSignature?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  let signature = toHex(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(timestamp + raw)));
  if (opts.badSignature) signature = signature.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  const res = await mf.dispatchFetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type"), text, body: text ? JSON.parse(text) : null };
}

const press = (customId: string, user: { id: string; username: string; global_name?: string }, roles: string[] = []) =>
  signed({
    type: 3,
    id: "1",
    application_id: "2",
    token: "interaction-token",
    data: { custom_id: customId, component_type: 2 },
    member: { user, roles },
    message: { id: "m1", content: sent.at(-1)!.body.content },
  });

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

it("answers Discord's PING, and refuses unsigned requests", async () => {
  const pong = await signed({ type: 1, id: "1", application_id: "2", token: "t", version: 1 });
  expect(pong).toMatchObject({ status: 200, type: "application/json", text: '{"type":1}' });
  expect((await signed({ type: 1 }, { badSignature: true })).status).toBe(401);
  expect((await mf.dispatchFetch(hook, { method: "POST", body: '{"type":1}' })).status).toBe(401);
}, 60_000);

it("decides the run on a signed click from an approver, and refuses the rest", async () => {
  const run = await start({ to: CHANNEL });
  expect(run.status).toBe("WAITING");
  const message = sent.at(-1)!;
  expect(message.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
  expect(message.auth).toBe("Bot fake.bot.token");
  expect(message.body.content).toMatch(/^Refund RM 20\?\n\nApprove: https:\/\/self\.test\/approve\?token=\S+\nReject: https:\/\/self\.test\/approve\?token=\S+$/);
  const [approve, reject] = message.body.components[0].components;
  expect(approve).toMatchObject({ type: 2, style: 3, label: "Approve", custom_id: expect.stringMatching(/^ap1:local:[A-Za-z0-9_-]{16}:a$/) });
  expect(reject).toMatchObject({ type: 2, style: 4, label: "Reject", custom_id: approve.custom_id.replace(/:a$/, ":r") });
  expect(message.body.components[0].type).toBe(1);
  const nonce = approve.custom_id.split(":")[2];
  expect(JSON.stringify(await getRun(run.runId))).not.toContain(nonce);

  // Not on the approver list (no listed role): told privately, nothing decided.
  const refused = await press(approve.custom_id, { id: MALLORY, username: "mallory" }, ["111111111111111111"]);
  expect(refused.body).toEqual({ type: 4, data: { content: "You're not on the approver list for this.", flags: 64, allowed_mentions: { parse: [] } } });
  expect((await getRun(run.runId)).status).toBe("WAITING");

  // An approver through their role: the message is updated in the response itself.
  const decided = await press(approve.custom_id, { id: ALICE, username: "alice", global_name: "Alice" }, [ROLE]);
  expect(decided.status).toBe(200);
  expect(decided.type).toBe("application/json");
  expect(decided.body.type).toBe(7);
  expect(decided.body.data.components).toEqual([]);
  expect(decided.body.data.content).toMatch(/^Refund RM 20\?\n\nApproved by Alice at \d\d:\d\d UTC$/);
  expect(decided.text).not.toMatch(/https?:|token=/);

  const done = await until(() => getRun(run.runId), (r) => r.status === "COMPLETED");
  expect(done.output).toMatchObject({ approved: true, via: "chat", by: `discord:${ALICE} (Alice)` });
  expect(JSON.stringify(done)).not.toContain(nonce);

  // A second click: "already", privately, and no edit.
  const again = await press(reject.custom_id, { id: ALICE, username: "alice", global_name: "Alice" }, [ROLE]);
  expect(again.body).toEqual({ type: 4, data: { content: "Already approved by Alice", flags: 64, allowed_mentions: { parse: [] } } });

  // Another actuator's button.
  const foreign = await press(approve.custom_id.replace(":local:", ":act_0123456789abcdef:"), { id: ALICE, username: "alice" }, [ROLE]);
  expect(foreign.body.data.content).toBe("This button belongs to another actuator.");
}, 60_000);
