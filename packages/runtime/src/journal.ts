import type { Json, Row, SqlValue, Trigger, WaitForApprovalOptions } from "@actuate/sdk";

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
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { name: "Error", message: String(err) };
}

export function toJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

export function fromJson<T = Json>(text: string | null): T {
  return (text === null ? null : JSON.parse(text)) as T;
}
