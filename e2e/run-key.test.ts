/**
 * The self-hosted runtime on workerd: run keys derived from `idempotencyKey` on POST /run (and nowhere else),
 * and `notify: "owner"` approvals handed to the createRuntime notifier, or printed when there is none.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const base = "http://keyed.test";
const auth = { authorization: "Bearer admin" };
let script: string;
let mf: Miniflare;
let bare: Miniflare;

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
  bare = worker({ NO_OWNER: "1" });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  await bare?.dispose();
});

async function post(path: string, body: unknown, headers: Record<string, string> = auth, on = mf) {
  const res = await on.dispatchFetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, body: (await res.json()) as any };
}
const get = async (path: string, on = mf) => (await (await on.dispatchFetch(`${base}${path}`, { headers: auth })).json()) as any;

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

describe('notify: "owner" on the self-hosted runtime', () => {
  it("hands the approval to the createRuntime notifier, with the message and both links, keyed per step", async () => {
    const started = await post("/run", { orderId: "O-1", mode: "approve" });
    expect(started.body.status).toBe("WAITING");
    const run = await get(`/runs/${started.body.runId}`);
    // The notifier refused it (by design here), so its reason is a warning; the links never reach the log.
    expect(run.logs.at(-1)).toMatchObject({ level: "warn", message: 'Approval links for "ok" not sent: Approval needed: e2e_keyed / message / links / keyed' });
    expect(JSON.stringify(run.logs)).not.toContain("token=");
    // The approval still waits in the queue and can be decided.
    expect(await get("/approvals")).toMatchObject([{ runId: started.body.runId, step: "ok", kind: "approval" }]);
    expect((await post(`/runs/${started.body.runId}/approvals/ok/approve`, {})).body.ok).toBe(true);
    expect((await get(`/runs/${started.body.runId}`)).output).toEqual({ approved: true });
  });

  it('gives a question the subject "Input needed"', async () => {
    const started = await post("/run", { orderId: "O-3", mode: "ask" });
    expect(started.body.status).toBe("WAITING");
    const run = await get(`/runs/${started.body.runId}`);
    expect(run.logs.at(-1)).toMatchObject({ level: "warn", message: expect.stringMatching(/^Input link for "ok" not sent: Input needed: e2e_keyed \/ message \/ no links \/ keyed$/) });
  });

  it("prints the links to the console when no notifier is configured, and says so on the run", async () => {
    const started = await post("/run", { orderId: "O-2", mode: "approve" }, auth, bare);
    expect(started.body.status).toBe("WAITING");
    const run = await get(`/runs/${started.body.runId}`, bare);
    expect(run.logs.at(-1)).toMatchObject({ level: "warn", message: expect.stringContaining('Approval links for "ok" not sent: no owner notifier is configured') });
    expect(JSON.stringify(run.logs)).not.toContain("token=");
  });
});
