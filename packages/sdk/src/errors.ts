/** Thrown by the host when a run must pause. Never catch it in actuator code. */
export class SuspendSignal extends Error {
  readonly __actuateSuspend = true;
  constructor(readonly reason: string) {
    super(`Actuate run suspended: ${reason}. Do not catch this error.`);
    this.name = "SuspendSignal";
  }
}

export function isSuspendSignal(err: unknown): err is SuspendSignal {
  return typeof err === "object" && err !== null && (err as { __actuateSuspend?: unknown }).__actuateSuspend === true;
}

/** Thrown when an actuator breaks one of the SDK's rules (duplicate step names, nested steps, undeclared capabilities). */
export class ActuatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActuatorError";
  }
}

/** Thrown by a step to stop retrying immediately and fail the run. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * Thrown when a provider's API does not offer an operation: `ctx.payment.refund` on a payment provider with no
 * refund API, for example. A `NonRetryableError`: retrying the step would not change the answer, so the step
 * fails at once whatever its `retries`.
 */
export class NotSupportedError extends NonRetryableError {
  constructor(
    /** The provider's name, as it should read in the message ("Billplz"). */
    readonly provider: string,
    /** The operation that isn't offered ("refund"). */
    readonly operation: string,
  ) {
    super(`${operation} is not supported by ${provider}`);
    this.name = "NotSupportedError";
  }
}

/** What a `ToolError` code looks like: `CARD_DECLINED`, `ORDER_NOT_FOUND`. Upper-case letters, digits and underscores, at most 64 characters. */
export const TOOL_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Longest `ToolError` details kept with the run, in characters of JSON. Larger details are dropped, not cut. */
export const TOOL_ERROR_MAX_DETAILS = 4_096;

export interface ToolErrorOptions {
  /**
   * Whether the caller may make the same call again later and expect a different result, with nobody changing
   * anything in between (a downstream service was busy). Default `false`: an agent should not loop on the call.
   * This is advice to the caller. It does not make the step retry: use the step's `retries` for that.
   */
  retryable?: boolean;
  /** Small, JSON-serialisable facts the caller can act on (`{ limit: 500 }`). Secret config values in it are redacted. */
  details?: unknown;
  cause?: unknown;
}

/**
 * Fail the run with an error the caller can act on: a code of your choosing, a message, and whether calling
 * again may help. Throw it from `run`, inside or outside a step.
 *
 * ```ts
 * if (order.refunded) throw new ToolError("ALREADY_REFUNDED", `Order ${input.orderId} was refunded on ${order.refundedAt}.`);
 * ```
 *
 * The run ends `FAILED` and its error carries `code`, `retryable` and `details` next to the message, wherever
 * the run is read. Thrown inside `ctx.step.do`, it fails the step at once: the step's `retries` are not used,
 * because your code has already decided the outcome. Throw an ordinary `Error` for a failure worth retrying.
 *
 * For an outcome that is not a failure ("no such order"), prefer returning it in the output: a failed run is
 * shown as failed and alerts its owner.
 */
export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: string, message: string, options: ToolErrorOptions = {}) {
    if (typeof code !== "string" || !TOOL_ERROR_CODE.test(code)) {
      throw new TypeError(
        `ToolError: the code must be upper-case letters, digits and underscores, starting with a letter, at most 64 characters (e.g. "CARD_DECLINED"); got ${JSON.stringify(code)}.`,
      );
    }
    super(typeof message === "string" && message ? message : code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolError";
    this.code = code;
    this.retryable = options.retryable === true;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * The code, retryable flag and details of a `ToolError`, or null for anything else. Goes by shape (the name
 * `ToolError` and a well-formed code), not by `instanceof`: an actuator's bundle can carry its own copy of this
 * package, and a step's failure met again on replay is a stand-in for the original error, with its name and
 * code. An error that crossed a Workers RPC boundary keeps its name and properties only from compatibility date
 * 2026-04-21 (`enhanced_error_serialization`); before that it arrives as a plain `Error` and is not recognised.
 */
export function toolErrorInfo(err: unknown): { code: string; retryable: boolean; details?: unknown } | null {
  if (typeof err !== "object" || err === null) return null;
  const { name, code, retryable, details } = err as { name?: unknown; code?: unknown; retryable?: unknown; details?: unknown };
  if (name !== "ToolError" || typeof code !== "string" || !TOOL_ERROR_CODE.test(code)) return null;
  return { code, retryable: retryable === true, ...(details === undefined ? {} : { details }) };
}

/**
 * Whether an error thrown in a step ends it without using its retries: a `NonRetryableError` (a
 * `NotSupportedError` is one) or a `ToolError`. By name as well as by class, for the reasons `toolErrorInfo` gives.
 */
export function isNonRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError || err instanceof ToolError) return true;
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === "NonRetryableError" || name === "NotSupportedError" || toolErrorInfo(err) !== null;
}
