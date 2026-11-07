/** The custom webhook channel in the self-hosted runtime (workerd): a signed send out, a reply back in. Outbound HTTP is mocked. */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { verifyStandardWebhook } from "@actuate/providers";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const base = "http://self.test";
const local = "http://localhost";
const sent: Array<{ url: string; headers: Headers; body: string }> = [];
let mf: Miniflare;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/reply-entry.ts", import.meta.url))],
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
      ACTUATE_MESSAGING: "telegram,custom-webhook",
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      CUSTOM_WEBHOOK_URL: "https://hooks.example.test/in",
      CUSTOM_WEBHOOK_SECRET: SECRET,
      CUSTOM_WEBHOOK_HEADERS: "X-Api-Key: k-123",
    },
    outboundService: async (req: Request) => {
      sent.push({ url: req.url, headers: req.headers, body: await req.text() });
      return Response.json({ received: true });
    },
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  await approvals?.dispose();
});

let approvals: Miniflare | undefined;

it("sends a signed message with a reply URL, and resumes on the reply", async () => {
  const started = await (await mf.dispatchFetch(`${local}/run`, { method: "POST", body: JSON.stringify({ to: "me" }) })).json<any>();
  expect(started.status).toBe("WAITING");
  expect(sent).toHaveLength(1);
  const out = sent[0]!;
  expect(out.url).toBe("https://hooks.example.test/in");
  expect(out.headers.get("x-api-key")).toBe("k-123");
  expect(await verifyStandardWebhook(SECRET, out.headers, out.body)).toMatchObject({ ok: true });
  const body = JSON.parse(out.body);
  expect(body).toMatchObject({ to: "me", text: "Approve the refund?", subject: "Refund", replyUrl: `${base}/providers/custom-webhook/webhook` });

  const post = (url: string, headers: Record<string, string> = {}) =>
    mf.dispatchFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ from: "me", text: "yes" }) });
  expect((await post(body.replyUrl)).status).toBe(401);
  expect((await post(body.replyUrl, { authorization: "Bearer wrong" })).status).toBe(401);
  expect((await post(`${body.replyUrl}?secret=wrong`)).status).toBe(401);
  const res = await post(body.replyUrl, { authorization: `Bearer ${SECRET}` });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ event: "message.custom-webhook.me", resumed: [started.runId] });
  const run = await (await mf.dispatchFetch(`${local}/runs/${started.runId}`)).json<any>();
  expect(run).toMatchObject({ status: "COMPLETED", output: { answer: "yes" } });
  // A secret in the URL is not accepted, even the right one.
  expect((await post(`${body.replyUrl}?secret=${encodeURIComponent(SECRET)}`)).status).toBe(401);
  // With no run waiting, a reply is buffered.
  const again = await post(body.replyUrl, { authorization: `Bearer ${SECRET}` });
  expect(await again.json()).toMatchObject({ event: "message.custom-webhook.me", buffered: true });
});

it("sends approval requests with an approval object, through the approval template when one is set", async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/reply-entry.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"],
    conditions: ["workerd", "worker", "import"], mainFields: ["module", "main"], write: false,
  });
  const got: Array<{ url: string; body: string }> = [];
  const worker = (bindings: Record<string, string>) =>
    new Miniflare({
      modules: true,
      script: out.outputFiles[0]!.text,
      compatibilityDate: "2025-09-01",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { ACTUATOR: { className: "ActuatorObject", useSQLite: true } },
      bindings: { ACTUATE_DEV: "1", ACTUATE_PUBLIC_URL: base, ACTUATE_MESSAGING: "custom-webhook", CUSTOM_WEBHOOK_URL: "https://hooks.example.test/approvals", ...bindings },
      outboundService: async (req: Request) => {
        got.push({ url: req.url, body: await req.text() });
        return Response.json({});
      },
    });
  const start = async (on: Miniflare, mode: string) => (await (await on.dispatchFetch(`${local}/run`, { method: "POST", body: JSON.stringify({ to: "boss", mode }) })).json()) as any;

  approvals = worker({});
  const run = await start(approvals, "approve");
  expect(run.status).toBe("WAITING");
  const body = JSON.parse(got.at(-1)!.body);
  expect(body).toMatchObject({ to: "boss", subject: "Approval needed: reply", approval: { kind: "approval", actuator: "reply", step: "ok", message: "Refund RM 20?" } });
  expect(body.approval.approveUrl).toMatch(new RegExp(`^${base}/approve\\?token=`));
  expect(body.text).toContain(body.approval.approveUrl);
  expect(new Date(body.approval.expiresAt).toISOString()).toBe(body.approval.expiresAt);
  // The link opens the confirm page and decides only on POST.
  const token = new URL(body.approval.approveUrl).searchParams.get("token")!;
  expect((await approvals.dispatchFetch(`${local}/approve?token=${token}`)).status).toBe(200);
  expect((await (await approvals.dispatchFetch(`${local}/runs/${run.runId}`)).json<any>()).status).toBe("WAITING");

  // A question: "Input needed", with the answer link.
  await start(approvals, "ask");
  const asked = JSON.parse(got.at(-1)!.body);
  expect(asked).toMatchObject({ subject: "Input needed: reply", approval: { kind: "input", step: "why", message: "Why?" } });
  expect(asked.approval.answerUrl).toMatch(/\/approve\?token=/);

  // Actuator code's own sends never carry an approval.
  await start(approvals, "fake");
  expect(JSON.parse(got.at(-1)!.body)).not.toHaveProperty("approval");
  await approvals.dispose();

  approvals = worker({ CUSTOM_WEBHOOK_APPROVAL_TEMPLATE: '{"title":"{{subject}}","yes":"{{approveUrl}}","no":"{{rejectUrl}}","until":"{{expiresAt}}"}' });
  await start(approvals, "approve");
  const card = JSON.parse(got.at(-1)!.body);
  expect(Object.keys(card)).toEqual(["title", "yes", "no", "until"]);
  expect(card.yes).toMatch(/\/approve\?token=/);
  await start(approvals, "reply");
  expect(JSON.parse(got.at(-1)!.body)).toMatchObject({ to: "boss", text: "Approve the refund?" });
}, 60_000);
