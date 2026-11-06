import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ActuatorError, defineActuator, z, type Actuator } from "@actuate/sdk";
import {
  INPUT_KEY_COMPLETED_TTL_MS,
  RunManager,
  deriveInputKey,
  derivesInputKey,
  executePass,
  inputKeyMaterial,
  nodeSqlite,
} from "../src/index.js";

const HOUR = 3_600_000;

function harness(actuator: Actuator, opts: { db?: DatabaseSync } = {}) {
  let now = Date.parse("2026-11-02T00:00:00Z");
  const db = opts.db ?? new DatabaseSync(":memory:");
  const manager = new RunManager({
    sql: nodeSqlite(db),
    approvalSecret: "test-secret",
    approvalUrl: "https://example.test/approve",
    now: () => now,
    consoleLogs: false,
    invoke: (request, journal) => executePass(actuator, request, { journal, config: {} }),
  });
  return {
    manager,
    db,
    advance: async (ms: number) => {
      now += ms;
      await manager.alarm();
    },
    /** Starts as the run API does: the caller's key if any, else the derived one. */
    start: async (input: Record<string, unknown>, idempotencyKey?: string) =>
      manager.start({
        input: input as never,
        trigger: { kind: "api" },
        ...(idempotencyKey ? { idempotencyKey } : { inputKey: (await deriveInputKey(actuator.idempotencyKey, input))! }),
      }),
  };
}

describe("idempotencyKey in defineActuator", () => {
  const def = (input: z.ZodType, idempotencyKey: readonly string[]) => () =>
    defineActuator({ name: "keyed", description: "test", input, idempotencyKey, run: () => null });

  it("accepts top-level scalar fields, wrapped or not", () => {
    const input = z.object({
      orderId: z.string(),
      n: z.number(),
      i: z.int(),
      ok: z.boolean(),
      kind: z.enum(["a", "b"]),
      v: z.literal(3),
      email: z.email(),
      trimmed: z.string().transform((s) => s.trim()),
      later: z.string().optional(),
      dflt: z.number().default(1),
    });
    expect(def(input, ["orderId", "n", "i", "ok", "kind", "v", "email", "trimmed", "later", "dflt"])).not.toThrow();
    expect(defineActuator({ name: "k", description: "t", input, idempotencyKey: ["orderId"], run: () => null }).idempotencyKey).toEqual(["orderId"]);
  });

  it("refuses fields that are not top-level scalars, and empty or repeated lists", () => {
    const input = z.object({ id: z.string(), items: z.array(z.string()), meta: z.object({ id: z.string() }), maybe: z.string().nullable(), when: z.date() });
    expect(def(input, ["missing"])).toThrow(new ActuatorError('Actuator "keyed": idempotencyKey: "missing" is not a top-level field of the input schema.'));
    expect(def(input, ["meta.id"])).toThrow(/"meta.id" is not a top-level field/);
    expect(def(input, ["items"])).toThrow('Actuator "keyed": idempotencyKey: "items" must be a string, number, integer or boolean field (it is an array).');
    expect(def(input, ["meta"])).toThrow(/"meta" must be a string, number, integer or boolean field \(it is an object\)/);
    expect(def(input, ["maybe"])).toThrow(/it is a nullable/);
    expect(def(input, ["when"])).toThrow(/it is a date/);
    expect(def(input, [])).toThrow(/idempotencyKey lists no fields/);
    expect(def(input, ["id", "id"])).toThrow(/lists "id" twice/);
    expect(def(z.string(), ["id"])).toThrow(/needs an object input schema/);
    expect(def(input, ["toString"])).toThrow(/is not a top-level field/);
  });
});

describe("deriveInputKey", () => {
  it("hashes the declared fields' values in declared order, whatever the input's key order", async () => {
    const a = await deriveInputKey(["orderId", "amount"], { orderId: "A-1", amount: 20, note: "x" });
    expect(a).toMatch(/^input:[0-9a-f]{64}$/);
    expect(await deriveInputKey(["orderId", "amount"], { note: "y", amount: 20, orderId: "A-1" })).toBe(a);
    expect(await deriveInputKey(["orderId", "amount"], { orderId: "A-1", amount: 21 })).not.toBe(a);
    expect(await deriveInputKey(["orderId", "amount"], { orderId: "a-1", amount: 20 })).not.toBe(a);
    expect(await deriveInputKey(["amount", "orderId"], { orderId: "A-1", amount: 20 })).not.toBe(a);
    // Types count: "20" is not 20.
    expect(await deriveInputKey(["orderId", "amount"], { orderId: "A-1", amount: "20" })).not.toBe(a);
    expect(inputKeyMaterial(["orderId", "amount", "gone"], { amount: 20, orderId: "A-1" })).toBe('["A-1",20,null]');
    // The hash of that text, so any host can compute it.
    const { createHash } = await import("node:crypto");
    expect(a).toBe(`input:${createHash("sha256").update('["A-1",20]').digest("hex")}`);
  });

  it("is undefined without fields, and applies only to MCP and run API calls", async () => {
    expect(await deriveInputKey(undefined, { a: 1 })).toBeUndefined();
    expect(await deriveInputKey([], { a: 1 })).toBeUndefined();
    expect(["mcp", "api", "cron", "webhook", "manual"].filter((k) => derivesInputKey(k as never))).toEqual(["mcp", "api"]);
  });
});

describe("RunManager.start with a derived key", () => {
  let n = 0;
  const keyed = defineActuator({
    name: "keyed",
    description: "test",
    input: z.object({ orderId: z.string(), mode: z.enum(["done", "wait", "fail"]).default("done") }),
    idempotencyKey: ["orderId"],
    async run(ctx, input) {
      const count = await ctx.step.do("count", () => ++n);
      if (input.mode === "fail") throw new Error("boom");
      if (input.mode === "wait") await ctx.step.waitForEvent("go", { event: `go.${input.orderId}` });
      return count;
    },
  });

  it("returns a running or waiting run, and a run completed in the last 24 hours", async () => {
    const h = harness(keyed);
    const waiting = await h.start({ orderId: "W", mode: "wait" });
    expect(waiting).toMatchObject({ created: true, run: { status: "WAITING" } });
    // Other fields may differ: only orderId is the key.
    const again = await h.start({ orderId: "W", mode: "done" });
    expect(again).toMatchObject({ created: false, run: { runId: waiting.run.runId, status: "WAITING" } });

    const done = await h.start({ orderId: "C" });
    expect(done.run.status).toBe("COMPLETED");
    await h.advance(INPUT_KEY_COMPLETED_TTL_MS - 1);
    expect(await h.start({ orderId: "C" })).toMatchObject({ created: false, run: { runId: done.run.runId } });
    // Still waiting a day later: waiting runs always match.
    expect((await h.start({ orderId: "W" })).run.runId).toBe(waiting.run.runId);
  });

  it("starts a new run once the completed one is over 24 hours old, and takes the key over", async () => {
    const h = harness(keyed);
    const first = await h.start({ orderId: "C" });
    await h.advance(INPUT_KEY_COMPLETED_TTL_MS + 1);
    const second = await h.start({ orderId: "C" });
    expect(second.created).toBe(true);
    expect(second.run.runId).not.toBe(first.run.runId);
    const keys = h.db.prepare("SELECT run_id, input_key FROM _actuate_runs ORDER BY created_at").all() as Array<{ run_id: string; input_key: string | null }>;
    expect(keys.map((k) => [k.run_id, k.input_key])).toEqual([
      [first.run.runId, null],
      [second.run.runId, await deriveInputKey(["orderId"], { orderId: "C" })],
    ]);
    expect((await h.start({ orderId: "C" })).run.runId).toBe(second.run.runId);
  });

  it("never matches failed or cancelled runs, so the call can be tried again", async () => {
    const h = harness(keyed);
    const failed = await h.start({ orderId: "F", mode: "fail" });
    expect(failed.run.status).toBe("FAILED");
    const retry = await h.start({ orderId: "F", mode: "done" });
    expect(retry).toMatchObject({ created: true, run: { status: "COMPLETED" } });

    const waiting = await h.start({ orderId: "X", mode: "wait" });
    expect(h.manager.cancel(waiting.run.runId)).toBe(true);
    const after = await h.start({ orderId: "X", mode: "done" });
    expect(after.created).toBe(true);
    expect(after.run.runId).not.toBe(waiting.run.runId);
    expect(h.manager.getRun(failed.run.runId)!.status).toBe("FAILED");
  });

  it("leaves explicit keys as they were: they match at any status, and the derived key is not used", async () => {
    const h = harness(keyed);
    const failed = await h.start({ orderId: "E", mode: "fail" }, "k-1");
    expect(await h.start({ orderId: "E", mode: "done" }, "k-1")).toMatchObject({ created: false, run: { runId: failed.run.runId, status: "FAILED" } });
    // A new explicit key forces a new run, even while a derived key for the same fields would match.
    const derived = await h.start({ orderId: "D" });
    const forced = await h.start({ orderId: "D" }, "k-2");
    expect(forced.created).toBe(true);
    expect(forced.run.runId).not.toBe(derived.run.runId);
    await h.advance(30 * 86_400_000);
    expect((await h.start({ orderId: "D" }, "k-2")).run.runId).toBe(forced.run.runId);
  });

  it("checks both keys when both are given: the explicit one first", async () => {
    const h = harness(keyed);
    const inputKey = (await deriveInputKey(["orderId"], { orderId: "B" }))!;
    const start = (idempotencyKey: string) => h.manager.start({ input: { orderId: "B" }, trigger: { kind: "mcp" }, idempotencyKey, inputKey });
    const first = await start("mcp:sess:1");
    // A retry with a new JSON-RPC id (a new session key) still finds the run by its derived key.
    expect(await start("mcp:sess:2")).toMatchObject({ created: false, run: { runId: first.run.runId } });
    await h.advance(INPUT_KEY_COMPLETED_TTL_MS + 1);
    // The session key matches at any age; the derived key alone no longer does.
    expect((await start("mcp:sess:1")).run.runId).toBe(first.run.runId);
    expect((await start("mcp:sess:3")).created).toBe(true);
  });

  it("makes a concurrent duplicate wait for the first call's pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow = defineActuator({
      name: "slow",
      description: "test",
      input: z.object({ orderId: z.string() }),
      idempotencyKey: ["orderId"],
      async run(ctx) {
        return ctx.step.do("work", async () => (await gate, ++calls));
      },
    });
    const h = harness(slow);
    const a = h.start({ orderId: "S" });
    const b = h.start({ orderId: "S" });
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, run: { runId: first.run.runId, status: "COMPLETED", output: 1 } });
    expect(calls).toBe(1);
  });
});

describe("databases created before 0.5.0", () => {
  it("get the input_key column and its index, and keep their runs", async () => {
    const db = new DatabaseSync(":memory:");
    // _actuate_runs as 0.4.x created it.
    db.exec(`CREATE TABLE _actuate_runs (
      run_id TEXT PRIMARY KEY, status TEXT NOT NULL, trigger_json TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT,
      error_json TEXT, idempotency_key TEXT, wake_at INTEGER, passes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
    db.exec(`CREATE UNIQUE INDEX _actuate_runs_idem ON _actuate_runs (idempotency_key) WHERE idempotency_key IS NOT NULL`);
    const t = Date.parse("2026-11-01T23:00:00Z");
    db.prepare(`INSERT INTO _actuate_runs VALUES ('run_old', 'COMPLETED', '{"kind":"api"}', '{"orderId":"O"}', '1', NULL, 'old-key', NULL, 1, ?, ?)`).run(t, t);

    const act = defineActuator({ name: "m", description: "t", input: z.object({ orderId: z.string() }), idempotencyKey: ["orderId"], run: () => 2 });
    const h = harness(act, { db });
    const columns = (db.prepare(`SELECT name FROM pragma_table_info('_actuate_runs')`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("input_key");
    const index = db.prepare(`SELECT sql FROM sqlite_master WHERE name = '_actuate_runs_input'`).get() as { sql: string };
    expect(index.sql).toContain("UNIQUE INDEX");
    expect(h.manager.getRun("run_old")).toMatchObject({ status: "COMPLETED", output: 1, idempotencyKey: "old-key" });

    // The old run has no derived key, so it doesn't match; the old explicit key still does.
    const fresh = await h.start({ orderId: "O" });
    expect(fresh.created).toBe(true);
    expect((await h.start({ orderId: "O" })).run.runId).toBe(fresh.run.runId);
    expect((await h.start({ orderId: "O" }, "old-key")).run.runId).toBe("run_old");

    // Opening it again changes nothing.
    harness(act, { db });
    const again = (db.prepare(`SELECT name FROM pragma_table_info('_actuate_runs')`).all() as Array<{ name: string }>).filter((c) => c.name === "input_key");
    expect(again).toHaveLength(1);
  });
});
