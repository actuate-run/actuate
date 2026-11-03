/**
 * Rows read and written per run, in the units the hosted platform bills.
 * `actuate dev` feeds it from Durable Object storage (Cloudflare's own
 * counters); `@actuate/cli/testing` from `meteredNodeSqlite`. No Node imports:
 * `actuate dev` bundles this file into workerd.
 */
export interface RunUsage {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
}

/** newRunId(): `run_` + 28 hex characters. */
const RUN_ID = /^run_[0-9a-f]{28}$/;
const MAX_RUNS = 1_000;

export const emptyUsage = (): RunUsage => ({ statements: 0, rowsRead: 0, rowsWritten: 0 });

/**
 * Attributes each statement to a run: to the run whose `ctx.db` made it (see
 * {@link UsageTracker.attribute}), else to the run whose ID is one of its
 * parameters (every journal statement names its run), else to no run.
 */
export class UsageTracker {
  private readonly runs = new Map<string, RunUsage>();
  private current: string | null = null;
  /** While above 0, statements are not counted (e.g. reads made to answer `actuate logs`). */
  paused = 0;
  /** Statements no run accounts for: alarms, buffered events. */
  readonly other: RunUsage = emptyUsage();
  /** Set on every change, cleared by whoever persists it. */
  dirty = false;
  /** Statements of the transaction running now, held until it ends (see transaction). */
  private pending: Array<{ runId: string | null; cost: { rowsRead: number; rowsWritten: number } }> | null = null;

  /**
   * Run a database transaction. Its statements are held until it ends; then those that name no run go to the one run
   * the transaction's other statements name, if exactly one. A step's commit is such a transaction: the writes
   * ctx.db.commitWithStep queued name no run, and the step row written with them does. Rolled-back work counts too,
   * as it does on the platform (the rows were still read and written).
   */
  transaction<T>(fn: () => T): T {
    if (this.pending) return fn(); // nested: part of the outer one
    this.pending = [];
    try {
      return fn();
    } finally {
      const held = this.pending;
      this.pending = null;
      const runs = new Set(held.map((h) => h.runId).filter((r): r is string => r !== null));
      const owner = runs.size === 1 ? [...runs][0]! : null;
      for (const h of held) this.add(h.runId ?? owner, h.cost);
    }
  }

  /** Run `fn` with statements attributed to `runId`. `fn` must reach the database synchronously (ctx.db calls do). */
  attribute<T>(runId: string, fn: () => T): T {
    const previous = this.current;
    this.current = runId;
    try {
      return fn();
    } finally {
      this.current = previous;
    }
  }

  record(params: readonly unknown[], cost: { rowsRead: number; rowsWritten: number }): void {
    if (this.paused > 0) return;
    const runId = this.current ?? (params.find((p) => typeof p === "string" && RUN_ID.test(p)) as string | undefined) ?? null;
    if (this.pending) this.pending.push({ runId, cost });
    else this.add(runId, cost);
  }

  private add(runId: string | null, cost: { rowsRead: number; rowsWritten: number }): void {
    let usage = this.other;
    if (runId) {
      usage = this.runs.get(runId) ?? emptyUsage();
      this.runs.delete(runId); // re-inserted last: the map is oldest-first for eviction
      this.runs.set(runId, usage);
      if (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);
    }
    usage.statements++;
    usage.rowsRead += cost.rowsRead;
    usage.rowsWritten += cost.rowsWritten;
    this.dirty = true;
  }

  of(runId: string): RunUsage {
    return { ...(this.runs.get(runId) ?? emptyUsage()) };
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  toJSON(): Record<string, RunUsage> {
    return Object.fromEntries(this.runs);
  }

  load(saved: Record<string, RunUsage> | undefined | null): void {
    for (const [runId, u] of Object.entries(saved ?? {})) if (!this.runs.has(runId)) this.runs.set(runId, { ...emptyUsage(), ...u });
  }
}
