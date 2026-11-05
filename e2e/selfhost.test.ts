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
    bindings: { ACTUATE_CONFIG: JSON.stringify({ greeting: "Hello", apiKey: "sk_e2e_secret_value" }), ACTUATE_TOKEN: "admin", ACTUATE_RUN_TOKEN: "agent", ACTUATE_WEBHOOK_SECRET: "whs_test" },
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

const auth = { authorization: "Bearer admin" };
const agentAuth = { authorization: "Bearer agent" };

describe("self-hosted runtime on workerd", () => {
  // Runs first: a stranger's Host header must not choose where approval links point.
  it("learns its public origin only from an owner request", async () => {
    for (const init of [{}, { headers: agentAuth }]) (await mf.dispatchFetch("http://attacker.example/health", init as never)).body?.cancel();
    const viaAgent = await mf.dispatchFetch("http://attacker.example/run", {
      method: "POST",
      body: JSON.stringify({ name: "Eve", mode: "approval" }),
      headers: { ...agentAuth, "content-type": "application/json" },
    });
    const runId = (await viaAgent.json<any>()).runId;
    const links = await call(`/runs/${runId}/approvals/ok/links`, { headers: auth });
    expect(new URL(links.body.approveUrl).origin).toBe(base);
    await call(`/runs/${runId}/cancel`, { headers: auth, method: "POST" });
  });

  it("describes the actuator and enforces the admin token", async () => {
    expect((await call("/")).status).toBe(401);
    const info = await call("/", { headers: auth });
    expect(info.body).toMatchObject({ name: "e2e_booking", capabilities: ["messaging"], configError: null });
    expect(info.body.input.required).toEqual(["name", "mode"]);
  });

  it("gives an agent's run token no way past its own approval", async () => {
    const started = await call("/run", { headers: agentAuth, json: { name: "Agent", mode: "approval" } });
    expect(started.status).toBe(201);
    const runId = started.body.runId;
    expect((await call("/", { headers: agentAuth })).status).toBe(200);
    expect((await call(`/runs/${runId}`, { headers: agentAuth })).body.status).toBe("WAITING");
    const refused = [
      call(`/runs/${runId}/approvals/ok/approve`, { headers: agentAuth, json: { by: "manager" } }),
      call(`/runs/${runId}/approvals/ok/links`, { headers: agentAuth }),
      call(`/runs/${runId}/inputs/ok`, { headers: agentAuth, json: { text: "yes" } }),
      call(`/runs/${runId}/cancel`, { headers: agentAuth, method: "POST" }),
      call(`/events/payment.${runId}`, { headers: agentAuth, json: { status: "paid" } }),
      call("/approvals", { headers: agentAuth }),
      call("/runs", { headers: agentAuth }),
      call("/tables", { headers: agentAuth }),
    ];
    for (const res of await Promise.all(refused)) expect(res.status).toBe(403);
    expect((await call(`/runs/${runId}`, { headers: auth })).body.status).toBe("WAITING");
    expect((await call("/run", { headers: { authorization: "Bearer nope" }, json: { name: "X", mode: "sleep" } })).status).toBe(401);
    await call(`/runs/${runId}/cancel`, { headers: auth, method: "POST" });
  });

  it("only accepts events by POST outside actuate dev", async () => {
    expect((await call("/events/payment.anything", { headers: auth })).status).toBe(404);
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
    const headers = (await mf.dispatchFetch(`${base}/approve?token=${token}`)).headers;
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
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

  it("answers a waitForInput step through the owner route", async () => {
    const started = await call("/run", { headers: auth, json: { name: "Mei", mode: "ask" } });
    expect((await call(`/runs/${started.body.runId}/inputs/why`, { json: { text: "x" } })).status).toBe(401);
    expect((await call(`/runs/${started.body.runId}/inputs/why`, { headers: auth, json: { text: "Because" } })).body.ok).toBe(true);
    expect((await call(`/runs/${started.body.runId}`, { headers: auth })).body.output).toEqual({ status: "Because" });
  });

  it("keeps secret config values out of every run read, while the run itself sees the real value", async () => {
    const secret = "sk_e2e_secret_value";
    const done = await call("/run", { headers: auth, json: { name: "Sam", mode: "leak" } });
    expect(done.body).toMatchObject({ status: "COMPLETED", output: { key: "[secret]", same: true } });
    const failed = await call("/run", { headers: agentAuth, json: { name: "fail", mode: "leak" } });
    expect(failed.body).toMatchObject({ status: "FAILED", error: { message: "refused [secret]" } });

    const reads = await Promise.all([
      call(`/runs/${done.body.runId}`, { headers: auth }),
      call(`/runs/${done.body.runId}`, { headers: agentAuth }),
      call(`/runs/${failed.body.runId}`, { headers: auth }),
      call("/runs", { headers: auth }),
    ]);
    const run = reads[0]!.body;
    expect(run.steps.find((s: { name: string }) => s.name === "read-key").output).toBe("[secret]");
    expect(run.logs.map((l: { message: string }) => l.message)).toContain("key is [secret]");
    for (const read of [done, failed, ...reads]) expect(JSON.stringify(read.body)).not.toContain(secret);
    // The config's JSON Schema marks the field, so other tools can tell it is secret.
    expect((await call("/", { headers: auth })).body.config.properties.apiKey).toMatchObject({ writeOnly: true });
  });

  it("hands ctx.notifyOwner messages to the notifier createRuntime was given, secrets redacted", async () => {
    const res = await call("/run", { headers: auth, json: { name: "Ana", mode: "notify" } });
    expect(res.body).toMatchObject({ status: "COMPLETED", output: { sent: false, reason: "Heads up / redacted / keyed" } });
    const run = await call(`/runs/${res.body.runId}`, { headers: auth });
    expect(run.body.logs).toMatchObject([{ level: "warn", message: "Owner notification not sent: Heads up / redacted / keyed" }]);
  });

  it("accepts webhooks by secret or signature, and dedupes signed replays by signature", async () => {
    const body = JSON.stringify({ name: "Hook", mode: "sleep" });
    const post = (headers: Record<string, string>, b = body) =>
      mf.dispatchFetch(`${base}/webhook`, { method: "POST", body: b, headers: { "content-type": "application/json", ...headers } });
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-actuate-secret": "nope" })).status).toBe(401);
    expect((await post({ "x-actuate-secret": "whs_test" })).status).toBe(201);

    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whs_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex");
    expect((await post({ "x-hub-signature-256": `sha256=${"0".repeat(64)}` })).status).toBe(401);
    const first = await post({ "x-hub-signature-256": `sha256=${mac}`, "x-github-delivery": "d1" });
    expect(first.status).toBe(201);
    const runId = ((await first.json()) as { runId: string }).runId;
    // Same signed body, new (unsigned) delivery ID and idempotency key: the same run, not a new one.
    const replay = await post({ "x-hub-signature-256": `sha256=${mac}`, "x-github-delivery": "d2", "idempotency-key": "other" });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { runId: string }).runId).toBe(runId);
    expect((await post({ "x-hub-signature-256": `sha256=${mac}` }, body + " ")).status).toBe(401);
  });
});
