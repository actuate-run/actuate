/** Self-hosted runtime with real provider adapters configured from env vars; outbound HTTP is mocked. */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { billplzSignature } from "@actuate/providers";

let mf: Miniflare;
const calls: Array<{ url: string; body: string }> = [];
let reference = "";
const base = "http://self.test";

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/paid-entry.ts", import.meta.url))],
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
      ACTUATE_MESSAGING: "telegram",
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      ACTUATE_PAYMENT: "billplz",
      BILLPLZ_API_KEY: "key",
      BILLPLZ_COLLECTION_ID: "col1",
      BILLPLZ_X_SIGNATURE_KEY: "xsig",
    },
    outboundService: async (req: Request) => {
      const body = await req.text();
      calls.push({ url: req.url, body });
      if (req.url.includes("api.telegram.org")) return Response.json({ ok: true, result: { message_id: 1, chat: { id: 9 } } });
      if (req.url.endsWith("/api/v3/bills") && req.method === "POST") {
        reference = new URLSearchParams(body).get("reference_1")!;
      }
      return Response.json({ id: "B1", collection_id: "col1", paid: req.method === "GET", state: "due", amount: 5000, paid_amount: 5000, url: "https://www.billplz.com/bills/B1", reference_1: reference });
    },
  });
}, 60_000);

afterAll(() => mf?.dispose());

it("sends through Telegram, bills through Billplz, and resumes on the signed callback", async () => {
  const started = await (await mf.dispatchFetch(`${base}/run`, { method: "POST", body: JSON.stringify({ chat: "9", email: "a@b.co" }) })).json<any>();
  expect(started.status).toBe("WAITING");
  const create = calls.find((c) => c.url.endsWith("/api/v3/bills"))!;
  expect(new URLSearchParams(create.body).get("callback_url")).toBe(`${base}/providers/billplz/webhook`);
  expect(calls.some((c) => c.url.includes("/sendMessage") && c.body.includes("billplz.com/bills/B1"))).toBe(true);

  const fields = { id: "B1", collection_id: "col1", paid: "true", state: "paid", amount: "5000", paid_amount: "5000", paid_at: "", url: "https://www.billplz.com/bills/B1" };
  const post = (f: Record<string, string>) =>
    mf.dispatchFetch(`${base}/providers/billplz/webhook`, { method: "POST", body: new URLSearchParams(f).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  expect((await post({ ...fields, x_signature: "bad" })).status).toBe(401);
  expect((await post({ ...fields, x_signature: await billplzSignature(fields, "xsig") })).status).toBe(200);
  const run = await (await mf.dispatchFetch(`${base}/runs/${started.runId}`)).json<any>();
  expect(run).toMatchObject({ status: "COMPLETED", output: { status: "paid" } });
});
