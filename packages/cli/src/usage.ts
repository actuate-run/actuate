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
  /**
   * Statements claimed ahead by ctx.db.commitWithStep: they run later, when the step commits, and name no run, so the
   * next that many statements with no run of their own are this run's.
   */
  private readonly claims: Array<{ runId: string; left: number }> = [];

  /** The next `count` statements no run accounts for are `runId`'s (ctx.db.commitWithStep's queued writes). */
  claim(runId: string, count: number): void {
    if (count > 0) this.claims.push({ runId, left: count });
  }

  /** The step that queued them failed: its writes never run, so its claims go. */
  dropClaims(runId: string): void {
    for (let i = this.claims.length - 1; i >= 0; i--) if (this.claims[i]!.runId === runId) this.claims.splice(i, 1);
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
    let runId = this.current ?? (params.find((p) => typeof p === "string" && RUN_ID.test(p)) as string | undefined) ?? null;
    if (!runId && this.claims.length) {
      const claim = this.claims[0]!;
      runId = claim.runId;
      if (--claim.left === 0) this.claims.shift();
    }
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
