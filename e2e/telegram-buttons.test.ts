/**
 * Telegram approval buttons end to end in the self-hosted runtime (workerd): the real Telegram provider, a fake
 * Bot API (api.telegram.org mocked through Miniflare's outbound service) that records sendMessage and
 * editMessageText, and clicks posted as callback_query updates with the secret token header, the way Telegram
 * delivers them to the bot's webhook.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const SECRET = "tg-secret_token";
const CHAT = -1001234567890;
const local = "http://localhost";
const hook = `${local}/providers/telegram/webhook`;

interface ApiCall {
  method: string;
  body: Record<string, any>;
}
const calls: ApiCall[] = [];
const sends = () => calls.filter((c) => c.method === "sendMessage");
const edits = () => calls.filter((c) => c.method === "editMessageText");
let mf: Miniflare;
let updateId = 900;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/telegram-buttons-entry.ts", import.meta.url))],
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
      ACTUATE_MESSAGING: "telegram",
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET_TOKEN: SECRET,
      TELEGRAM_APPROVERS: "42, 43",
    },
    outboundService: async (req: Request) => {
      const url = new URL(req.url);
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
      if (url.hostname !== "api.telegram.org" || !m || m[1] !== BOT_TOKEN) return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
      const body = JSON.parse(await req.text());
      calls.push({ method: m[2]!, body });
      if (m[2] === "sendMessage") return Response.json({ ok: true, result: { message_id: 500 + calls.length, chat: { id: Number(body.chat_id) }, date: 1, text: body.text } });
      return Response.json({ ok: true, result: { message_id: body.message_id } });
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

/** POST an update to the bot's webhook, as Telegram does (with the secret token header unless told otherwise). */
async function post(update: Record<string, unknown>, secret: string | null = SECRET) {
  const res = await mf.dispatchFetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }) },
    body: JSON.stringify({ update_id: ++updateId, ...update }),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type"), body: text ? JSON.parse(text) : null };
}

/** A user pressing a button on the bot's last message: https://core.telegram.org/bots/api#callbackquery */
function click(data: string, from: { id: number; first_name: string; last_name?: string; username?: string }, secret?: string | null) {
  const sent = sends().at(-1)!;
  return post(
    {
      callback_query: {
        id: `cbq-${updateId + 1}`,
        from: { is_bot: false, language_code: "en", ...from },
        message: {
          message_id: 500 + calls.indexOf(sent) + 1,
          from: { id: 123456789, is_bot: true, first_name: "Refund bot", username: "refund_bot" },
          chat: { id: CHAT, title: "Ops", type: "supergroup" },
          date: 1793664000,
          text: sent.body.text,
          reply_markup: sent.body.reply_markup,
        },
        chat_instance: "-7428390749209",
        data,
      },
    },
    secret,
  );
}

const answer = (id: string, text: string) => ({ method: "answerCallbackQuery", callback_query_id: id, text });

it("sends callback buttons, resumes the run on an approver's click, edits the message and refuses the rest", async () => {
  const run = await start({ chat: String(CHAT) });
  expect(run.status).toBe("WAITING");
  const message = sends().at(-1)!.body;
  expect(message.chat_id).toBe(String(CHAT));
  expect(message.text).toMatch(/^Refund RM 20\?\n\nApprove: http:\/\/self\.test\/approve\?token=\S+\nReject: http:\/\/self\.test\/approve\?token=\S+$/);
  const [[approve, reject, ...more], ...rows] = message.reply_markup.inline_keyboard;
  expect(more).toEqual([]);
  expect(rows).toEqual([]);
  expect(approve).toEqual({ text: "Approve", callback_data: expect.stringMatching(/^ap1:local:[A-Za-z0-9_-]{16}:a$/) });
  expect(reject).toEqual({ text: "Reject", callback_data: approve.callback_data.replace(/:a$/, ":r") });
  expect(new TextEncoder().encode(approve.callback_data).length).toBeLessThanOrEqual(64);
  const nonce = approve.callback_data.split(":")[2];
  expect(JSON.stringify(await getRun(run.runId))).not.toContain(nonce);

  // The secret token header: missing or wrong is 401, and nothing is decided.
  expect((await click(approve.callback_data, { id: 42, first_name: "Wei" }, null)).status).toBe(401);
  expect((await click(approve.callback_data, { id: 42, first_name: "Wei" }, "wrong")).status).toBe(401);
  // Not on the approver list.
  const refused = await click(approve.callback_data, { id: 999, first_name: "Mallory" });
  expect(refused).toMatchObject({ status: 200, type: "application/json" });
  expect(refused.body).toEqual(answer(`cbq-${updateId}`, "You're not on the approver list for this."));
  // Another actuator's button.
  expect((await click(approve.callback_data.replace(":local:", ":act_0123456789abcdef:"), { id: 42, first_name: "Wei" })).body).toEqual(
    answer(`cbq-${updateId}`, "This button belongs to another actuator."),
  );
  expect((await getRun(run.runId)).status).toBe("WAITING");
  expect(edits()).toHaveLength(0);

  // The approver's click: answered in the webhook response at once, then the alarm resumes the run.
  const decided = await click(approve.callback_data, { id: 42, first_name: "Wei", last_name: "Tan", username: "weitan" });
  expect(decided.status).toBe(200);
  expect(decided.type).toBe("application/json");
  expect(decided.body).toEqual({ method: "answerCallbackQuery", callback_query_id: `cbq-${updateId}`, text: expect.stringMatching(/^Approved by Wei Tan at \d\d:\d\d UTC$/) });
  const done = await until(() => getRun(run.runId), (r) => r.status === "COMPLETED");
  expect(done.output).toMatchObject({ approved: true, by: "telegram:42 (Wei Tan)", via: "chat" });
  expect(JSON.stringify(done)).not.toContain(nonce);

  // The follow-up edited the message through editMessageText: links and buttons gone, the decision in.
  await until(async () => edits().length, (n) => n > 0);
  expect(edits()).toHaveLength(1);
  expect(edits()[0]!.body).toEqual({
    chat_id: CHAT,
    message_id: 500 + calls.indexOf(sends().at(-1)!) + 1,
    text: expect.stringMatching(/^Refund RM 20\?\n\nApproved by Wei Tan at \d\d:\d\d UTC$/),
    reply_markup: { inline_keyboard: [] },
  });

  // A second click: "Already...", to the clicker only, no second edit.
  expect((await click(reject.callback_data, { id: 43, first_name: "Bob" })).body).toEqual(answer(`cbq-${updateId}`, "Already approved by Wei Tan"));
  await new Promise((r) => setTimeout(r, 100));
  expect(edits()).toHaveLength(1);
}, 60_000);

it("gives an input request an Answer link button", async () => {
  await start({ chat: "5551234", mode: "ask" });
  const message = sends().at(-1)!.body;
  expect(message.text).toMatch(/^Why\?\n\nAnswer: (http:\/\/self\.test\/\S+)$/);
  expect(message.reply_markup).toEqual({ inline_keyboard: [[{ text: "Answer", url: /Answer: (\S+)$/.exec(message.text)![1] }]] });
}, 60_000);

it("still turns ordinary messages into events, and never a callback query", async () => {
  const msg = await post({
    message: { message_id: 7, date: 1793664000, chat: { id: 5551234, type: "private" }, from: { id: 5551234, is_bot: false, first_name: "Wei" }, text: "Done" },
  });
  expect(msg.status).toBe(200);
  expect(msg.body).toMatchObject({ event: "message.telegram.5551234", buffered: true });
  // Someone else's callback data: not a click, and not a message event either, but answered so the spinner stops.
  await start({ chat: String(CHAT) });
  const other = await click("menu:page:2", { id: 42, first_name: "Wei" });
  expect(other).toMatchObject({ status: 200, type: "application/json" });
  expect(other.body).toEqual({ method: "answerCallbackQuery", callback_query_id: `cbq-${updateId}` });
  // A message update with a wrong secret is still refused.
  expect((await post({ message: { message_id: 8, date: 1, chat: { id: 5551234 }, text: "x" } }, "wrong")).status).toBe(401);
}, 60_000);
