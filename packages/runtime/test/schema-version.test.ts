import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineActuator, z } from "@actuate/sdk";
import { JOURNAL_SCHEMA_VERSION, JournalVersionError, RunManager, applySchema, executePass, journalSchemaVersion, nodeSqlite } from "../src/index.js";

const stamp = (db: DatabaseSync) => (db.prepare(`SELECT value FROM _actuate_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined)?.value;
const tables = (db: DatabaseSync) => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
const dump = (db: DatabaseSync) => db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`).all();

const sleeper = defineActuator({
  name: "sleeper",
  description: "test",
  input: z.object({}),
  async run(ctx) {
    const before = await ctx.step.do("before", () => "kept");
    await ctx.step.sleep("nap", "1 hour");
    return { before };
  },
});

function manager(db: DatabaseSync, clock: { now: number }) {
  return new RunManager({
    sql: nodeSqlite(db),
    approvalSecret: "s",
    approvalUrl: "https://example.test/approve",
    now: () => clock.now,
    consoleLogs: false,
    invoke: (request, journal) => executePass(sleeper, request, { journal, config: {} }),
  });
}

describe("journal schema version", () => {
  it("stamps a new database with the current version", () => {
    const db = new DatabaseSync(":memory:");
    applySchema(nodeSqlite(db));
    expect(stamp(db)).toBe(String(JOURNAL_SCHEMA_VERSION));
    expect(journalSchemaVersion(nodeSqlite(db))).toBe(JOURNAL_SCHEMA_VERSION);
    expect(tables(db)).toEqual(["_actuate_approval_buttons", "_actuate_events", "_actuate_logs", "_actuate_meta", "_actuate_migrations", "_actuate_runs", "_actuate_steps"]);
  });

  it("reports no version for a database that has none yet, without touching it", () => {
    const db = new DatabaseSync(":memory:");
    expect(journalSchemaVersion(nodeSqlite(db))).toBeNull();
    expect(tables(db)).toEqual([]);
  });

  it("sets the wake-up again from the database when a host asks (an alarm dropped while it could not open)", async () => {
    const db = new DatabaseSync(":memory:");
    const clock = { now: Date.parse("2026-11-14T00:00:00Z") };
    const { run } = await manager(db, clock).start({ input: {}, trigger: { kind: "api" } });
    const wakes: Array<number | null> = [];
    const reopened = new RunManager({
      sql: nodeSqlite(db),
      approvalSecret: "s",
      approvalUrl: "https://example.test/approve",
      now: () => clock.now,
      consoleLogs: false,
      scheduleWake: (at) => void wakes.push(at),
      invoke: (request, journal) => executePass(sleeper, request, { journal, config: {} }),
    });
    expect(wakes).toEqual([]);
    await reopened.ensureWake();
    expect(wakes).toEqual([run.wakeAt]);
  });

  it("changes nothing when a stamped database is opened again", () => {
    const db = new DatabaseSync(":memory:");
    applySchema(nodeSqlite(db));
    const before = dump(db);
    const changes = () => (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
    const written = changes();
    applySchema(nodeSqlite(db));
    expect(dump(db)).toEqual(before);
    expect(changes()).toBe(written);
  });

  it("keeps the version table out of the tables an owner sees", () => {
    const db = new DatabaseSync(":memory:");
    expect(manager(db, { now: 0 }).listTables()).toEqual([]);
  });

  it("upgrades a database from before stamps, and its sleeping run finishes with its completed steps kept", async () => {
    const db = new DatabaseSync(":memory:");
    const clock = { now: Date.parse("2026-11-14T00:00:00Z") };
    const { run } = await manager(db, clock).start({ input: {}, trigger: { kind: "api" } });
    expect(run.status).toBe("WAITING");
    // As 0.5.0 left it: no version table, and steps that don't record what kind of error failed them.
    // (The columns 0.5.0 added are covered in run-key and buttons tests.)
    db.exec(`DROP TABLE _actuate_meta`);
    db.exec(`ALTER TABLE _actuate_steps DROP COLUMN error_json`);

    const upgraded = manager(db, clock);
    expect(stamp(db)).toBe(String(JOURNAL_SCHEMA_VERSION));
    expect((db.prepare(`SELECT name FROM pragma_table_info('_actuate_steps')`).all() as Array<{ name: string }>).map((c) => c.name)).toContain("error_json");
    clock.now += 3_600_000;
    await upgraded.alarm();
    expect(upgraded.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { before: "kept" } });
  });

  it.each(["2", "99", "abc", "0", "1.5", ""])("refuses a database stamped %j by a newer runtime, and leaves it as it was", (value) => {
    const db = new DatabaseSync(":memory:");
    // A database a later runtime made: its own stamp, and tables this one has never seen.
    db.exec(`CREATE TABLE _actuate_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
    db.prepare(`INSERT INTO _actuate_meta VALUES ('schema_version', ?)`).run(value);
    db.exec(`CREATE TABLE _actuate_runs (run_id TEXT PRIMARY KEY, shape_from_the_future TEXT) WITHOUT ROWID`);
    const before = dump(db);

    let thrown: unknown;
    try {
      applySchema(nodeSqlite(db));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(JournalVersionError);
    expect((thrown as Error).message).toMatch(/written by a newer @actuate\/runtime .* Upgrade @actuate\/runtime; the database was not changed\./);
    expect(thrown).toMatchObject({ supported: JOURNAL_SCHEMA_VERSION });
    expect(dump(db)).toEqual(before);
    expect(stamp(db)).toBe(value);
    expect(() => manager(db, { now: 0 })).toThrow(JournalVersionError);
  });
});
