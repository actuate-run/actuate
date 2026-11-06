/**
 * The self-hosted runtime on workerd: run keys derived from `idempotencyKey` on POST /run (and nowhere else).
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const base = "http://keyed.test";
const auth = { authorization: "Bearer admin" };
let script: string;
let mf: Miniflare;

const worker = (bindings: Record<string, string>) =>
  new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ACTUATOR: { className: "ActuatorObject", useSQLite: true } },
    bindings: { ACTUATE_TOKEN: "admin", ACTUATE_WEBHOOK_SECRET: "whs_test", ACTUATE_PUBLIC_URL: base, ...bindings },
  });

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/keyed-entry.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"],
    conditions: ["workerd", "worker", "import"], mainFields: ["module", "main"], write: false,
  });
  script = out.outputFiles[0]!.text;
  mf = worker({});
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

async function post(path: string, body: unknown, headers: Record<string, string> = auth, on = mf) {
  const res = await on.dispatchFetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, body: (await res.json()) as any };
}

describe("run keys from idempotencyKey on the self-hosted runtime", () => {
  it("returns the first run for a repeated POST /run with the same key fields", async () => {
    const first = await post("/run", { orderId: "A-1" });
    expect(first).toMatchObject({ status: 201, body: { status: "COMPLETED", output: { trigger: "api" } } });
    // Field order and other fields make no difference.
    const again = await post("/run", { note: "retry", orderId: "A-1" });
    expect(again).toMatchObject({ status: 200, body: { runId: first.body.runId } });
    expect((await post("/run", { orderId: "A-2" })).status).toBe(201);
    // The key is the raw input's: zod's default for mode is not part of it, and orderId alone decides.
    expect((await post("/run", { orderId: "A-1", mode: "done" })).body.runId).toBe(first.body.runId);
  });

  it("lets an Idempotency-Key header take over, as before", async () => {
    const derived = await post("/run", { orderId: "B-1" });
    const forced = await post("/run", { orderId: "B-1" }, { ...auth, "idempotency-key": "force-1" });
    expect(forced.status).toBe(201);
    expect(forced.body.runId).not.toBe(derived.body.runId);
    expect((await post("/run", { orderId: "B-1" }, { ...auth, "idempotency-key": "force-1" })).body.runId).toBe(forced.body.runId);
  });

  it("never blocks a retry after a failed run", async () => {
    const failed = await post("/run", { orderId: "F-1", mode: "fail" });
    expect(failed.body.status).toBe("FAILED");
    const retry = await post("/run", { orderId: "F-1" });
    expect(retry).toMatchObject({ status: 201, body: { status: "COMPLETED" } });
  });

  it("never derives a key for webhooks", async () => {
    const hook = { "x-actuate-secret": "whs_test" };
    const a = await post("/webhook", { orderId: "W-1" }, hook);
    const b = await post("/webhook", { orderId: "W-1" }, hook);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.runId).not.toBe(b.body.runId);
    expect(a.body.output).toEqual({ trigger: "webhook" });
  });
});
