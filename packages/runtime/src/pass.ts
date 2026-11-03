import {
  ActuatorError,
  NonRetryableError,
  SuspendSignal,
  isSuspendSignal,
  parseDuration,
  type Actuator,
  type ApprovalResult,
  type BaseContext,
  type Capability,
  type Db,
  type DbStatement,
  type Duration,
  type Json,
  type Logger,
  type Providers,
  type Row,
  type SqlValue,
  type Step,
  type StepInfo,
  type StepOptions,
  type InputResult,
  type WaitForApprovalOptions,
  type WaitForEventOptions,
  type WaitForInputOptions,
} from "@actuate/sdk";
import { fromJson, serializeError, toJson, type Journal, type PassOutcome, type PassRequest, type StepRow } from "./journal.js";

export const DEFAULT_APPROVAL_TIMEOUT = "7 days";
const RESERVED_TABLE = /\b_actuate_/i;
/**
 * A batch is already one transaction: a statement that opened, ended or nested one would break that
 * (Durable Objects refuse them anyway; node:sqlite would commit half a batch). Leading comments are skipped.
 */
const TRANSACTION_CONTROL = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:begin|commit|end|rollback|savepoint|release)\b/i;
/** Longest idempotency key handed to a provider: Stripe's limit (Resend allows 256). */
const MAX_IDEMPOTENCY_KEY = 255;

/**
 * Provider methods that take an idempotency key, and where: `messaging.send(to, text, options)` in its
 * options (argument 2); `payment.createBill(request)` and `payment.refund(request)` in the request (argument 0).
 * `payment.getBill` only reads, and `llm.complete` and `http.fetch` have no key field (no LLM API this
 * runtime has adapters for deduplicates; an HTTP call's headers are the caller's to set).
 */
const KEYED_METHODS: Partial<Record<Capability, Record<string, number>>> = {
  messaging: { send: 2 },
  payment: { createBill: 0, refund: 0 },
};

/** Thrown on replay when a step that failed permanently is reached again. */
export class StepFailedError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = "StepFailedError";
  }
}

export interface PassDependencies {
  journal: Journal;
  /** Parsed configuration (already validated against the actuator's ConfigSchema). */
  config: unknown;
  /** Configured providers. Declared capabilities missing here throw on use. */
  providers?: Partial<Providers>;
}

/**
 * Execute one pass of a run: call `run` from the top, replaying completed
 * steps from the journal, until it returns, throws or suspends.
 */
export async function executePass(
  actuator: Actuator,
  request: PassRequest,
  deps: PassDependencies,
): Promise<PassOutcome> {
  const pass = new Pass(actuator, request, deps.journal, await deps.journal.loadSteps());
  const ctx: BaseContext & Partial<Providers> = {
    runId: request.runId,
    actuator: actuator.name,
    trigger: request.trigger,
    step: pass.step,
    db: pass.db,
    log: pass.log,
  };
  for (const cap of actuator.capabilities ?? []) {
    Object.defineProperty(ctx, cap, { value: pass.guardProvider(cap, deps.providers?.[cap]), enumerable: true });
  }
  // Optional capabilities are undefined when no provider is configured, so `ctx.messaging?.send(...)` skips cleanly.
  for (const cap of actuator.optionalCapabilities ?? []) {
    const provider = deps.providers?.[cap];
    Object.defineProperty(ctx, cap, { value: provider ? pass.guardProvider(cap, provider) : undefined, enumerable: true });
  }

  try {
    const result = await actuator.run(ctx as never, request.input as never, deps.config as never);
    if (pass.suspended) return { status: "waiting" };
    let output: unknown = result;
    if (actuator.output) {
      const parsed = actuator.output.safeParse(result);
      if (!parsed.success) throw new ActuatorError(`Run output does not match the output schema: ${parsed.error.message}`);
      output = parsed.data;
    }
    return { status: "completed", output: fromJson(toJson(output)) };
  } catch (err) {
    // A suspend signal that user code caught and swallowed still suspends the run.
    if (pass.suspended || isSuspendSignal(err)) return { status: "waiting" };
    return { status: "failed", error: serializeError(err) };
  }
}

class Pass {
  suspended = false;
  private inStep: string | null = null;
  /** The running step's idempotency key, and how many calls each keyed provider method has had in this attempt. */
  private stepKey: string | null = null;
  private keyedCalls = new Map<string, number>();
  /** Statements `ctx.db.commitWithStep` queued during the running step's attempt. */
  private stepWrites: DbStatement[] = [];
  private readonly seen = new Set<string>();
  private readonly rows = new Map<string, StepRow>();
  private sleepCounter = 0;
  private readonly now: () => number;

  constructor(
    private readonly actuator: Actuator,
    private readonly request: PassRequest,
    private readonly journal: Journal,
    rows: StepRow[],
  ) {
    for (const row of rows) this.rows.set(row.step_name, row);
    this.now = request.now ?? Date.now;
  }

  private suspend(reason: string): never {
    this.suspended = true;
    throw new SuspendSignal(reason);
  }

  /** Common guards for every `ctx.step.*` call. */
  private enter(kind: string, name: string): void {
    if (this.suspended) this.suspend("run already suspended");
    if (typeof name !== "string" || name.length === 0 || name.length > 200) {
      throw new ActuatorError(`ctx.step.${kind}: step name must be a non-empty string of at most 200 characters.`);
    }
    if (this.inStep !== null) {
      throw new ActuatorError(`ctx.step.${kind}("${name}") was called inside step "${this.inStep}". Steps cannot be nested.`);
    }
    if (this.seen.has(name)) {
      throw new ActuatorError(
        `Step name "${name}" was used twice in one run. Step names must be unique per run; in a loop, include the index (e.g. \`remind-\${i}\`).`,
      );
    }
    this.seen.add(name);
  }

  private async write(row: StepRow): Promise<void> {
    this.rows.set(row.step_name, row);
    await this.journal.putStep(row);
  }

  private row(name: string, patch: Partial<StepRow>): StepRow {
    const existing = this.rows.get(name);
    return {
      run_id: this.request.runId,
      step_name: name,
      status: "RUNNING",
      output_json: null,
      wake_at: null,
      event: null,
      attempts: 0,
      error: null,
      ...existing,
      ...patch,
    };
  }

  readonly step: Step = {
    do: (async <T>(
      name: string,
      optionsOrFn: StepOptions | ((info: StepInfo) => T | Promise<T>),
      maybeFn?: (info: StepInfo) => T | Promise<T>,
    ): Promise<T> => {
      const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
      const options: StepOptions = typeof optionsOrFn === "function" ? {} : optionsOrFn;
      if (typeof fn !== "function") throw new ActuatorError(`ctx.step.do("${name}") needs a function.`);
      this.enter("do", name);

      const existing = this.rows.get(name);
      if (existing?.status === "COMPLETED") return fromJson(existing.output_json) as T;
      if (existing?.status === "FAILED") throw new StepFailedError(name, existing.error ?? "Step failed");
      if (existing?.status === "RETRYING" && existing.wake_at !== null && existing.wake_at > this.now()) {
        this.suspend(`step "${name}" waiting to retry`);
      }

      const attempt = (existing?.attempts ?? 0) + 1;
      // Steps that can retry record the attempt before running, so a crash mid-step still counts it.
      // Others are written once, on completion: half the billed writes.
      if (Math.min(options.retries ?? 0, this.request.limits?.maxRetries ?? 10) > 0) {
        await this.write(this.row(name, { status: "RUNNING", attempts: attempt, wake_at: null }));
      }

      const failed = async (err: unknown): Promise<never> => {
        if (isSuspendSignal(err)) throw err;
        const retries = Math.min(options.retries ?? 0, this.request.limits?.maxRetries ?? 10);
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof NonRetryableError || attempt > retries) {
          await this.write(this.row(name, { status: "FAILED", error: message, attempts: attempt }));
          throw err;
        }
        const backoff = parseDuration(options.backoff ?? "1 second") * 2 ** (attempt - 1);
        await this.write(this.row(name, { status: "RETRYING", error: message, attempts: attempt, wake_at: this.now() + backoff }));
        await this.journal.log("warn", `Step "${name}" failed on attempt ${attempt}; retrying in ${backoff} ms`, { error: message });
        this.suspend(`step "${name}" retrying`);
      };

      let result: T;
      const idempotencyKey = `${this.request.runId}:${name}`;
      this.inStep = name;
      // Per attempt: a retry derives the same provider keys in the same order, and starts with no queued writes.
      this.stepKey = idempotencyKey;
      this.keyedCalls = new Map();
      this.stepWrites = [];
      try {
        result = await fn({ idempotencyKey, attempt, now: this.now() });
      } catch (err) {
        this.inStep = null;
        return failed(err);
      } finally {
        this.inStep = null;
        this.stepKey = null;
      }

      const output = toJson(result);
      const done = this.row(name, { status: "COMPLETED", output_json: output, error: null, attempts: attempt });
      const writes = this.stepWrites;
      this.stepWrites = [];
      if (writes.length === 0) {
        await this.write(done);
      } else {
        // The queued writes and the COMPLETED row commit together, or neither does.
        if (typeof this.journal.commitStep !== "function") {
          return failed(new NonRetryableError("ctx.db.commitWithStep is not supported by this host yet (its runtime predates it). Nothing was written."));
        }
        try {
          await this.journal.commitStep(done, writes);
        } catch (err) {
          return failed(unsupportedByHost(err, "ctx.db.commitWithStep", true));
        }
        this.rows.set(name, done);
      }
      // Return the JSON round-trip so the first pass and every replay see the same value.
      return fromJson(output) as T;
    }) as Step["do"],

    sleep: async (nameOrDuration: string | Duration, maybeDuration?: Duration): Promise<void> => {
      const named = maybeDuration !== undefined;
      const name = named ? (nameOrDuration as string) : `sleep#${++this.sleepCounter}`;
      const ms = parseDuration((named ? maybeDuration : nameOrDuration) as Duration);
      this.checkSleep(name, ms);
      await this.sleepStep("sleep", name, () => this.now() + ms);
    },

    sleepUntil: async (name: string, until: Date | number): Promise<void> => {
      const at = typeof until === "number" ? until : until.getTime();
      if (!Number.isFinite(at)) throw new ActuatorError(`ctx.step.sleepUntil("${name}"): invalid date.`);
      if (!this.rows.has(name)) this.checkSleep(name, at - this.now());
      await this.sleepStep("sleepUntil", name, () => at);
    },

    waitForEvent: async <T = Json>(name: string, options: WaitForEventOptions): Promise<T | null> => {
      if (!options?.event) throw new ActuatorError(`ctx.step.waitForEvent("${name}") needs an event key.`);
      this.enter("waitForEvent", name);
      const existing = this.rows.get(name);
      const resolved = await this.resolveWait(name, existing);
      if (resolved !== undefined) return resolved as T | null;

      const buffered = await this.journal.consumeEvent(options.event);
      if (buffered) {
        await this.write(this.row(name, { status: "COMPLETED", event: options.event, output_json: toJson(buffered.payload) }));
        return buffered.payload as T;
      }
      if (options.timeout !== undefined && options.until !== undefined) {
        throw new ActuatorError(`ctx.step.waitForEvent("${name}"): use timeout or until, not both.`);
      }
      let timeoutMs: number | null = options.timeout === undefined ? null : parseDuration(options.timeout);
      if (options.until !== undefined) {
        const at = typeof options.until === "number" ? options.until : options.until.getTime();
        if (!Number.isFinite(at)) throw new ActuatorError(`ctx.step.waitForEvent("${name}"): invalid until.`);
        timeoutMs = Math.max(0, at - this.now());
      }
      const wakeAt = this.waitDeadline(name, timeoutMs);
      await this.write(this.row(name, { status: "WAITING_EVENT", event: options.event, wake_at: wakeAt }));
      this.suspend(`waiting for event "${options.event}"`);
    },

    waitForApproval: async (name: string, options: WaitForApprovalOptions = {}): Promise<ApprovalResult | null> => {
      this.enter("waitForApproval", name);
      const existing = this.rows.get(name);
      const resolved = await this.resolveWait(name, existing);
      if (resolved !== undefined) return resolved as ApprovalResult | null;

      const expiresAt = this.waitDeadline(name, parseDuration(options.timeout ?? DEFAULT_APPROVAL_TIMEOUT))!;
      await this.write(
        // While waiting, output_json holds the request so the approval queue can show what is being approved.
        this.row(name, {
          status: "WAITING_APPROVAL",
          event: approvalEventKey(this.request.runId, name),
          wake_at: expiresAt,
          output_json: toJson({ message: options.message ?? null }),
        }),
      );
      await this.journal.requestApproval(name, { ...options, expiresAt, kind: "approval" });
      this.suspend(`waiting for approval "${name}"`);
    },

    waitForInput: async (name: string, options: WaitForInputOptions): Promise<InputResult | null> => {
      if (!options?.prompt) throw new ActuatorError(`ctx.step.waitForInput("${name}") needs a prompt.`);
      this.enter("waitForInput", name);
      const existing = this.rows.get(name);
      const resolved = await this.resolveWait(name, existing);
      if (resolved !== undefined) return resolved as InputResult | null;

      const expiresAt = this.waitDeadline(name, parseDuration(options.timeout ?? DEFAULT_APPROVAL_TIMEOUT))!;
      const maxLength = Math.min(Math.max(options.maxLength ?? 4_000, 1), 20_000);
      await this.write(
        this.row(name, {
          status: "WAITING_INPUT",
          event: approvalEventKey(this.request.runId, name),
          wake_at: expiresAt,
          output_json: toJson({ prompt: options.prompt, initial: options.initial ?? null, maxLength }),
        }),
      );
      await this.journal.requestApproval(name, {
        expiresAt,
        kind: "input",
        message: options.prompt,
        ...(options.notify ? { notify: options.notify } : {}),
      });
      this.suspend(`waiting for input "${name}"`);
    },
  };

  /** Sleeps longer than the plan allows fail loudly rather than silently waking early. */
  private checkSleep(name: string, ms: number): void {
    const max = this.request.limits?.maxWaitMs;
    if (max !== undefined && ms > max && !this.rows.has(name)) {
      throw new ActuatorError(`Step "${name}" sleeps ${Math.round(ms / 1000)}s, longer than this plan allows (${Math.round(max / 1000)}s).`);
    }
  }

  /** A wait's wake time: its timeout, clamped to the plan's longest wait (waits with no timeout get the maximum). */
  private waitDeadline(name: string, timeoutMs: number | null): number | null {
    const max = this.request.limits?.maxWaitMs;
    if (max === undefined) return timeoutMs === null ? null : this.now() + timeoutMs;
    // An explicit timeout beyond the plan's limit fails loudly; an open-ended wait gets the maximum.
    if (timeoutMs !== null && timeoutMs > max && !this.rows.has(name)) {
      throw new ActuatorError(`Step "${name}" waits ${Math.round(timeoutMs / 1000)}s, longer than this plan allows (${Math.round(max / 1000)}s).`);
    }
    return this.now() + Math.min(timeoutMs ?? max, max);
  }

  /**
   * For an existing wait row: return its result if it completed or timed out,
   * suspend if it is still waiting, or return `undefined` if there is no row.
   */
  private async resolveWait(name: string, existing: StepRow | undefined): Promise<Json | undefined> {
    if (!existing) return undefined;
    if (existing.status === "COMPLETED") return fromJson(existing.output_json);
    if (existing.wake_at !== null && existing.wake_at <= this.now()) {
      await this.write(this.row(name, { status: "COMPLETED", output_json: "null" }));
      return null;
    }
    this.suspend(`step "${name}" still waiting`);
  }

  private async sleepStep(kind: string, name: string, wakeAt: () => number): Promise<void> {
    this.enter(kind, name);
    const existing = this.rows.get(name);
    if (existing?.status === "COMPLETED") return;
    const at = existing?.wake_at ?? wakeAt();
    if (at <= this.now()) {
      await this.write(this.row(name, { status: "COMPLETED", wake_at: at, output_json: "null" }));
      return;
    }
    if (!existing) await this.write(this.row(name, { status: "SLEEPING", wake_at: at }));
    this.suspend(`sleeping until ${new Date(at).toISOString()}`);
  }

  readonly db: Db = {
    query: async <T extends object = Row>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> => {
      if (typeof sql !== "string") throw new ActuatorError("ctx.db.query: sql must be a string.");
      if (RESERVED_TABLE.test(sql)) throw new ActuatorError("Tables starting with _actuate_ are reserved for the runtime.");
      return (await this.journal.query(sql, params)) as T[];
    },
    first: async <T extends object = Row>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> => {
      const rows = await this.db.query<T>(sql, params);
      return rows[0] ?? null;
    },
    sql: async <T extends object = Row>(strings: TemplateStringsArray, ...values: SqlValue[]): Promise<T[]> => {
      if (!Array.isArray(strings) || !("raw" in strings)) {
        throw new ActuatorError("ctx.db.sql must be used as a tagged template: ctx.db.sql`SELECT ... ${value}`.");
      }
      return this.db.query<T>(strings.join("?"), values);
    },
    statement: (strings: TemplateStringsArray, ...values: SqlValue[]): DbStatement => {
      if (!Array.isArray(strings) || !("raw" in strings)) {
        throw new ActuatorError("ctx.db.statement must be used as a tagged template: ctx.db.statement`INSERT ... ${value}`.");
      }
      return { sql: strings.join("?"), params: values };
    },
    batch: async <T extends object = Row>(statements: readonly DbStatement[]): Promise<T[][]> => {
      const checked = checkStatements("batch", statements);
      if (checked.length === 0) return [];
      if (typeof this.journal.batch !== "function") {
        throw new ActuatorError("ctx.db.batch is not supported by this host yet (its runtime predates it). Nothing was written.");
      }
      try {
        return (await this.journal.batch(checked)) as T[][];
      } catch (err) {
        throw unsupportedByHost(err, "ctx.db.batch", false);
      }
    },
    commitWithStep: (statements: readonly DbStatement[]): void => {
      if (this.inStep === null) {
        throw new ActuatorError("ctx.db.commitWithStep() must be called inside ctx.step.do(...): its writes commit with that step.");
      }
      this.stepWrites.push(...checkStatements("commitWithStep", statements));
    },
    migrate: async (statements: readonly string[]): Promise<void> => {
      if (statements.some((s) => RESERVED_TABLE.test(s))) {
        throw new ActuatorError("Tables starting with _actuate_ are reserved for the runtime.");
      }
      await this.journal.migrate(statements);
    },
  };

  readonly log: Logger = {
    info: (message, data) => void this.journal.log("info", message, data),
    warn: (message, data) => void this.journal.log("warn", message, data),
    error: (message, data) => void this.journal.log("error", message, data),
  };

  /**
   * Give a keyed provider call (see KEYED_METHODS) the running step's key when the caller passed none.
   *
   * One step can call a provider several times (two messages, a bill then a refund), so the calls cannot share
   * the step's key: the provider would answer the second with the first's result. Each call gets
   * `<step key>:<method>:<n>`, `n` counting that method's calls in this attempt of the step from 0. Counting per
   * method keeps a call's key the same when a retry takes a different path through other methods (say, an
   * extra message on attempt 2 before the refund). The count is taken when the call is made, before any await,
   * so calls started together (Promise.all) are numbered in the order the code makes them. Calls with their
   * own key are counted too, so adding a key to one call does not renumber the others.
   */
  private withIdempotencyKey(method: string, at: number, args: unknown[]): Promise<unknown[]> {
    const n = this.keyedCalls.get(method) ?? 0;
    this.keyedCalls.set(method, n + 1);
    const holder = args[at];
    if (holder != null && typeof holder !== "object") return Promise.resolve(args); // not ours to change; the provider rejects it
    const given = (holder as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
    if (given !== undefined && given !== null && given !== "") return Promise.resolve(args);
    const derived = `${this.stepKey}:${method}:${n}`;
    return fitKey(derived).then((idempotencyKey) => {
      const keyed = [...args];
      while (keyed.length < at) keyed.push(undefined);
      // A new object: the caller's request or options are left as they were.
      keyed[at] = { ...(holder as object | null | undefined), idempotencyKey };
      return keyed;
    });
  }

  /**
   * Wrap a provider so every method call must happen inside `ctx.step.do`.
   * Side effects outside a step would repeat on every replay.
   */
  guardProvider(cap: Capability, provider: object | undefined): object {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop === "symbol" || prop === "then") return undefined;
          if (!provider) {
            throw new ActuatorError(
              `ctx.${cap} is declared but no ${cap} provider is configured for actuator "${this.actuator.name}".`,
            );
          }
          const value = (provider as Record<string, unknown>)[prop];
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (this.inStep === null) {
              throw new ActuatorError(
                `ctx.${cap}.${prop}() must be called inside ctx.step.do(...); otherwise it repeats on every replay.`,
              );
            }
            const keyed = KEYED_METHODS[cap];
            const at = keyed && Object.hasOwn(keyed, prop) ? keyed[prop] : undefined;
            if (at !== undefined) return this.withIdempotencyKey(prop, at, args).then((keyed) => Reflect.apply(value as (...a: unknown[]) => unknown, provider, keyed));
            // Reflect.apply, not value.apply: on an RPC stub, ".apply" would be a remote property lookup.
            return Reflect.apply(value as (...a: unknown[]) => unknown, provider, args);
          };
        },
      },
    );
  }
}

/**
 * On the hosted platform the journal is an RPC stub, so a host built before batches answers the call with
 * "The RPC receiver does not implement the method ...". Say what that means, and don't spend retries on it.
 */
function unsupportedByHost(err: unknown, api: string, nonRetryable: boolean): unknown {
  if (!(err instanceof Error) || !/does not implement the method/.test(err.message)) return err;
  const message = `${api} is not supported by this host yet (its runtime predates it). Nothing was written.`;
  return nonRetryable ? new NonRetryableError(message) : new ActuatorError(message);
}

/** Validate and copy statements for `ctx.db.batch` / `commitWithStep` (the guards `ctx.db.query` applies, per statement). */
function checkStatements(kind: string, statements: readonly DbStatement[]): DbStatement[] {
  if (!Array.isArray(statements)) throw new ActuatorError(`ctx.db.${kind} needs an array of statements: [{ sql, params }] or ctx.db.statement\`...\`.`);
  return statements.map((st, i) => {
    const sql = (st as DbStatement | undefined)?.sql;
    const params = (st as DbStatement | undefined)?.params ?? [];
    if (typeof sql !== "string") throw new ActuatorError(`ctx.db.${kind}: statement ${i + 1} needs sql as a string.`);
    if (!Array.isArray(params)) throw new ActuatorError(`ctx.db.${kind}: statement ${i + 1} has params that are not an array.`);
    if (RESERVED_TABLE.test(sql)) throw new ActuatorError("Tables starting with _actuate_ are reserved for the runtime.");
    if (TRANSACTION_CONTROL.test(sql)) {
      throw new ActuatorError(`ctx.db.${kind}: statement ${i + 1} controls a transaction. The ${kind} is already one transaction; leave out BEGIN, COMMIT, ROLLBACK and SAVEPOINT.`);
    }
    // A copy: the caller changing its array later must not change what was queued or sent.
    return { sql, params: [...params] };
  });
}

/**
 * A key no longer than providers accept. Keys the runtime derives fit (run IDs are 32 characters and step
 * names at most 200); a longer one (a custom run ID) keeps its first 190 characters and gains a hash of the
 * whole key, so it stays distinct and deterministic.
 */
async function fitKey(key: string): Promise<string> {
  if (key.length <= MAX_IDEMPOTENCY_KEY) return key;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return `${key.slice(0, 190)}~${Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function approvalEventKey(runId: string, stepName: string): string {
  return `approval:${runId}:${stepName}`;
}
