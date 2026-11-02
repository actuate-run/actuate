import type { Json, Row, SqlValue, Trigger, WaitForApprovalOptions } from "@actuate/sdk";
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
}

export interface StartRunOptions {
  input: Json;
  trigger: Trigger;
  /** A retried request with the same key returns the first run instead of starting another. */
  idempotencyKey?: string;
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
    if (opts.idempotencyKey) {
      const existing = this.sql.exec(`SELECT run_id FROM _actuate_runs WHERE idempotency_key = ?`, [opts.idempotencyKey])[0];
      if (existing) {
        const runId = String(existing.run_id);
        await this.locks.get(runId); // a concurrent duplicate waits for the first pass to settle
        return { run: this.getRun(runId)!, created: false };
      }
    }
    const runId = opts.runId ?? newRunId();
    const now = this.now();
    this.sql.exec(
      `INSERT INTO _actuate_runs (run_id, status, trigger_json, input_json, idempotency_key, created_at, updated_at)
       VALUES (?, 'RUNNING', ?, ?, ?, ?, ?)`,
      [runId, toJson(opts.trigger), toJson(opts.input), opts.idempotencyKey ?? null, now, now],
    );
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
        [toJson(outcome.error), passes, now, runId],
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
    extra: { note?: string; text?: string } = {},
  ): Promise<{ ok: true; runId: string; step: string; approved: boolean } | { ok: false; reason: string }> {
    const claims = await verifyApproval(this.options.approvalSecret, token, this.now());
    if (!claims) return { ok: false, reason: "This link is invalid or has expired." };
    if (claims.d === 2) return this.answerDirect(claims.r, claims.s, extra.text ?? "");
    return this.decideDirect(claims.r, claims.s, claims.d === 1, extra.note);
  }

  /** Approve or reject a waiting step directly (e.g. from an authenticated dashboard). */
  async decideDirect(
    runId: string,
    step: string,
    approved: boolean,
    note?: string,
  ): Promise<{ ok: true; runId: string; step: string; approved: boolean } | { ok: false; reason: string }> {
    const row = this.sql.exec(
      `SELECT status FROM _actuate_steps WHERE run_id = ? AND step_name = ? AND status = 'WAITING_APPROVAL'`,
      [runId, step],
    )[0];
    if (!row) return { ok: false, reason: "This approval has already been decided or has expired." };
    const trimmed = note?.trim().slice(0, 2_000);
    const result: Json = { approved, at: new Date(this.now()).toISOString(), ...(trimmed ? { note: trimmed } : {}) };
    this.completeWait(runId, step, result);
    await this.execute(runId);
    return { ok: true, runId, step, approved };
  }

  /** Answer a step waiting in waitForInput. */
  async answerDirect(
    runId: string,
    step: string,
    text: string,
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
    this.completeWait(runId, step, { text: answer, at: new Date(this.now()).toISOString() });
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
    const data = fromJson<Record<string, unknown>>(row.output_json as string) ?? {};
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
      putStep: async (row) => {
        this.sql.exec(
          `INSERT INTO _actuate_steps (run_id, step_name, status, output_json, wake_at, event, attempts, error, seq, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id, step_name) DO UPDATE SET status = excluded.status, output_json = excluded.output_json,
             wake_at = excluded.wake_at, event = excluded.event, attempts = excluded.attempts, error = excluded.error,
             updated_at = excluded.updated_at`,
          [runId, row.step_name, row.status, row.output_json, row.wake_at, row.event, row.attempts, row.error, ++this.seq + this.now() * 1000, this.now()],
        );
      },
      consumeEvent: async (event) => this.takeBufferedEvent(event),
      requestApproval: (step, opts) => this.requestApproval(runId, step, opts),
      query: async (sql, params) => this.sql.exec(sql, params as SqlValue[]),
      migrate: async (statements) => {
        this.sql.transaction(() => {
          const applied = Number(this.sql.exec(`SELECT COALESCE(MAX(idx), -1) AS idx FROM _actuate_migrations`)[0]?.idx ?? -1);
          statements.forEach((statement, idx) => {
            if (idx <= applied) return;
            this.sql.exec(statement);
            this.sql.exec(`INSERT INTO _actuate_migrations (idx, statement, applied_at) VALUES (?, ?, ?)`, [idx, statement, this.now()]);
          });
        });
      },
      log: (level, message, data) => this.writeLog(runId, level, message, data),
    };
  }

  private readonly logBuffers = new Map<string, LogRecord[]>();

  /** Lines are held per run and written as one row when the pass settles. */
  private bufferLog(runId: string, level: LogLevel, message: string, data?: Json): void {
    let lines = this.logBuffers.get(runId);
    if (!lines) this.logBuffers.set(runId, (lines = []));
    const max = this.options.maxLogLinesPerPass ?? 100;
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
      ...(opts.message ? { message: opts.message } : {}),
      ...(opts.notify ? { notify: opts.notify } : {}),
    };
    // Never log the links: run logs are readable by anything holding a run token (e.g. the agent being gated).
    await this.writeLog(runId, "info", `Approval requested for "${step}"`, { step, expiresAt: opts.expiresAt });
    try {
      await this.options.notifyApproval?.(request);
    } catch (err) {
      await this.writeLog(runId, "error", `Could not deliver approval link for "${step}"`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------- reads

  getRun(runId: string): RunRecord | null {
    const row = this.sql.exec(`SELECT * FROM _actuate_runs WHERE run_id = ?`, [runId])[0];
    return row ? toRunRecord(row) : null;
  }

  /**
   * Newest first. Page with `before`: a run ID (exact, no ties) or a createdAt
   * timestamp. Run IDs are time-sortable, so the primary key orders the list.
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
    return rows.map(toRunRecord);
  }

  getSteps(runId: string): StepRecord[] {
    return this.sql.exec(`SELECT * FROM _actuate_steps WHERE run_id = ? ORDER BY seq`, [runId]).map((r) => ({
      name: String(r.step_name),
      status: r.status as StepRow["status"],
      output: fromJson((r.output_json as string | null) ?? null),
      wakeAt: (r.wake_at as number | null) ?? null,
      event: (r.event as string | null) ?? null,
      attempts: Number(r.attempts),
      error: (r.error as string | null) ?? null,
      updatedAt: Number(r.updated_at),
    }));
  }

  getLogs(runId: string, limit = 500): LogRecord[] {
    const rows = this.sql.exec(`SELECT lines_json FROM _actuate_logs WHERE run_id = ? ORDER BY pass`, [runId]);
    const persisted = rows.flatMap((r) => fromJson<LogRecord[]>(r.lines_json as string));
    return [...persisted, ...(this.logBuffers.get(runId) ?? [])].slice(0, limit);
  }

  /** Steps waiting for a human decision, oldest first: the approval queue. */
  pendingApprovals(): Array<{ runId: string; step: string; kind: "approval" | "input"; message: string | null; expiresAt: number | null; since: number }> {
    return this.sql
      .exec(
        `SELECT run_id, step_name, status, output_json, wake_at, updated_at FROM _actuate_steps WHERE status IN ('WAITING_APPROVAL', 'WAITING_INPUT') ORDER BY updated_at`,
      )
      .map((r) => ({
        runId: String(r.run_id),
        step: String(r.step_name),
        kind: r.status === "WAITING_INPUT" ? ("input" as const) : ("approval" as const),
        message: (() => {
          const d = fromJson<{ message?: string | null; prompt?: string | null } | null>((r.output_json as string | null) ?? null);
          return d?.message ?? d?.prompt ?? null;
        })(),
        expiresAt: (r.wake_at as number | null) ?? null,
        since: Number(r.updated_at),
      }));
  }

  /** User tables in this actuator's database (excluding runtime and SQLite internals). */
  listTables(): string[] {
    return this.sql
      .exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_actuate\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
      )
      .map((r) => String(r.name));
  }

  /** Read rows from a user table for the table browser and exports. */
  readTable(table: string, opts: { limit?: number; offset?: number } = {}): { columns: string[]; rows: Row[] } {
    if (!this.listTables().includes(table)) throw new UnknownTableError(table);
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const columns = this.sql.exec(`SELECT name FROM pragma_table_info(?)`, [table]).map((r) => String(r.name));
    const rows = this.sql.exec(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, [
      Math.min(Math.max(opts.limit ?? 100, 1), 10_000),
      Math.max(opts.offset ?? 0, 0),
    ]);
    return { columns, rows };
  }
}

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
