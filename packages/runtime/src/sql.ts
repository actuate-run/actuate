import type { Row, SqlValue } from "@actuate/sdk";

/**
 * Minimal synchronous SQLite interface. Implemented by Durable Object
 * storage (`ctx.storage.sql`) and by `node:sqlite` for tests and self-hosting.
 */
export interface SqlDriver {
  exec(sql: string, params?: readonly SqlValue[]): Row[];
  transaction<T>(fn: () => T): T;
}

/** Adapt a Durable Object's `ctx.storage` to {@link SqlDriver}. */
export function durableObjectSql(storage: DurableObjectStorage): SqlDriver {
  return {
    exec: (sql, params = []) => storage.sql.exec(sql, ...params.map(toDoValue)).toArray() as Row[],
    transaction: (fn) => storage.transactionSync(fn),
  };
}

function toDoValue(value: SqlValue): SqlStorageValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  return value;
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS _actuate_runs (
    run_id          TEXT PRIMARY KEY,
    status          TEXT NOT NULL,      -- RUNNING | WAITING | COMPLETED | FAILED | CANCELLED
    trigger_json    TEXT NOT NULL,
    input_json      TEXT NOT NULL,
    output_json     TEXT,
    error_json      TEXT,
    idempotency_key TEXT UNIQUE,
    wake_at         INTEGER,
    passes          INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS _actuate_runs_wake ON _actuate_runs (status, wake_at)`,
  `CREATE INDEX IF NOT EXISTS _actuate_runs_created ON _actuate_runs (created_at)`,
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
  )`,
  `CREATE INDEX IF NOT EXISTS _actuate_steps_event ON _actuate_steps (event, status)`,
  `CREATE TABLE IF NOT EXISTS _actuate_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event        TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS _actuate_events_key ON _actuate_events (event, id)`,
  `CREATE TABLE IF NOT EXISTS _actuate_migrations (
    idx        INTEGER PRIMARY KEY,
    statement  TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _actuate_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id    TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    level     TEXT NOT NULL,
    message   TEXT NOT NULL,
    data_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS _actuate_logs_run ON _actuate_logs (run_id, id)`,
];

export function applySchema(sql: SqlDriver): void {
  sql.transaction(() => {
    for (const statement of SCHEMA) sql.exec(statement);
  });
}
