import type { DbStatement, Json, Row, SqlValue, Trigger, WaitForApprovalOptions } from "@actuate/sdk";
import {
  fromJson,
  toJson,
  type Journal,
  type LogLevel,
  type PassLimits,
  type PassOutcome,
  type PassRequest,
  type SerializedError,
  type StepRow,
} from "./journal.js";
import { approvalEventKey } from "./pass.js";
import { INPUT_KEY_COMPLETED_TTL_MS } from "./run-key.js";
import { redactSecrets } from "./secrets.js";
import { applySchema, type SqlDriver } from "./sql.js";
import { signApproval, verifyApproval } from "./tokens.js";

export type RunStatus = "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface RunRecord {
  runId: string;
  status: RunStatus;
  trigger: Trigger;
  input: Json;
  output: Json | null;
  error: SerializedError | null;
  idempotencyKey: string | null;
  wakeAt: number | null;
  passes: number;
  createdAt: number;
  updatedAt: number;
}

export interface StepRecord {
  name: string;
  status: StepRow["status"];
  output: Json | null;
  wakeAt: number | null;
  event: string | null;
  attempts: number;
  error: string | null;
  updatedAt: number;
}

export interface LogRecord {
  ts: number;
  level: LogLevel;
  message: string;
  data: Json | null;
}

export interface ApprovalRequest {
  runId: string;
  step: string;
  /** "approval" carries approveUrl and rejectUrl; "input" carries answerUrl. */
  kind: "approval" | "input";
  /** The approval message, or the question for input. */
  message?: string;
  notify?: string;
  approveUrl?: string;
  rejectUrl?: string;
  answerUrl?: string;
  expiresAt: number;
}

/** Executes one pass of a run. In-process for the single-tenant runtime; an RPC into a child isolate on the platform. */
export type Invoke = (request: PassRequest, journal: Journal) => Promise<PassOutcome>;

export interface RunManagerOptions {
  sql: SqlDriver;
  invoke: Invoke;
  /** HMAC secret for approval links. */
  approvalSecret: string;
  /** Absolute URL of the approval endpoint (or a getter); tokens are appended as `?token=`. */
  approvalUrl: string | (() => string);
  /** Deliver approval links (email, messaging). Errors are logged, not thrown. */
  notifyApproval?: (request: ApprovalRequest) => Promise<void>;
  /** Called whenever the earliest wake time changes, so the host can set its alarm. */
  scheduleWake?: (wakeAt: number | null) => void | Promise<void>;
  now?: () => number;
  /** Safety valve against runs that never settle. Default 10,000 passes. */
  maxPasses?: number;
  /** Buffered events nobody waited for are dropped after this long. Default 7 days. */
  eventBufferTtlMs?: number;
  /** Mirror run logs to console. Default true. */
  consoleLogs?: boolean;
  /** Log lines kept per pass; the rest are dropped with one warning. Default 100. */
  maxLogLinesPerPass?: number;
  /** Limits handed to every pass (longest wait, retry cap). */
  passLimits?: PassLimits;
  /**
   * Asked before every pass. Return a time to defer the pass until (the run
   * stays WAITING, nothing is lost) or null to run it now. Used for budgets.
   */
  admitPass?: (runId: string) => Promise<number | null> | number | null;
  /** Events buffered while nobody waits for them; the oldest are dropped beyond this. Default 1000. */
  maxBufferedEvents?: number;
  /** Largest event payload accepted, bytes of JSON. Default 64 KiB. */
  maxEventBytes?: number;
  /**
   * The values of the actuator's secret config fields (`collectSecrets(configJsonSchema, config)`), asked for
   * whenever something is written or read. Each becomes `[secret]` in log lines, run and step errors (when
   * written), and in everything the read methods return: `getRun`, `listRuns`, `getSteps`, `getLogs`, the
   * approval queue and link pages, and the run `start` returns. Stored step outputs and run outputs stay as
   * they were, so replay returns the real values (`journal()` reads them raw).
   *
   * Known limits: reads are redacted with the secrets configured now, so output stored before a secret was
   * rotated shows the old value; user tables (`readTable`) are the actuator's own data and are not redacted.
   */
  secrets?: () => readonly string[];
}

/** Who made a human decision, and through what. */
export interface Who {
  by?: string;
  via: "link" | "dashboard" | "api";
}

function whoFields(who: Who): { by?: string; via: Who["via"] } {
  const by = who.by?.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120);
  return { ...(by ? { by } : {}), via: who.via };
}

export interface StartRunOptions {
  input: Json;
  trigger: Trigger;
  /** A retried request with the same key returns the first run instead of starting another, whatever that run's status. */
  idempotencyKey?: string;
  /**
   * The key derived from the actuator's `idempotencyKey` input fields (`deriveInputKey`). It returns a run with the
   * same key that is RUNNING or WAITING, or COMPLETED in the last 24 hours; FAILED and CANCELLED runs never match,
   * and a new run takes the key over from them. Stored apart from `idempotencyKey` and checked after it, so both
   * can be given (a legacy MCP session's key and the derived one). Leave it out when the caller sent a key of its
   * own, and for runs that must start anew (an owner's "run again").
   */
  inputKey?: string;
  runId?: string;
}

const WAITING_STEP = "('SLEEPING','RETRYING','WAITING_EVENT','WAITING_APPROVAL','WAITING_INPUT')";

/**
 * Host-side run lifecycle over one actuator's SQLite database: starting runs,
 * resuming them on alarms and events, approvals, and read APIs for the dashboard.
 */
export class RunManager {
  private readonly sql: SqlDriver;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private seq = 0;

  constructor(private readonly options: RunManagerOptions) {
    this.sql = options.sql;
    this.now = options.now ?? Date.now;
    applySchema(this.sql);
  }

  // ---------------------------------------------------------------- runs

  async start(opts: StartRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    // No await between the lookups and the insert: on a Durable Object nothing else runs in between.
    const now = this.now();
    const completedSince = now - INPUT_KEY_COMPLETED_TTL_MS;
    const existing =
      (opts.idempotencyKey ? this.sql.exec(`SELECT run_id FROM _actuate_runs WHERE idempotency_key = ?`, [opts.idempotencyKey])[0] : undefined) ??
      (opts.inputKey
        ? this.sql.exec(
            `SELECT run_id FROM _actuate_runs
              WHERE input_key = ? AND (status IN ('RUNNING','WAITING') OR (status = 'COMPLETED' AND updated_at >= ?))`,
            [opts.inputKey, completedSince],
          )[0]
        : undefined);
    if (existing) {
      const runId = String(existing.run_id);
      await this.locks.get(runId); // a concurrent duplicate waits for the first pass to settle
      return { run: this.getRun(runId)!, created: false };
    }
    const runId = opts.runId ?? newRunId();
    this.sql.transaction(() => {
      // A derived key held by a run that no longer matches (failed, cancelled, completed over 24 hours ago) passes to the new run.
      if (opts.inputKey) {
        this.sql.exec(
          `UPDATE _actuate_runs SET input_key = NULL
            WHERE input_key = ? AND (status IN ('FAILED','CANCELLED') OR (status = 'COMPLETED' AND updated_at < ?))`,
          [opts.inputKey, completedSince],
        );
      }
      this.sql.exec(
        `INSERT INTO _actuate_runs (run_id, status, trigger_json, input_json, idempotency_key, input_key, created_at, updated_at)
         VALUES (?, 'RUNNING', ?, ?, ?, ?, ?, ?)`,
        [runId, toJson(opts.trigger), toJson(opts.input), opts.idempotencyKey ?? null, opts.inputKey ?? null, now, now],
      );
    });
    await this.execute(runId);
    return { run: this.getRun(runId)!, created: true };
  }

  /** Run another pass now, e.g. after an event or alarm. No-op for settled runs. */
  resume(runId: string): Promise<void> {
    return this.execute(runId);
  }

  cancel(runId: string): boolean {
    const now = this.now();
    const rows = this.sql.exec(
      `UPDATE _actuate_runs SET status = 'CANCELLED', wake_at = NULL, updated_at = ?
       WHERE run_id = ? AND status IN ('RUNNING','WAITING') RETURNING run_id`,
      [now, runId],
    );
    void this.reschedule();
    return rows.length > 0;
  }

  private execute(runId: string): Promise<void> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.executeUnlocked(runId)).catch((err) => {
      console.error(`[actuate] run ${runId} crashed in host`, err);
    });
    this.locks.set(runId, next);
    void next.finally(() => {
      if (this.locks.get(runId) === next) this.locks.delete(runId);
    });
    return next;
  }

  private async executeUnlocked(runId: string): Promise<void> {
    // Keep passing while a pass ends waiting but an event it waits for already arrived.
    for (;;) {
      const run = this.sql.exec(`SELECT * FROM _actuate_runs WHERE run_id = ?`, [runId])[0];
      if (!run || (run.status !== "RUNNING" && run.status !== "WAITING")) return;
      const passes = Number(run.passes) + 1;
      const maxPasses = this.options.maxPasses ?? 10_000;
      if (passes > maxPasses) {
        this.settle(runId, passes, { status: "failed", error: { name: "ActuatorError", message: `Run exceeded ${maxPasses} passes` } });
        return;
      }

      const deferUntil = (await this.options.admitPass?.(runId)) ?? null;
      if (deferUntil !== null) {
        this.sql.exec(`UPDATE _actuate_runs SET status = 'WAITING', wake_at = ?, updated_at = ? WHERE run_id = ?`, [
          deferUntil,
          this.now(),
          runId,
        ]);
        break;
      }

      let outcome: PassOutcome;
      try {
        outcome = await this.options.invoke(
          {
            runId,
            input: fromJson(run.input_json as string),
            trigger: fromJson<Trigger>(run.trigger_json as string),
            now: this.now,
            ...(this.options.passLimits ? { limits: this.options.passLimits } : {}),
          },
          this.journal(runId),
        );
      } catch (err) {
        outcome = { status: "failed", error: { name: "HostError", message: err instanceof Error ? err.message : String(err) } };
      }

      // Cancelled while the pass was running: leave it cancelled.
      const current = this.sql.exec(`SELECT status FROM _actuate_runs WHERE run_id = ?`, [runId])[0];
      if (current?.status === "CANCELLED") {
        this.flushLogs(runId, passes);
        return;
      }

      this.settle(runId, passes, outcome);
      if (outcome.status !== "waiting" || !this.matchBufferedEvents(runId)) break;
    }
    await this.reschedule();
  }

  /** One write for the run row per pass, plus one for that pass's logs. */
  private settle(runId: string, passes: number, outcome: PassOutcome): void {
    const now = this.now();
    if (outcome.status === "completed") {
      this.sql.exec(
        `UPDATE _actuate_runs SET status = 'COMPLETED', output_json = ?, wake_at = NULL, passes = ?, updated_at = ? WHERE run_id = ?`,
        [toJson(outcome.output), passes, now, runId],
      );
    } else if (outcome.status === "failed") {
      this.sql.exec(
        `UPDATE _actuate_runs SET status = 'FAILED', error_json = ?, wake_at = NULL, passes = ?, updated_at = ? WHERE run_id = ?`,
        [toJson(this.redact(outcome.error)), passes, now, runId],
      );
      this.bufferLog(runId, "error", outcome.error.message);
    } else {
      const wake = this.sql.exec(
        `SELECT MIN(wake_at) AS wake_at FROM _actuate_steps WHERE run_id = ? AND status IN ${WAITING_STEP} AND wake_at IS NOT NULL`,
        [runId],
      )[0];
      this.sql.exec(`UPDATE _actuate_runs SET status = 'WAITING', wake_at = ?, passes = ?, updated_at = ? WHERE run_id = ?`, [
        (wake?.wake_at as number | null) ?? null,
        passes,
        now,
        runId,
      ]);
    }
    this.flushLogs(runId, passes);
  }

  /** Close the race where an event arrives between a pass checking the buffer and writing its wait row. */
  private matchBufferedEvents(runId: string): boolean {
    const waits = this.sql.exec(
      `SELECT step_name, event FROM _actuate_steps WHERE run_id = ? AND status = 'WAITING_EVENT'`,
      [runId],
    );
    let matched = false;
    for (const wait of waits) {
      const event = this.takeBufferedEvent(String(wait.event));
      if (event) {
        this.completeWait(runId, String(wait.step_name), event.payload);
        matched = true;
      }
    }
    return matched;
  }

  // ---------------------------------------------------------------- events, approvals, alarms

  /** Post an event. Waiting steps with this key complete and their runs resume; otherwise it is buffered. */
  async deliverEvent(event: string, payload: Json = {}): Promise<{ resumed: string[]; buffered: boolean }> {
    if (event.startsWith("approval:")) throw new Error("Approval events can only be posted through a signed link.");
    // A waiting step resolves to null only on timeout, so an event never delivers null.
    if (payload === null || payload === undefined) payload = {};
    const encoded = toJson(payload);
    if (encoded.length > (this.options.maxEventBytes ?? 64 * 1024)) throw new Error("Event payload is too large.");
    const waiting = this.sql.exec(
      `SELECT run_id, step_name FROM _actuate_steps WHERE event = ? AND status = 'WAITING_EVENT'`,
      [event],
    );
    if (waiting.length === 0) {
      this.sql.exec(`INSERT INTO _actuate_events (event, payload_json, received_at) VALUES (?, ?, ?)`, [event, encoded, this.now()]);
      // Bound the buffer: drop the oldest events beyond the cap.
      this.sql.exec(`DELETE FROM _actuate_events WHERE id <= (SELECT MAX(id) FROM _actuate_events) - ?`, [this.options.maxBufferedEvents ?? 1000]);
      return { resumed: [], buffered: true };
    }
    const runIds = [...new Set(waiting.map((w) => String(w.run_id)))];
    for (const w of waiting) this.completeWait(String(w.run_id), String(w.step_name), payload);
    await Promise.all(runIds.map((id) => this.execute(id)));
    return { resumed: runIds, buffered: false };
  }

  /**
   * Apply a signed link: approve, reject (with an optional note) or answer (waitForInput).
   * Links are single-use: a step that is no longer waiting ignores later clicks.
   */
  async decide(
    token: string,
    extra: { note?: string; text?: string; by?: string } = {},
  ): Promise<{ ok: true; runId: string; step: string; approved: boolean } | { ok: false; reason: string }> {
    const claims = await verifyApproval(this.options.approvalSecret, token, this.now());
    if (!claims) return { ok: false, reason: "This link is invalid or has expired." };
    const who = { ...(extra.by ? { by: extra.by } : {}), via: "link" as const };
    if (claims.d === 2) return this.answerDirect(claims.r, claims.s, extra.text ?? "", who);
    return this.decideDirect(claims.r, claims.s, claims.d === 1, extra.note, who);
  }

  /** Approve or reject a waiting step directly (e.g. from an authenticated dashboard). */
  async decideDirect(
    runId: string,
    step: string,
    approved: boolean,
    note?: string,
    who: Who = { via: "api" },
  ): Promise<{ ok: true; runId: string; step: string; approved: boolean } | { ok: false; reason: string }> {
    const row = this.sql.exec(
      `SELECT status FROM _actuate_steps WHERE run_id = ? AND step_name = ? AND status = 'WAITING_APPROVAL'`,
      [runId, step],
    )[0];
    if (!row) return { ok: false, reason: "This approval has already been decided or has expired." };
    const trimmed = note?.trim().slice(0, 2_000);
    const result: Json = { approved, at: new Date(this.now()).toISOString(), ...(trimmed ? { note: trimmed } : {}), ...whoFields(who) };
    this.completeWait(runId, step, result);
    await this.execute(runId);
    return { ok: true, runId, step, approved };
  }

  /** Answer a step waiting in waitForInput. */
  async answerDirect(
    runId: string,
    step: string,
    text: string,
    who: Who = { via: "api" },
  ): Promise<{ ok: true; runId: string; step: string; approved: boolean } | { ok: false; reason: string }> {
    const row = this.sql.exec(
      `SELECT output_json FROM _actuate_steps WHERE run_id = ? AND step_name = ? AND status = 'WAITING_INPUT'`,
      [runId, step],
    )[0];
    if (!row) return { ok: false, reason: "This question has already been answered or has expired." };
    const { maxLength = 4_000 } = fromJson<{ maxLength?: number }>(row.output_json as string) ?? {};
    const answer = String(text ?? "").trim();
    if (!answer) return { ok: false, reason: "The answer is empty." };
    if (answer.length > maxLength) return { ok: false, reason: `The answer is longer than ${maxLength} characters.` };
    this.completeWait(runId, step, { text: answer, at: new Date(this.now()).toISOString(), ...whoFields(who) });
    await this.execute(runId);
    return { ok: true, runId, step, approved: true };
  }

  /** What a signed link is for, to render its page. Null when invalid, expired or already used. */
  async describeLink(token: string): Promise<
    | { kind: "approval"; step: string; approve: boolean; message: string | null }
    | { kind: "input"; step: string; prompt: string; initial: string | null; maxLength: number }
    | null
  > {
    const claims = await verifyApproval(this.options.approvalSecret, token, this.now());
    if (!claims) return null;
    const row = this.sql.exec(
      `SELECT status, output_json FROM _actuate_steps WHERE run_id = ? AND step_name = ? AND status IN ('WAITING_APPROVAL', 'WAITING_INPUT')`,
      [claims.r, claims.s],
    )[0];
    if (!row) return null;
    const data = this.redact(fromJson<Record<string, unknown>>(row.output_json as string) ?? {});
    if (row.status === "WAITING_INPUT" && claims.d === 2) {
      return { kind: "input", step: claims.s, prompt: String(data.prompt ?? ""), initial: (data.initial as string | null) ?? null, maxLength: Number(data.maxLength ?? 4_000) };
    }
    if (row.status === "WAITING_APPROVAL" && claims.d !== 2) {
      return { kind: "approval", step: claims.s, approve: claims.d === 1, message: (data.message as string | null) ?? null };
    }
    return null;
  }

  /** Resume every run whose wake time has passed. Call from the Durable Object alarm. */
  async alarm(): Promise<void> {
    const now = this.now();
    const due = this.sql.exec(
      `SELECT run_id FROM _actuate_runs WHERE status = 'WAITING' AND wake_at IS NOT NULL AND wake_at <= ? ORDER BY wake_at LIMIT 500`,
      [now],
    );
    this.sql.exec(`DELETE FROM _actuate_events WHERE received_at < ?`, [now - (this.options.eventBufferTtlMs ?? 7 * 86_400_000)]);
    await Promise.all(due.map((r) => this.execute(String(r.run_id))));
    await this.reschedule();
  }

  /**
   * Delete settled runs (and their steps and logs) last updated before `before`.
   * User tables are never touched. Returns how many runs were removed.
   */
  pruneRuns(before: number, limit = 500): number {
    const ids = this.sql
      .exec(`SELECT run_id FROM _actuate_runs WHERE status IN ('COMPLETED','FAILED','CANCELLED') AND updated_at < ? LIMIT ?`, [before, limit])
      .map((r) => String(r.run_id));
    if (!ids.length) return 0;
    this.sql.transaction(() => {
      for (const id of ids) {
        this.sql.exec(`DELETE FROM _actuate_steps WHERE run_id = ?`, [id]);
        this.sql.exec(`DELETE FROM _actuate_logs WHERE run_id = ?`, [id]);
        this.sql.exec(`DELETE FROM _actuate_runs WHERE run_id = ?`, [id]);
      }
    });
    return ids.length;
  }

  /**
   * Bring forward runs whose passes were deferred (actuator paused, budget
   * spent): their wake time is the deferral, not anything the run waits for.
   * Sets them due now and reschedules, so the next alarm picks them up. Runs
   * genuinely sleeping or waiting keep their wake time. Returns how many moved.
   */
  wakeDeferred(limit = 500): number {
    const now = this.now();
    const ids = this.sql
      .exec(
        `SELECT r.run_id FROM _actuate_runs r
          WHERE r.status = 'WAITING' AND r.wake_at IS NOT NULL AND r.wake_at > ?
            AND r.wake_at IS NOT (SELECT MIN(s.wake_at) FROM _actuate_steps s
                                   WHERE s.run_id = r.run_id AND s.status IN ${WAITING_STEP} AND s.wake_at IS NOT NULL)
          LIMIT ?`,
        [now, limit],
      )
      .map((r) => String(r.run_id));
    for (const id of ids) this.sql.exec(`UPDATE _actuate_runs SET wake_at = ? WHERE run_id = ?`, [now, id]);
    if (ids.length) void this.reschedule();
    return ids.length;
  }

  nextWakeAt(): number | null {
    const row = this.sql.exec(`SELECT MIN(wake_at) AS wake_at FROM _actuate_runs WHERE status = 'WAITING' AND wake_at IS NOT NULL`)[0];
    return (row?.wake_at as number | null) ?? null;
  }

  private async reschedule(): Promise<void> {
    await this.options.scheduleWake?.(this.nextWakeAt());
  }

  private completeWait(runId: string, step: string, payload: Json): void {
    this.sql.exec(
      `UPDATE _actuate_steps SET status = 'COMPLETED', output_json = ?, updated_at = ? WHERE run_id = ? AND step_name = ?`,
      [toJson(payload), this.now(), runId, step],
    );
  }

  private takeBufferedEvent(event: string): { payload: Json } | null {
    const row = this.sql.exec(
      `DELETE FROM _actuate_events WHERE id = (SELECT id FROM _actuate_events WHERE event = ? ORDER BY id LIMIT 1) RETURNING payload_json`,
      [event],
    )[0];
    return row ? { payload: fromJson(row.payload_json as string) } : null;
  }

  // ---------------------------------------------------------------- journal

  /** The storage view one pass of `runId` sees. */
  journal(runId: string): Journal {
    return {
      loadSteps: async () => this.sql.exec(`SELECT * FROM _actuate_steps WHERE run_id = ? ORDER BY seq`, [runId]) as unknown as StepRow[],
      putStep: async (row) => this.writeStep(runId, row),
      consumeEvent: async (event) => this.takeBufferedEvent(event),
      requestApproval: (step, opts) => this.requestApproval(runId, step, opts),
      query: async (sql, params) => this.sql.exec(sql, params as SqlValue[]),
      // One synchronous transaction (transactionSync on a Durable Object): nothing else runs in between, and a
      // statement that throws rolls back the ones before it.
      batch: async (statements) => this.sql.transaction(() => this.execAll(statements)),
      commitStep: async (row, statements) =>
        this.sql.transaction(() => {
          this.execAll(statements);
          this.writeStep(runId, row);
        }),
      migrate: async (statements) => {
        const changed: number[] = [];
        this.sql.transaction(() => {
          const done = this.sql.exec(`SELECT idx, statement FROM _actuate_migrations ORDER BY idx`);
          const applied = done.length ? Number(done[done.length - 1]!.idx) : -1;
          const norm = (q: unknown) => String(q).replace(/\s+/g, " ").trim();
          statements.forEach((statement, idx) => {
            if (idx <= applied) {
              const before = done.find((d) => Number(d.idx) === idx);
              if (before && norm(before.statement) !== norm(statement)) changed.push(idx);
              return;
            }
            this.sql.exec(statement);
            this.sql.exec(`INSERT INTO _actuate_migrations (idx, statement, applied_at) VALUES (?, ?, ?)`, [idx, statement, this.now()]);
          });
        });
        // Migrations are tracked by position: an edited entry is never re-run, which is easy to miss.
        if (changed.length) {
          this.writeLog(runId, "warn", `Migration ${changed.join(", ")} changed after it was applied and was not re-run. Append a new migration instead of editing one.`);
        }
      },
      log: (level, message, data) => this.writeLog(runId, level, message, data),
    };
  }

  private writeStep(runId: string, row: StepRow): void {
    // The error is shown as written (and thrown again on replay); the output stays raw for replay.
    const error = row.error === null ? null : this.redact(row.error);
    this.sql.exec(
      `INSERT INTO _actuate_steps (run_id, step_name, status, output_json, wake_at, event, attempts, error, seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, step_name) DO UPDATE SET status = excluded.status, output_json = excluded.output_json,
         wake_at = excluded.wake_at, event = excluded.event, attempts = excluded.attempts, error = excluded.error,
         updated_at = excluded.updated_at`,
      [runId, row.step_name, row.status, row.output_json, row.wake_at, row.event, row.attempts, error, ++this.seq + this.now() * 1000, this.now()],
    );
  }

  /** Run tenant statements in order (inside the caller's transaction); a failure names the statement. */
  private execAll(statements: readonly DbStatement[]): Row[][] {
    return statements.map((st, i) => {
      try {
        return this.sql.exec(st.sql, (st.params ?? []) as SqlValue[]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Statement ${i + 1} of ${statements.length} failed, so none were applied: ${message}`, { cause: err });
      }
    });
  }

  private readonly logBuffers = new Map<string, LogRecord[]>();

  /** Lines are held per run and written as one row when the pass settles. Secrets are redacted before anything is cut short. */
  private bufferLog(runId: string, level: LogLevel, message: string, data?: Json): void {
    let lines = this.logBuffers.get(runId);
    if (!lines) this.logBuffers.set(runId, (lines = []));
    const max = this.options.maxLogLinesPerPass ?? 100;
    message = this.redact(String(message));
    if (data !== undefined) data = this.redact(fromJson(toJson(data)));
    if (lines.length < max) {
      let encoded = data === undefined ? null : toJson(data);
      if (encoded && encoded.length > 4096) encoded = toJson({ truncated: encoded.slice(0, 4000) });
      lines.push({ ts: this.now(), level, message: String(message).slice(0, 2000), data: encoded === null ? null : fromJson(encoded) });
    } else if (lines.length === max) {
      lines.push({ ts: this.now(), level: "warn", message: `Log limit reached: ${max} lines per pass; further lines dropped.`, data: null });
    }
    if (this.options.consoleLogs !== false) console[level === "info" ? "log" : level](`[${runId}] ${message}`, data ?? "");
  }

  private async writeLog(runId: string, level: LogLevel, message: string, data?: Json): Promise<void> {
    this.bufferLog(runId, level, message, data);
  }

  private flushLogs(runId: string, pass: number): void {
    const lines = this.logBuffers.get(runId);
    this.logBuffers.delete(runId);
    if (!lines?.length) return;
    this.sql.exec(
      `INSERT INTO _actuate_logs (run_id, pass, lines_json) VALUES (?, ?, ?)
       ON CONFLICT (run_id, pass) DO UPDATE SET lines_json = json_insert(lines_json, '$[#]', json(excluded.lines_json))`,
      [runId, pass, toJson(lines)],
    );
  }

  private async signedLinks(
    runId: string,
    step: string,
    expiresAt: number,
    kind: "approval" | "input",
  ): Promise<{ approveUrl: string; rejectUrl: string } | { answerUrl: string }> {
    const secret = this.options.approvalSecret;
    const base = typeof this.options.approvalUrl === "function" ? this.options.approvalUrl() : this.options.approvalUrl;
    const url = (token: string) => `${base}${base.includes("?") ? "&" : "?"}token=${token}`;
    if (kind === "input") return { answerUrl: url(await signApproval(secret, { r: runId, s: step, d: 2, e: expiresAt })) };
    const [approve, reject] = await Promise.all([
      signApproval(secret, { r: runId, s: step, d: 1, e: expiresAt }),
      signApproval(secret, { r: runId, s: step, d: 0, e: expiresAt }),
    ]);
    return { approveUrl: url(approve), rejectUrl: url(reject) };
  }

  /**
   * The signed links for a step waiting on a person, for an owner who has no
   * messaging channel. Only expose this behind owner authentication.
   */
  async approvalLinks(
    runId: string,
    step: string,
  ): Promise<({ approveUrl: string; rejectUrl: string } | { answerUrl: string }) & { expiresAt: number } | null> {
    const row = this.sql.exec(
      `SELECT status, wake_at FROM _actuate_steps WHERE run_id = ? AND step_name = ? AND status IN ('WAITING_APPROVAL', 'WAITING_INPUT')`,
      [runId, step],
    )[0];
    if (!row || row.wake_at === null) return null;
    const expiresAt = Number(row.wake_at);
    const kind = row.status === "WAITING_INPUT" ? "input" : "approval";
    return { ...(await this.signedLinks(runId, step, expiresAt, kind)), expiresAt };
  }

  private async requestApproval(
    runId: string,
    step: string,
    opts: WaitForApprovalOptions & { expiresAt: number; kind?: "approval" | "input" },
  ): Promise<void> {
    const kind = opts.kind ?? "approval";
    const links = await this.signedLinks(runId, step, opts.expiresAt, kind);
    const request: ApprovalRequest = {
      runId,
      step,
      kind,
      ...links,
      expiresAt: opts.expiresAt,
      // The approver may not be the owner: they see the message, not the secrets in it.
      ...(opts.message ? { message: this.redact(opts.message) } : {}),
      ...(opts.notify ? { notify: opts.notify } : {}),
    };
    // Never log the links: run logs are readable by anything holding a run token (e.g. the agent being gated).
    await this.writeLog(runId, "info", kind === "input" ? `Input requested for "${step}"` : `Approval requested for "${step}"`, {
      step,
      expiresAt: opts.expiresAt,
    });
    try {
      await this.options.notifyApproval?.(request);
    } catch (err) {
      await this.writeLog(runId, "error", `Could not deliver approval link for "${step}"`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------- reads

  /** `value` with the actuator's secret config values replaced by `[secret]` (see {@link RunManagerOptions.secrets}). */
  redact<T>(value: T): T {
    const secrets = this.options.secrets?.();
    return secrets?.length ? redactSecrets(value, secrets) : value;
  }

  getRun(runId: string): RunRecord | null {
    const row = this.sql.exec(`SELECT * FROM _actuate_runs WHERE run_id = ?`, [runId])[0];
    return row ? this.redact(toRunRecord(row)) : null;
  }

  /**
   * Newest first. Page with `before`: the last run ID of the previous page
   * (exact keyset on the primary key, so runs created in the same millisecond
   * are never skipped or repeated), or, for older clients, a createdAt
   * timestamp (strictly older; ties with the timestamp are skipped).
   * Run IDs are time-sortable, so the primary key orders the list for free.
   */
  listRuns(opts: { limit?: number; before?: number | string; status?: RunStatus } = {}): RunRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const byId = typeof opts.before === "string" && !/^\d+$/.test(opts.before);
    const rows = this.sql.exec(
      `SELECT * FROM _actuate_runs
        WHERE ${byId ? "run_id < ?" : "created_at < ?"} AND (? IS NULL OR status = ?)
        ORDER BY run_id DESC LIMIT ?`,
      [byId ? (opts.before as string) : Number(opts.before ?? Number.MAX_SAFE_INTEGER), opts.status ?? null, opts.status ?? null, limit],
    );
    return this.redact(rows.map(toRunRecord));
  }

  /** Step outputs as shown to people (redacted). Replay reads the raw rows through `journal()`. */
  getSteps(runId: string): StepRecord[] {
    const steps = this.sql.exec(`SELECT * FROM _actuate_steps WHERE run_id = ? ORDER BY seq`, [runId]).map((r) => ({
      name: String(r.step_name),
      status: r.status as StepRow["status"],
      output: fromJson((r.output_json as string | null) ?? null),
      wakeAt: (r.wake_at as number | null) ?? null,
      event: (r.event as string | null) ?? null,
      attempts: Number(r.attempts),
      error: (r.error as string | null) ?? null,
      updatedAt: Number(r.updated_at),
    }));
    return this.redact(steps);
  }

  getLogs(runId: string, limit = 500): LogRecord[] {
    const rows = this.sql.exec(`SELECT lines_json FROM _actuate_logs WHERE run_id = ? ORDER BY pass`, [runId]);
    const persisted = rows.flatMap((r) => fromJson<LogRecord[]>(r.lines_json as string));
    // Lines are redacted when written; again here, for lines written before a secret was configured.
    return this.redact([...persisted, ...(this.logBuffers.get(runId) ?? [])].slice(0, limit));
  }

  /** Steps waiting for a human decision, oldest first: the approval queue. */
  pendingApprovals(): Array<{
    runId: string;
    step: string;
    kind: "approval" | "input";
    message: string | null;
    /** Input only: the pre-filled draft and the longest answer accepted. */
    initial?: string | null;
    maxLength?: number;
    expiresAt: number | null;
    since: number;
  }> {
    const pending = this.sql
      .exec(
        `SELECT run_id, step_name, status, output_json, wake_at, updated_at FROM _actuate_steps WHERE status IN ('WAITING_APPROVAL', 'WAITING_INPUT') ORDER BY updated_at`,
      )
      .map((r) => ({
        runId: String(r.run_id),
        step: String(r.step_name),
        kind: r.status === "WAITING_INPUT" ? ("input" as const) : ("approval" as const),
        ...(() => {
          const d = fromJson<{ message?: string | null; prompt?: string | null; initial?: string | null; maxLength?: number } | null>(
            (r.output_json as string | null) ?? null,
          );
          return r.status === "WAITING_INPUT"
            ? { message: d?.prompt ?? null, initial: d?.initial ?? null, maxLength: d?.maxLength ?? 4_000 }
            : { message: d?.message ?? null };
        })(),
        expiresAt: (r.wake_at as number | null) ?? null,
        since: Number(r.updated_at),
      }));
    return this.redact(pending);
  }

  /** User tables in this actuator's database (excluding runtime, SQLite, Cloudflare and Miniflare internals). */
  listTables(): string[] {
    return this.sql
      .exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_actuate\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_\\_miniflare\\_%' ESCAPE '\\' ORDER BY name`,
      )
      .map((r) => String(r.name));
  }

  /**
   * Row counts for the table list. Counting reads (and bills) every row it
   * counts, so each count stops at `cap`: `capped` means "at least `rows`".
   */
  tableCounts(cap = TABLE_COUNT_CAP): Array<{ name: string; rows: number; capped: boolean }> {
    return this.listTables().map((name) => ({ name, ...this.countRows(name, cap) }));
  }

  /** Rows in one user table, counting at most `cap` (and reading at most `cap + 1` rows). */
  countRows(table: string, cap = TABLE_COUNT_CAP): { rows: number; capped: boolean } {
    if (!this.listTables().includes(table)) throw new UnknownTableError(table);
    const max = Math.max(1, Math.floor(cap));
    const n = Number(this.sql.exec(`SELECT count(*) AS n FROM (SELECT 1 FROM ${quoteIdent(table)} LIMIT ?)`, [max + 1])[0]?.n ?? 0);
    return { rows: Math.min(n, max), capped: n > max };
  }

  /**
   * Read rows from a user table for the table browser and exports.
   * Page with `offset`, or with `cursor` (pass `""` for the first page, then
   * the returned `next`): keyset paging on the rowid, so each page reads only
   * its own rows. Tables without a rowid fall back to offsets inside the cursor.
   */
  readTable(
    table: string,
    opts: { limit?: number; offset?: number; cursor?: string } = {},
  ): { columns: string[]; rows: Row[]; next?: string | null } {
    if (!this.listTables().includes(table)) throw new UnknownTableError(table);
    const quoted = quoteIdent(table);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 10_000);
    const columns = this.sql.exec(`SELECT name FROM pragma_table_info(?)`, [table]).map((r) => String(r.name));
    if (opts.cursor === undefined) {
      const rows = this.sql.exec(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, [limit, Math.max(opts.offset ?? 0, 0)]);
      return { columns, rows };
    }
    const offsetPage = (offset: number) => {
      const rows = this.sql.exec(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, [limit, offset]);
      return { columns, rows, next: rows.length === limit ? `o${offset + limit}` : null };
    };
    if (opts.cursor.startsWith("o")) return offsetPage(Math.max(Number(opts.cursor.slice(1)) || 0, 0));
    // A rowid alias the table doesn't shadow with a real column.
    const lower = new Set(columns.map((c) => c.toLowerCase()));
    const alias = ["rowid", "_rowid_", "oid"].find((a) => !lower.has(a));
    if (!alias || lower.has(CURSOR_COLUMN)) return offsetPage(0);
    const after = opts.cursor.startsWith("r") ? opts.cursor.slice(1) : "";
    if (after && !/^-?\d+$/.test(after)) throw new Error("Invalid table cursor");
    let rows: Row[];
    try {
      rows = this.sql.exec(
        `SELECT CAST(${alias} AS TEXT) AS ${CURSOR_COLUMN}, * FROM ${quoted}${after ? ` WHERE ${alias} > CAST(? AS INTEGER)` : ""} ORDER BY ${alias} LIMIT ?`,
        after ? [after, limit] : [limit],
      );
    } catch {
      return offsetPage(0); // WITHOUT ROWID table
    }
    const last = rows.at(-1)?.[CURSOR_COLUMN];
    for (const r of rows) delete r[CURSOR_COLUMN];
    return { columns, rows, next: rows.length === limit && last != null ? `r${String(last)}` : null };
  }
}

/** Where a table count stops (rows read per table, per listing). */
export const TABLE_COUNT_CAP = 10_000;
const CURSOR_COLUMN = "__actuate_cursor";
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export class UnknownTableError extends Error {
  constructor(readonly table: string) {
    super(`Unknown table "${table}"`);
    this.name = "UnknownTableError";
  }
}

function toRunRecord(row: Row): RunRecord {
  return {
    runId: String(row.run_id),
    status: row.status as RunStatus,
    trigger: fromJson<Trigger>(row.trigger_json as string),
    input: fromJson(row.input_json as string),
    output: fromJson((row.output_json as string | null) ?? null),
    error: fromJson<SerializedError | null>((row.error_json as string | null) ?? null),
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    wakeAt: (row.wake_at as number | null) ?? null,
    passes: Number(row.passes),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Time-sortable, URL-safe run ID: `run_` + 12 hex chars of ms timestamp + 16 random hex chars. */
export function newRunId(now = Date.now()): string {
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  return `run_${now.toString(16).padStart(12, "0")}${[...rand].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export { approvalEventKey };
