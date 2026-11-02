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
