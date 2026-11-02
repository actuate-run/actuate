import type { Row, SqlValue } from "@actuate/sdk";

/**
 * Minimal synchronous SQLite interface. Implemented by Durable Object
 * storage (`ctx.storage.sql`) and by `node:sqlite` for tests and self-hosting.
 */
export interface SqlDriver {
  exec(sql: string, params?: readonly SqlValue[]): Row[];
  transaction<T>(fn: () => T): T;
}

/** Running totals of SQLite work, in the units Durable Objects bill (rows read and written). */
export interface SqlMeter {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
}

export function newSqlMeter(): SqlMeter {
  return { statements: 0, rowsRead: 0, rowsWritten: 0 };
}

/** Adapt a Durable Object's `ctx.storage` to {@link SqlDriver}, optionally metering billed rows. */
export function durableObjectSql(storage: DurableObjectStorage, meter?: SqlMeter): SqlDriver {
  return {
    exec: (sql, params = []) => {
      const cursor = storage.sql.exec(sql, ...params.map(toDoValue));
      const rows = cursor.toArray() as Row[];
      if (meter) {
        meter.statements++;
        meter.rowsRead += cursor.rowsRead;
        meter.rowsWritten += cursor.rowsWritten;
      }
      return rows;
    },
    transaction: (fn) => storage.transactionSync(fn),
  };
}

function toDoValue(value: SqlValue): SqlStorageValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  return value;
}

/**
 * Runtime tables. Shaped for Durable Object billing, where every row written
 * to a table or an index is charged: primary-key-only tables (WITHOUT ROWID)
 * and partial indexes that only cover rows in a waiting state.
 */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS _actuate_runs (
    run_id          TEXT PRIMARY KEY,   -- time-sortable, so the primary key orders runs
    status          TEXT NOT NULL,      -- RUNNING | WAITING | COMPLETED | FAILED | CANCELLED
    trigger_json    TEXT NOT NULL,
    input_json      TEXT NOT NULL,
    output_json     TEXT,
    error_json      TEXT,
    idempotency_key TEXT,
    wake_at         INTEGER,
    passes          INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS _actuate_runs_idem ON _actuate_runs (idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS _actuate_runs_wake ON _actuate_runs (wake_at) WHERE status = 'WAITING'`,
  `CREATE TABLE IF NOT EXISTS _actuate_steps (
    run_id      TEXT NOT NULL,
    step_name   TEXT NOT NULL,
    status      TEXT NOT NULL,          -- COMPLETED | FAILED | RUNNING | RETRYING | SLEEPING | WAITING_EVENT | WAITING_APPROVAL
    output_json TEXT,
    wake_at     INTEGER,
    event       TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    seq         INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (run_id, step_name)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS _actuate_steps_event ON _actuate_steps (event) WHERE status = 'WAITING_EVENT'`,
  `CREATE INDEX IF NOT EXISTS _actuate_steps_approval ON _actuate_steps (updated_at) WHERE status = 'WAITING_APPROVAL'`,
  `CREATE TABLE IF NOT EXISTS _actuate_events (
    id           INTEGER PRIMARY KEY,
    event        TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS _actuate_events_key ON _actuate_events (event)`,
  `CREATE TABLE IF NOT EXISTS _actuate_migrations (
    idx        INTEGER PRIMARY KEY,
    statement  TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`,
  // One row per pass holding that pass's log lines, rather than one row per line.
  `CREATE TABLE IF NOT EXISTS _actuate_logs (
    run_id     TEXT NOT NULL,
    pass       INTEGER NOT NULL,
    lines_json TEXT NOT NULL,
    PRIMARY KEY (run_id, pass)
  ) WITHOUT ROWID`,
];

export function applySchema(sql: SqlDriver): void {
  sql.transaction(() => {
    for (const statement of SCHEMA) sql.exec(statement);
  });
}
