import type { Row, SqlValue } from "@actuate/sdk";
import type { SqlDriver } from "./sql.js";

/** Minimal shape of `node:sqlite`'s DatabaseSync, so this file has no Node type dependency at runtime. */
interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
}

/** Adapt a `node:sqlite` DatabaseSync to {@link SqlDriver}. For tests and Node self-hosting. */
export function nodeSqlite(db: DatabaseSyncLike): SqlDriver {
  let depth = 0;
  return {
    exec(sql: string, params: readonly SqlValue[] = []) {
      const stmt = db.prepare(sql);
      const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p instanceof ArrayBuffer ? new Uint8Array(p) : p));
      try {
        return stmt.all(...bound) as Row[];
      } catch (err) {
        // Statements that return no rows (DDL) are fine with run().
        if (err instanceof Error && /does not return/.test(err.message)) {
          stmt.run(...bound);
          return [];
        }
        throw err;
      }
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
  };
}
