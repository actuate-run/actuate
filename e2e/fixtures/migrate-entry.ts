/** A Durable Object holding a 0.4.x `_actuate_runs` table, opened by the 0.5.0 RunManager. */
import { DurableObject } from "cloudflare:workers";
import { RunManager, deriveInputKey, durableObjectSql, executePass } from "@actuate/runtime";
import actuator from "./keyed.js";

export class OldObject extends DurableObject {
  async fetch(): Promise<Response> {
    const s = this.ctx.storage.sql;
    s.exec(`CREATE TABLE _actuate_runs (
      run_id TEXT PRIMARY KEY, status TEXT NOT NULL, trigger_json TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT,
      error_json TEXT, idempotency_key TEXT, wake_at INTEGER, passes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
    s.exec(`CREATE UNIQUE INDEX _actuate_runs_idem ON _actuate_runs (idempotency_key) WHERE idempotency_key IS NOT NULL`);
    const now = Date.now();
    s.exec(`INSERT INTO _actuate_runs VALUES ('run_old', 'COMPLETED', '{"kind":"api"}', '{"orderId":"O-1"}', '{"trigger":"api"}', NULL, 'old-key', NULL, 1, ?, ?)`, now, now);

    const open = () =>
      new RunManager({
        sql: durableObjectSql(this.ctx.storage),
        approvalSecret: "s",
        approvalUrl: "https://x.test/approve",
        consoleLogs: false,
        invoke: (request, journal) => executePass(actuator, request, { journal, config: {} }),
      });
    const manager = open();
    open(); // opening it again changes nothing
    const columns = s.exec(`SELECT name FROM pragma_table_info('_actuate_runs')`).toArray().map((r) => r.name);
    const index = s.exec(`SELECT sql FROM sqlite_master WHERE name = '_actuate_runs_input'`).toArray()[0]?.sql ?? null;
    const old = manager.getRun("run_old");
    const inputKey = await deriveInputKey(actuator.idempotencyKey, { orderId: "O-1" });
    const first = await manager.start({ input: { orderId: "O-1", mode: "done" }, trigger: { kind: "api" }, ...(inputKey ? { inputKey } : {}) });
    const second = await manager.start({ input: { orderId: "O-1", mode: "done" }, trigger: { kind: "api" }, ...(inputKey ? { inputKey } : {}) });
    const explicit = await manager.start({ input: { orderId: "O-1" }, trigger: { kind: "api" }, idempotencyKey: "old-key" });
    return Response.json({
      columns,
      index,
      old: old && { status: old.status, idempotencyKey: old.idempotencyKey },
      first: { created: first.created, status: first.run.status },
      sameRun: second.run.runId === first.run.runId && !second.created,
      explicit: explicit.run.runId,
    });
  }
}

export default {
  fetch(request: Request, env: { OLD: DurableObjectNamespace }) {
    return env.OLD.get(env.OLD.idFromName("x")).fetch(request);
  },
};
