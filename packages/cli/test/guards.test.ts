import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineActuator, z, type Actuator, type Providers } from "@actuate/sdk";
import { RunManager, createHttpProvider, executePass, meteredNodeSqlite } from "@actuate/runtime";
import { withPlatformGuards, type GuardOptions } from "../src/guards.js";
import { UsageTracker } from "../src/usage.js";

/** A bare engine with guards, to try limits smaller than the platform's. */
function engine(actuator: Actuator, options: GuardOptions = {}, providers: Partial<Providers> = {}) {
  const usage = new UsageTracker();
  const tripped: string[] = [];
  const guarded = withPlatformGuards(actuator, { usage, onTrip: (m) => void tripped.push(m), ...options });
  const manager = new RunManager({
    sql: meteredNodeSqlite(new DatabaseSync(":memory:"), { onStatement: (c) => usage.record(c.params, c) }),
    approvalSecret: "s",
    approvalUrl: "https://x.test/approve",
    consoleLogs: false,
    invoke: (request, journal) => executePass(guarded, request, { journal, config: {}, providers }),
  });
  return { manager, usage, tripped, start: async () => (await manager.start({ input: {}, trigger: { kind: "api" } })).run };
}

describe("withPlatformGuards", () => {
  it("caps ctx.http requests per pass; the step sees the error and may retry, as on the platform", async () => {
    let calls = 0;
    const act = defineActuator({
      name: "crawler",
      description: "test",
      input: z.object({}),
      capabilities: ["http"],
      http: { allow: ["api.example.com"] },
      async run(ctx) {
        return ctx.step.do("crawl", async () => {
          for (let i = 0; i < 3; i++) await ctx.http.fetch("https://api.example.com/");
          return "done";
        });
      },
    });
    const http = createHttpProvider({ allow: ["api.example.com"], fetch: async () => (calls++, new Response("ok")) });
    const e = engine(act, { limits: { httpRequests: 2 } }, { http });
    const run = await e.start();
    expect(e.manager.getRun(run.runId)?.error?.message).toBe("A single pass may make at most 2 HTTP requests.");
    expect(calls).toBe(2);
    expect(e.tripped).toEqual(["A single pass may make at most 2 HTTP requests."]);
  });

  it("caps rows written per pass, measured per run", async () => {
    const act = defineActuator({
      name: "bulk",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        await ctx.db.migrate(["CREATE TABLE t (n INTEGER)"]);
        await ctx.step.do("fill", () => ctx.db.query("INSERT INTO t SELECT value FROM json_each(?)", [JSON.stringify([...Array(50).keys()])]));
      },
    });
    const e = engine(act, { limits: { rowsWritten: 40 } });
    const run = await e.start();
    expect(e.manager.getRun(run.runId)?.error?.message).toBe("A single pass may write at most 40 rows.");
    expect(e.usage.of(run.runId).rowsWritten).toBeGreaterThan(50);
  });

  it("caps steps per pass and ends the pass after its wall time", async () => {
    const many = defineActuator({
      name: "many",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        for (let i = 0; i < 5; i++) await ctx.step.do(`s${i}`, () => i);
      },
    });
    const e = engine(many, { limits: { stepWrites: 3 } });
    expect(e.manager.getRun((await e.start()).runId)?.error?.message).toBe("A single pass may record at most 3 steps.");

    let afterTimeout: unknown;
    const slow = defineActuator({
      name: "slow",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        await new Promise((r) => setTimeout(r, 60));
        afterTimeout = await ctx.db.query("SELECT 1").catch((err: Error) => err.message);
      },
    });
    const s = engine(slow, { limits: { wallMs: 20 } });
    expect(s.manager.getRun((await s.start()).runId)?.error?.message).toBe("A single pass may take at most 0.02s.");
    await new Promise((r) => setTimeout(r, 80));
    expect(afterTimeout).toBe("This pass has ended.");
  });

  it("enforces nothing with enforce: false, but still attributes rows to the run", async () => {
    const act = defineActuator({
      name: "pragma",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        await ctx.db.migrate(["CREATE TABLE t (n INTEGER)"]);
        await ctx.step.do("w", () => ctx.db.query("INSERT INTO t VALUES (1), (2), (3)"));
        return (await ctx.db.query("PRAGMA table_info(t)")).length;
      },
    });
    const e = engine(act, { enforce: false });
    const run = await e.start();
    expect(e.manager.getRun(run.runId)?.output).toBe(1);
    // The migration and the insert carry no run ID; they are counted because ctx.db made them.
    expect(e.usage.of(run.runId).rowsWritten).toBeGreaterThanOrEqual(3 + 2 + 3);
  });
});

describe("UsageTracker", () => {
  it("attributes by run ID parameter, by ctx.db, or to no run; and can pause", () => {
    const u = new UsageTracker();
    const id = "run_0190f3c2a1b20123456789abcdef";
    u.record([id, "x"], { rowsRead: 2, rowsWritten: 1 });
    u.attribute(id, () => u.record([], { rowsRead: 1, rowsWritten: 1 }));
    u.record(["payment.x"], { rowsRead: 5, rowsWritten: 0 });
    u.paused++;
    u.record([id], { rowsRead: 100, rowsWritten: 100 });
    expect(u.of(id)).toEqual({ statements: 2, rowsRead: 3, rowsWritten: 2 });
    expect(u.other).toEqual({ statements: 1, rowsRead: 5, rowsWritten: 0 });
    const copy = new UsageTracker();
    copy.load(JSON.parse(JSON.stringify(u)));
    expect(copy.of(id)).toEqual(u.of(id));
  });
});
