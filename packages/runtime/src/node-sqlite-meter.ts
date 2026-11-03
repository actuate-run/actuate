import type { Row, SqlValue } from "@actuate/sdk";
import { nodeSqlite } from "./node-sqlite.js";
import { newSqlMeter, type SqlDriver, type SqlMeter } from "./sql.js";
import { tokenizeSql, type SqlToken } from "./sql-guard.js";

/** The part of `node:sqlite`'s DatabaseSync the meter uses. */
interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
}

/** What one statement cost, in the units Durable Objects bill. */
export interface StatementCost {
  sql: string;
  params: readonly SqlValue[];
  rowsRead: number;
  rowsWritten: number;
}

export interface MeteredNodeSqliteOptions {
  /** Totals to add to. Default: a new meter, returned as `driver.meter`. */
  meter?: SqlMeter;
  /** Called after every statement with its cost, e.g. to attribute rows to runs. */
  onStatement?: (cost: StatementCost) => void;
}

/**
 * {@link nodeSqlite} with a rows meter, for tests and Node hosts that want to
 * see what an actuator would cost on Durable Objects. `node:sqlite` has no row
 * counters, so the counts are estimates, close to what Cloudflare bills:
 *
 * - **Rows written**: rows inserted, updated or deleted (SQLite's change
 *   count), plus the index entries written, the way Cloudflare counts them:
 *   every index for an insert, the indexes on the columns an UPDATE sets, and
 *   rows entering a partial index (removing an index entry is free). A
 *   migration counts its schema rows. Matches Cloudflare's count for the
 *   runtime's own journal.
 * - **Rows read**: for every table the query plan scans in full
 *   (`SCAN <table>`), the table's row count, as Cloudflare counts it; for an
 *   index search, the rows the statement returned or changed, which is low
 *   when the search visits rows a further condition then drops, or feeds an
 *   aggregate. Full scans are what use up a rows-read budget, and those are
 *   counted in full (a scan that stops at a LIMIT still counts the table).
 *
 * The meter's own bookkeeping queries are not counted.
 */
export function meteredNodeSqlite(db: DatabaseLike, options: MeteredNodeSqliteOptions = {}): SqlDriver & { meter: SqlMeter } {
  const base = nodeSqlite(db);
  const meter = options.meter ?? newSqlMeter();
  const plans = new Map<string, string[]>();
  const indexes = new Map<string, TableIndexes>();
  /** Lowercase name → the table's name, for every real table. */
  let tables: Map<string, string> | null = null;

  const scalar = (sql: string, params: unknown[] = []) => Number((db.prepare(sql).all(...params)[0] as Row | undefined)?.n ?? 0);
  const totalChanges = () => scalar("SELECT total_changes() AS n");
  const tableNames = () =>
    (tables ??= new Map(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => [String(r.name).toLowerCase(), String(r.name)]),
    ));
  const indexesOf = (table: string): TableIndexes => {
    let info = indexes.get(table);
    if (!info) {
      info = { full: [], partial: [] };
      for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table) as Row[]) {
        const predicate = r.sql === null ? null : (/\)\s*where\s+([\s\S]+)$/i.exec(String(r.sql))?.[1] ?? null);
        if (predicate) info.partial.push(`SELECT count(*) AS n FROM ${quote(table)} WHERE ${predicate}`);
        else info.full.push((db.prepare("SELECT name FROM pragma_index_info(?)").all(String(r.name)) as Row[]).map((c) => String(c.name).toLowerCase()));
      }
      indexes.set(table, info);
    }
    return info;
  };
  /** Rows in each partial index of `table`: their changes are index entries written. */
  const partialCounts = (table: string | undefined): number[] => {
    if (!table) return [];
    return indexesOf(table).partial.map((q) => {
      try {
        return scalar(q);
      } catch {
        return 0;
      }
    });
  };
  const schemaRows = () => scalar("SELECT count(*) AS n FROM sqlite_master");
  const plan = (sql: string, params: readonly SqlValue[]): string[] => {
    let details = plans.get(sql);
    if (!details) {
      try {
        details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bind(params)) as Row[]).map((r) => String(r.detail));
      } catch {
        details = [];
      }
      plans.set(sql, details);
    }
    return details;
  };

  return {
    meter,
    transaction: (fn) => base.transaction(fn),
    exec(sql: string, params: readonly SqlValue[] = []): Row[] {
      const tokens = tokenizeSql(sql);
      const kind = statementKind(tokens);
      let read = 0;
      let searches = false;
      if (kind !== "ddl" && kind !== "other") {
        const aliases = aliasMap(tokens, tableNames());
        for (const detail of plan(sql, params)) {
          const scan = /^SCAN (?:TABLE )?(\S+)/.exec(detail);
          const name = scan?.[1]?.toLowerCase();
          const table = name ? tableNames().get(aliases.get(name) ?? name) : undefined;
          if (table) read += scalar(`SELECT count(*) AS n FROM ${quote(table)}`);
          else if (detail.startsWith("SEARCH ")) searches = true;
        }
      }
      const writes = kind === "insert" || kind === "update" || kind === "delete";
      const target = writes ? tableNames().get(writeTarget(tokens) ?? "") : undefined;
      const partialBefore = partialCounts(target);
      const schemaBefore = kind === "ddl" ? schemaRows() : 0;
      const before = totalChanges();
      let rows: Row[];
      try {
        rows = base.exec(sql, params);
      } finally {
        meter.statements++;
      }
      const changed = totalChanges() - before;
      if (searches) read += kind === "select" ? rows.length : changed;
      let written = changed;
      if (target && changed > 0 && kind !== "delete") {
        const { full } = indexesOf(target);
        const set = kind === "update" ? setColumns(tokens) : null;
        written += changed * full.filter((cols) => !set || cols.some((c) => set.has(c))).length;
        partialCounts(target).forEach((n, i) => (written += Math.max(0, n - (partialBefore[i] ?? n))));
      }
      if (kind === "ddl") {
        const schema = Math.abs(schemaRows() - schemaBefore);
        // Measured on workerd: a new table also updates the schema header, and building an index reads its table.
        const createsTable = /^create\s+(temp\w*\s+)?(virtual\s+)?table\b/i.test(sql.trim());
        written += schema + (createsTable && schema ? 1 : 0);
        if (schema) read += 1 + (/^create\s+(unique\s+)?index\b/i.test(sql.trim()) ? 1 : 0);
        // A migration may add tables or indexes: forget what was cached about them.
        plans.clear();
        indexes.clear();
        tables = null;
      }
      meter.rowsRead += read;
      meter.rowsWritten += written;
      options.onStatement?.({ sql, params, rowsRead: read, rowsWritten: written });
      return rows;
    },
  };
}

interface TableIndexes {
  /** Columns of each full index (UNIQUE and PRIMARY KEY autoindexes included). */
  full: string[][];
  /** A count query per partial index. */
  partial: string[];
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The columns an UPDATE assigns: `SET a = ?, "b" = ?`. */
function setColumns(tokens: SqlToken[]): Set<string> {
  const cols = new Set<string>();
  const start = tokens.findIndex((t) => t.kind === "ident" && t.text === "set");
  let depth = 0;
  for (let i = start + 1; start >= 0 && i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct" && t.text === "(") depth++;
    else if (t.kind === "punct" && t.text === ")") depth--;
    else if (depth === 0 && t.kind === "ident" && ["where", "from", "returning", "order", "limit"].includes(t.text)) break;
    else if ((t.kind === "ident" || t.kind === "quoted") && tokens[i + 1]?.kind === "punct" && tokens[i + 1]!.text === "=") cols.add(t.text);
  }
  return cols;
}

function bind(params: readonly SqlValue[]): unknown[] {
  return params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p instanceof ArrayBuffer ? new Uint8Array(p) : p));
}

type StatementKind = "select" | "insert" | "update" | "delete" | "ddl" | "other";

const VERBS: Record<string, StatementKind> = {
  select: "select", values: "select", insert: "insert", replace: "insert", update: "update", delete: "delete",
  create: "ddl", drop: "ddl", alter: "ddl",
};

/** The statement's verb: its first word, or after a WITH clause (whose bodies sit in parentheses) the first verb outside them. */
function statementKind(tokens: SqlToken[]): StatementKind {
  const first = tokens.find((t) => t.kind === "ident");
  if (first?.text !== "with") return (first && VERBS[first.text]) ?? "other";
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === "punct" && t.text === "(") depth++;
    else if (t.kind === "punct" && t.text === ")") depth--;
    else if (depth === 0 && t.kind === "ident" && VERBS[t.text]) return VERBS[t.text]!;
  }
  return "other";
}

const CONFLICT = new Set(["rollback", "abort", "replace", "fail", "ignore"]);

/** The table an INSERT, REPLACE, UPDATE or DELETE writes to. */
function writeTarget(tokens: SqlToken[]): string | null {
  const update = tokens.findIndex((t) => t.kind === "ident" && t.text === "update");
  if (update >= 0 && statementKind(tokens) === "update") {
    let i = update + 1;
    if (tokens[i]?.text === "or" && CONFLICT.has(tokens[i + 1]?.text ?? "")) i += 2;
    if (tokens[i + 1]?.text === ".") i += 2;
    const name = tokens[i];
    return name && name.kind !== "punct" ? name.text : null;
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (t.kind === "ident" && (t.text === "into" || (t.text === "from" && tokens[i - 1]?.text === "delete"))) {
      let name = tokens[i + 1]!;
      // schema.table
      if (tokens[i + 2]?.text === "." && tokens[i + 3]) name = tokens[i + 3]!;
      return name.kind === "punct" ? null : name.text;
    }
  }
  return null;
}

const NOT_ALIAS = new Set([
  "where", "join", "inner", "left", "right", "full", "outer", "cross", "natural", "on", "using", "group", "order", "limit",
  "having", "window", "union", "except", "intersect", "set", "values", "returning", "indexed", "not", "as", "select", "default",
]);

/** `FROM orders o` / `JOIN orders AS o`: o → orders (lowercase), so a plan's `SCAN o` can be traced to its table. */
function aliasMap(tokens: SqlToken[], tables: ReadonlyMap<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if ((t.kind !== "ident" && t.kind !== "quoted") || !tables.has(t.text)) continue;
    let j = i + 1;
    if (tokens[j]?.kind === "ident" && tokens[j]!.text === "as") j++;
    const alias = tokens[j];
    if (alias && (alias.kind === "ident" || alias.kind === "quoted") && !NOT_ALIAS.has(alias.text) && !tables.has(alias.text)) {
      map.set(alias.text, t.text);
    }
  }
  return map;
}
