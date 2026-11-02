/**
 * Self-host path: the public runtime on plain workerd (via Miniflare), with
 * a real SQLite-backed Durable Object and real alarms. No Cloudflare account.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
const base = "http://actuate.test";

async function call(path: string, init?: RequestInit & { json?: unknown }) {
  const res = await mf.dispatchFetch(`${base}${path}`, {
    ...init,
    ...(init?.json !== undefined ? { method: init.method ?? "POST", body: JSON.stringify(init.json), headers: { "content-type": "application/json", ...(init.headers as object) } } : {}),
  } as never);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* html or csv */
  }
  return { status: res.status, body };
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/entry.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers"],
    conditions: ["workerd", "worker", "import"],
    mainFields: ["module", "main"],
    write: false,
  });
  mf = new Miniflare({
    modules: true,
    script: out.outputFiles[0]!.text,
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ACTUATOR: { className: "ActuatorObject", useSQLite: true } },
    bindings: { ACTUATE_CONFIG: JSON.stringify({ greeting: "Hello" }), ACTUATE_TOKEN: "admin" },
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

const auth = { authorization: "Bearer admin" };

describe("self-hosted runtime on workerd", () => {
  it("describes the actuator and enforces the admin token", async () => {
    expect((await call("/")).status).toBe(401);
    const info = await call("/", { headers: auth });
    expect(info.body).toMatchObject({ name: "e2e_booking", capabilities: ["messaging"], configError: null });
    expect(info.body.input.required).toEqual(["name", "mode"]);
  });

  it("validates input before running", async () => {
    const res = await call("/run", { headers: auth, json: { name: 42 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid input");
  });

  it("waits for an event, resumes, and writes to SQLite", async () => {
    const started = await call("/run", { headers: { ...auth, "idempotency-key": "k1" }, json: { name: "Aina", mode: "payment" } });
    expect(started.status).toBe(201);
    expect(started.body.status).toBe("WAITING");
    const runId = started.body.runId;

    const again = await call("/run", { headers: { ...auth, "idempotency-key": "k1" }, json: { name: "Aina", mode: "payment" } });
    expect(again.status).toBe(200);
    expect(again.body.runId).toBe(runId);

    const ev = await call(`/events/payment.${runId}`, { headers: auth, json: { amount: 50 } });
    expect(ev.body.resumed).toEqual([runId]);

    const run = await call(`/runs/${runId}`, { headers: auth });
    expect(run.body).toMatchObject({ status: "COMPLETED", output: { status: "PAID" } });
    expect(run.body.steps.map((s: any) => s.name)).toEqual(["save", "greet", "payment", "mark"]);

    const page = await call(`/runs?before=${encodeURIComponent(runId)}`, { headers: auth });
    expect(page.body.every((r: any) => r.runId < runId)).toBe(true);

    const csv = await call("/tables/bookings?format=csv", { headers: auth });
    expect(csv.body).toContain(`${runId},Aina,PAID`);
  });

  it("wakes a sleeping run from a real Durable Object alarm", async () => {
    const started = await call("/run", { headers: auth, json: { name: "Wei", mode: "sleep" } });
    expect(started.body.status).toBe("WAITING");
    const run = await waitFor(
      () => call(`/runs/${started.body.runId}`, { headers: auth }),
      (r) => r.body.status === "COMPLETED",
    );
    expect(run.body.output).toEqual({ status: "WOKE" });
  });

  it("approval links show a page on GET and only decide on POST", async () => {
    const started = await call("/run", { headers: auth, json: { name: "Raj", mode: "approval" } });
    const runId = started.body.runId;
    const run = await call(`/runs/${runId}`, { headers: auth });
    expect(JSON.stringify(run.body.logs)).not.toContain("token="); // links never appear in run logs
    expect((await call(`/runs/${runId}/approvals/ok/links`)).status).toBe(401); // owner only
    const approveUrl: string = (await call(`/runs/${runId}/approvals/ok/links`, { headers: auth })).body.approveUrl;
    const token = new URL(approveUrl).searchParams.get("token")!;
    expect(new URL(approveUrl).origin).toBe(base);

    const page = await call(`/approve?token=${token}`);
    expect(page.body).toContain('<form method="post">');
    expect((await call(`/runs/${runId}`, { headers: auth })).body.status).toBe("WAITING");

    const res = await mf.dispatchFetch(`${base}/approve`, {
      method: "POST",
      body: new URLSearchParams({ token }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Approved");
    expect((await call(`/runs/${runId}`, { headers: auth })).body.output).toEqual({ status: "APPROVED" });

    const second = await mf.dispatchFetch(`${base}/approve`, {
      method: "POST",
      body: new URLSearchParams({ token }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(second.status).toBe(410);
  });
});
