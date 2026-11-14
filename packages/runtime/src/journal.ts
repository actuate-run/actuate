import { TOOL_ERROR_CODE, TOOL_ERROR_MAX_DETAILS, toolErrorInfo, type DbStatement, type Json, type Row, type SqlValue, type Trigger, type WaitForApprovalOptions } from "@actuate/sdk";

export type StepStatus =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "RETRYING"
  | "SLEEPING"
  | "WAITING_EVENT"
  | "WAITING_APPROVAL"
  | "WAITING_INPUT";

export interface StepRow {
  run_id: string;
  step_name: string;
  status: StepStatus;
  output_json: string | null;
  /** Epoch milliseconds at which a sleeping, retrying or waiting step wakes. */
  wake_at: number | null;
  /** Event key for WAITING_EVENT and WAITING_APPROVAL steps. */
  event: string | null;
  attempts: number;
  error: string | null;
  /**
   * For a FAILED step, the JSON of a {@link StepErrorInfo}: what kind of error failed it, so that a replay which
   * reaches the step again throws the same kind as the pass that ran it. Absent on rows written before 0.6, and
   * dropped by a host whose runtime predates it; the replay then throws a plain `StepFailedError`, as it always did.
   */
  error_json?: string | null;
}

/** What is kept of the error that failed a step, besides its message (`StepRow.error`). */
export interface StepErrorInfo {
  name: string;
  /** A `ToolError`'s code, retryable flag and details. */
  code?: string;
  retryable?: boolean;
  details?: Json;
}

/** The {@link StepErrorInfo} of an error thrown in a step. */
export function stepErrorInfo(err: unknown): StepErrorInfo {
  const { name, code, retryable, details } = serializeError(err);
  return { name, ...(code === undefined ? {} : { code, retryable: retryable === true }), ...(details === undefined ? {} : { details }) };
}

/** Read a stored {@link StepErrorInfo}; null when there is none or it is not one. */
export function parseStepErrorInfo(text: string | null | undefined): StepErrorInfo | null {
  if (typeof text !== "string" || !text) return null;
  try {
    const value = JSON.parse(text) as Partial<StepErrorInfo> | null;
    if (!value || typeof value !== "object" || typeof value.name !== "string" || !value.name) return null;
    return {
      name: value.name,
      ...(typeof value.code === "string" ? { code: value.code, retryable: value.retryable === true } : {}),
      ...(value.details === undefined ? {} : { details: value.details }),
    };
  } catch {
    return null;
  }
}

export type LogLevel = "info" | "warn" | "error";

/**
 * Everything one execution pass needs from storage, scoped to a single run.
 * The single-tenant runtime implements it in-process over SQLite; the hosted
 * platform implements it as an RPC stub to the host Durable Object.
 */
export interface Journal {
  loadSteps(): Promise<StepRow[]>;
  putStep(row: StepRow): Promise<void>;
  /** Take the oldest buffered event with this key, if one arrived before anyone waited for it. */
  consumeEvent(event: string): Promise<{ payload: Json } | null>;
  /** Issue signed approve/reject links and notify the approver. Called once, when the wait starts. */
  requestApproval(stepName: string, options: WaitForApprovalOptions & { expiresAt: number; kind?: "approval" | "input" }): Promise<void>;
  query(sql: string, params: readonly SqlValue[]): Promise<Row[]>;
  /**
   * `ctx.db.batch`: run the statements in one synchronous transaction, all or nothing, and return each one's rows.
   * Optional so journals written against earlier versions still type-check; `ctx.db.batch` throws without it.
   */
  batch?(statements: readonly DbStatement[]): Promise<Row[][]>;
  /**
   * `ctx.db.commitWithStep`: apply the statements and write the step row in one synchronous transaction.
   * If a statement fails, neither the statements nor the row are written. Optional, like `batch`.
   */
  commitStep?(row: StepRow, statements: readonly DbStatement[]): Promise<void>;
  migrate(statements: readonly string[]): Promise<void>;
  log(level: LogLevel, message: string, data?: Json): Promise<void>;
}

export interface PassLimits {
  /** Longest sleep or wait. Sleeps beyond it fail; waits time out at it (resolve to null). */
  maxWaitMs?: number;
  /** Retries a step may ask for; larger values are clamped. Default 10. */
  maxRetries?: number;
}

export interface PassRequest {
  runId: string;
  input: Json;
  trigger: Trigger;
  now?: () => number;
  limits?: PassLimits;
}

export type PassOutcome =
  | { status: "completed"; output: Json }
  | { status: "waiting" }
  | { status: "failed"; error: SerializedError };

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  /** Set when the actuator threw a `ToolError`: the code it chose. */
  code?: string;
  /** With `code`: whether the caller may make the same call again later. */
  retryable?: boolean;
  /** With `code`: the error's details, when it had any that fit (see `TOOL_ERROR_MAX_DETAILS`). */
  details?: Json;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}), ...toolErrorFields(err) };
  }
  // Something thrown that is not an Error but is shaped like a ToolError: the step treats it as one
  // (isNonRetryable goes by shape), so the stored error does too.
  const info = toolErrorInfo(err);
  if (info) {
    const message = (err as { message?: unknown }).message;
    return { name: "ToolError", message: typeof message === "string" && message ? message : info.code, ...toolErrorFields(err) };
  }
  return { name: "Error", message: String(err) };
}

/** The code a stored error gets when redaction changed its own: the code held a secret config value. */
export const REDACTED_TOOL_ERROR_CODE = "REDACTED";

/** After redaction: a code that is no longer a well-formed code (it held a secret) becomes `REDACTED`, so it still reads as a code. */
export function keepCodeWellFormed<T extends { code?: unknown }>(error: T): T {
  return typeof error.code === "string" && !TOOL_ERROR_CODE.test(error.code) ? { ...error, code: REDACTED_TOOL_ERROR_CODE } : error;
}

/** A `ToolError`'s code, retryable flag and details, as they are stored with the run. */
function toolErrorFields(err: unknown): Pick<SerializedError, "code" | "retryable" | "details"> {
  const info = toolErrorInfo(err);
  if (!info) return {};
  const fields: Pick<SerializedError, "code" | "retryable" | "details"> = { code: info.code, retryable: info.retryable };
  if (info.details !== undefined) {
    // Details that can't be stored (a cycle, a BigInt) or are too large are left out; the code and message stand.
    try {
      const encoded = JSON.stringify(info.details);
      if (encoded !== undefined && encoded.length <= TOOL_ERROR_MAX_DETAILS) fields.details = JSON.parse(encoded) as Json;
    } catch {
      // not serialisable
    }
  }
  return fields;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

export function fromJson<T = Json>(text: string | null): T {
  return (text === null ? null : JSON.parse(text)) as T;
}
