import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineActuator, z } from "@actuate/sdk";
import { RunManager, executePass, meteredNodeSqlite, type StatementCost } from "../src/index.js";

function setup() {
  const costs: StatementCost[] = [];
  const db = new DatabaseSync(":memory:");
  const sql = meteredNodeSqlite(db, { onStatement: (c) => void costs.push(c) });
  return { db, sql, costs, last: () => costs.at(-1)! };
}

describe("meteredNodeSqlite", () => {
  // Expected values measured on workerd, whose counters are what Cloudflare bills.
  it("counts rows written and the index entries written, as Cloudflare does", () => {
    const { sql, last } = setup();
    sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT, status TEXT)");
    expect(last()).toMatchObject({ rowsWritten: 2, rowsRead: 1 });
    sql.exec("CREATE INDEX t_email ON t (email)");
    sql.exec("CREATE INDEX t_waiting ON t (status) WHERE status = 'WAITING'");
    sql.exec("INSERT INTO t (email, status) VALUES (?, 'NEW'), (?, 'NEW')", ["a@x", "b@x"]);
    expect(last()).toMatchObject({ rowsWritten: 4, rowsRead: 0 }); // 2 rows + 2 entries in t_email; neither is WAITING
    sql.exec("UPDATE t SET status = 'DONE' WHERE id = ?", [1]);
    expect(last()).toMatchObject({ rowsWritten: 1, rowsRead: 1 }); // t_email is untouched
    sql.exec("UPDATE t SET status = 'WAITING' WHERE id = ?", [2]);
    expect(last().rowsWritten).toBe(2); // the row enters t_waiting
    sql.exec("UPDATE OR IGNORE t SET email = ? WHERE id = ?", ["c@x", 1]);
    expect(last().rowsWritten).toBe(2); // and t_email changes
    sql.exec("UPDATE t SET status = 'DONE' WHERE id = ?", [2]);
    expect(last().rowsWritten).toBe(1); // leaving a partial index is free
    sql.exec("DELETE FROM t WHERE email = ?", ["b@x"]);
    expect(last()).toMatchObject({ rowsWritten: 1, rowsRead: 1 }); // removing index entries is free too
    expect(sql.meter).toMatchObject({ statements: 9, rowsWritten: 15 });
  });

  it("counts a full scan as reading the whole table, and an index search as the rows it returns", () => {
    const { sql, last } = setup();
    sql.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, total INTEGER)");
    sql.exec("CREATE INDEX orders_customer ON orders (customer)");
    expect(last()).toMatchObject({ rowsRead: 2, rowsWritten: 1 });
    sql.exec("INSERT INTO orders (customer, total) SELECT 'c' || (value % 10), value FROM json_each(?)", [JSON.stringify([...Array(100).keys()])]);
    expect(last().rowsWritten).toBe(200);

    expect(sql.exec("SELECT id FROM orders WHERE customer = ?", ["c1"])).toHaveLength(10);
    expect(last().rowsRead).toBe(10);
    sql.exec("SELECT id FROM orders o WHERE o.total > ?", [50]);
    expect(last().rowsRead).toBe(100);
    sql.exec("SELECT count(*) AS n FROM orders");
    expect(last().rowsRead).toBe(100);
    sql.exec("SELECT 1");
    expect(last()).toMatchObject({ rowsRead: 0, rowsWritten: 0 });
  });

  it("re-plans after a migration adds an index", () => {
    const { sql, last } = setup();
    sql.exec("CREATE TABLE t (k TEXT, v TEXT)");
    sql.exec("INSERT INTO t VALUES ('a', '1'), ('b', '2'), ('c', '3')");
    sql.exec("SELECT v FROM t WHERE k = ?", ["a"]);
    expect(last().rowsRead).toBe(3);
    sql.exec("CREATE INDEX t_k ON t (k)");
    sql.exec("SELECT v FROM t WHERE k = ?", ["a"]);
    expect(last().rowsRead).toBe(1);
  });

  it("meters a whole run, journal included, close to the platform's measured shapes", async () => {
    const now = Date.parse("2026-11-02T00:00:00Z");
    const actuator = defineActuator({
      name: "one_step",
      description: "test",
      input: z.object({}),
      async run(ctx) {
        return ctx.step.do("a", () => 1);
      },
    });
    const sql = meteredNodeSqlite(new DatabaseSync(":memory:"));
    const manager = new RunManager({
      sql,
      approvalSecret: "s",
      approvalUrl: "https://x.test/approve",
      now: () => now,
      consoleLogs: false,
      invoke: (request, journal) => executePass(actuator, request, { journal, config: {} }),
    });
    const before = { ...sql.meter };
    const { run } = await manager.start({ input: {}, trigger: { kind: "api" } });
    expect(run.status).toBe("COMPLETED");
    // The run row, the step row and the settle: the platform measures 4 (it also records the version).
    expect(sql.meter.rowsWritten - before.rowsWritten).toBe(3);
    expect(sql.meter.rowsRead - before.rowsRead).toBeLessThan(10);
  });
});
