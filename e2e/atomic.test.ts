/**
 * ctx.db.batch / ctx.db.commitWithStep on a real SQLite-backed Durable Object (transactionSync), and the
 * runtime's default idempotency keys reaching Stripe and Resend through the real adapters (outbound mocked).
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

let mf: Miniflare;
const outbound: Array<{ url: string; method: string; key: string | null }> = [];
const auth = { authorization: "Bearer admin", "content-type": "application/json" };

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/atomic-entry.ts", import.meta.url))],
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
      ACTUATE_TOKEN: "admin",
      ACTUATE_PUBLIC_URL: "https://atomic.test",
      ACTUATE_MESSAGING: "resend",
      RESEND_API_KEY: "re_test",
      RESEND_FROM: "Bot <bot@example.test>",
      ACTUATE_PAYMENT: "stripe",
      STRIPE_SECRET_KEY: "sk_test_abc",
    },
    outboundService: async (req: Request) => {
      outbound.push({ url: req.url, method: req.method, key: req.headers.get("idempotency-key") });
      if (req.url.startsWith("https://api.stripe.com/")) {
        return Response.json({ id: "cs_1", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_1", status: "open", payment_status: "unpaid", amount_total: 5000, currency: "usd", metadata: {} });
      }
      return Response.json({ id: `email_${outbound.length}` });
    },
  });
}, 60_000);

afterAll(() => mf?.dispose());

async function start(mode: string) {
  const res = await mf.dispatchFetch("https://atomic.test/run", { method: "POST", headers: auth, body: JSON.stringify({ mode }) });
  return (await res.json()) as any;
}
const getRun = async (runId: string) => (await (await mf.dispatchFetch(`https://atomic.test/runs/${runId}`, { headers: auth })).json()) as any;
const orders = async () => ((await (await mf.dispatchFetch("https://atomic.test/tables/orders", { headers: auth })).json()) as any).rows as any[];

async function settled(runId: string) {
  for (let i = 0; i < 50; i++) {
    const run = await getRun(runId);
    if (run.status !== "WAITING" && run.status !== "RUNNING") return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("run did not settle");
}

it("rolls back a batch that fails halfway, and returns each statement's rows", async () => {
  const run = await start("batch");
  expect(run.status).toBe("COMPLETED");
  expect(run.output.error).toMatch(/Statement 3 of 3 failed, so none were applied: .*CHECK constraint failed/);
  expect(run.output.sold).toEqual([[{ qty: 0 }], []]);
  expect(run.output.orders).toEqual([{ id: `${run.runId}-3` }]);
});

it("commits writes queued with commitWithStep only with the step's completion", async () => {
  const run = await start("commit");
  expect(run.status).toBe("WAITING");
  expect((await orders()).filter((o) => o.run_id === run.runId)).toEqual([]);
  const done = await settled(run.runId);
  expect(done).toMatchObject({ status: "COMPLETED", output: { orders: [{ id: run.runId }] } });
  expect(done.steps.find((s: any) => s.name === "order")).toMatchObject({ status: "COMPLETED", attempts: 2, output: 2 });
});

it("sends each provider call its own key, the same on the retry, and an explicit key as given", async () => {
  const run = await start("keys");
  expect(run.status).toBe("WAITING");
  expect((await settled(run.runId)).status).toBe("COMPLETED");
  const step = `${run.runId}:checkout`;
  const attempt = [`${step}:createBill:0`, `${step}:send:0`, `${run.runId}:reminder`];
  expect(outbound.map((c) => c.key)).toEqual([...attempt, ...attempt]);
  expect(outbound.map((c) => new URL(c.url).host)).toEqual(["api.stripe.com", "api.resend.com", "api.resend.com", "api.stripe.com", "api.resend.com", "api.resend.com"]);
});
