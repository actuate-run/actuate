import { describe, expect, it } from "vitest";
import { checkActuatorSql, tokenizeSql } from "../src/index.js";

const refusal = (sql: string, params: unknown[] = []) => {
  try {
    checkActuatorSql(sql, params as never);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

describe("checkActuatorSql", () => {
  it("allows ordinary statements, CTEs that don't refer to themselves, and comment markers inside strings", () => {
    for (const sql of [
      "SELECT * FROM orders WHERE id = ?",
      "INSERT INTO t SELECT value FROM json_each(?)",
      "WITH recent AS (SELECT * FROM orders LIMIT 10) SELECT * FROM recent",
      "WITH a AS NOT MATERIALIZED (SELECT 1), b(x) AS (SELECT * FROM a) SELECT * FROM b",
      "SELECT '-- not a comment', '/* nor this' FROM t",
      "UPDATE settings SET pragma_value = 1",
    ]) {
      expect(refusal(sql), sql).toBeNull();
    }
  });

  it("refuses what the hosted platform refuses, with its messages", () => {
    expect(refusal("PRAGMA table_info(t)")).toBe("PRAGMA, ATTACH, DETACH, VACUUM and REINDEX are not allowed.");
    expect(refusal("EXPLAIN QUERY PLAN ATTACH 'x' AS y")).toMatch(/PRAGMA, ATTACH/);
    expect(refusal("SELECT 1; vacuum")).toMatch(/VACUUM/);
    expect(refusal("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT * FROM n")).toBe("Recursive queries are not allowed.");
    expect(refusal("WITH n AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT * FROM n")).toBe("Recursive queries are not allowed.");
    expect(refusal("WITH 'n' AS (SELECT * FROM \"n\") SELECT 1")).toBe("Recursive queries are not allowed.");
    expect(refusal("WITH oops SELECT 1")).toMatch(/Could not check this WITH clause/);
    expect(refusal("SELECT randomblob(1000000000)")).toBe("That SQL function is not allowed.");
    expect(refusal("SELECT PrInTf ('%s', x) FROM t")).toBe("That SQL function is not allowed.");
    expect(refusal("SELECT * FROM _actuate_runs")).toBe("Tables starting with _actuate_, _cf_ or sqlite_ are reserved.");
    expect(refusal("SELECT * FROM [sqlite_master]")).toMatch(/reserved/);
    expect(refusal("SELECT 1 /* hide */ ; PRAGMA x")).toMatch(/PRAGMA/);
    expect(refusal("SELECT ?", ["x".repeat(400_000)])).toBe("Bound parameters may total at most 1024 KiB per statement.");
    expect(refusal("x".repeat(100_001))).toMatch(/at most 100,000 characters/);
  });

  it("tokenizes like SQLite: quotes, doubled quotes and comments", () => {
    expect(tokenizeSql(`SELECT "a""b", 'it''s' -- c\n/* d */ FROM [T]`)).toEqual([
      { kind: "ident", text: "select" },
      { kind: "quoted", text: 'a"b' },
      { kind: "punct", text: "," },
      { kind: "string", text: "it's" },
      { kind: "ident", text: "from" },
      { kind: "quoted", text: "t" },
    ]);
  });
});
