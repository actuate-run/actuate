import { CAPABILITIES, NonRetryableError, type Actuator, type BaseContext, type Step, type StepInfo, type StepOptions } from "@actuate/sdk";
import { checkActuatorSql, type PassLimits } from "@actuate/runtime";
import { PASS_LIMITS, type PlanRules } from "./plans.js";
import type { UsageTracker } from "./usage.js";

/** The per-pass limits, as numbers (PASS_LIMITS holds the platform's values). */
export type Limits = { -readonly [K in keyof typeof PASS_LIMITS]: number };

export interface GuardOptions {
  /** Per-run row counts, for the rows-per-pass guards. Without it those two are skipped. */
  usage?: UsageTracker;
  /** Called when a guard stops a pass, before the error is thrown. */
  onTrip?: (message: string, runId: string) => void;
  /** Override limits (tests). */
  limits?: Partial<Limits>;
  /** false: enforce nothing, only attribute ctx.db rows to runs (for metering with the guards off). Default true. */
  enforce?: boolean;
  /**
   * Refuse capabilities this plan doesn't include, as the platform does: calls on a required one fail with the
   * platform's message, and an optional one is undefined (the platform has no provider for it). `actuate dev` sets it.
   */
  plan?: PlanRules;
}

/** RunManager options for a plan: passes per run, the longest wait, the retry cap. */
export function planGuards(plan: PlanRules): { maxPasses: number; passLimits: PassLimits } {
  return {
    maxPasses: plan.limits.passesPerRun,
    passLimits: { maxRetries: PASS_LIMITS.maxRetries, ...(plan.maxSleepMs !== null ? { maxWaitMs: plan.maxSleepMs } : {}) },
  };
}

/**
 * The hosted platform's guards on one pass, applied around an actuator so
 * code that would fail once deployed fails the same way under `actuate dev`
 * and in tests: the same limits, the same messages.
 *
 * Mirrored: ctx.db statements, step writes, rows written and read (when a
 * {@link UsageTracker} is given), ctx.http requests per pass, the 1 MiB step
 * result limit, the SQL the platform refuses, 30 s of wall time, and no
 * database or provider use after a pass has ended. The plan's longest wait,
 * passes per run and retry cap are RunManager options: {@link planGuards}.
 * Not mirrored: the 50 ms CPU limit (local machines differ too much).
 *
 * No Node imports: `actuate dev` bundles this file into workerd.
 */
export function withPlatformGuards<A extends Actuator>(actuator: A, options: GuardOptions = {}): A {
  const limits: Limits = { ...PASS_LIMITS, ...options.limits };
  return Object.freeze({
    ...actuator,
    run: async (ctx: BaseContext, input: unknown, config: unknown) => {
      if (options.enforce === false) return actuator.run(attributeOnly(ctx, options.usage) as never, input as never, config as never);
      const pass = new PassGuard(ctx.runId, limits, options);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          pass.closed = true;
          reject(pass.error(`A single pass may take at most ${limits.wallMs / 1000}s.`));
        }, limits.wallMs);
      });
      try {
        return await Promise.race([actuator.run(guardContext(ctx, pass, limits, options, actuator) as never, input as never, config as never), timeout]);
      } finally {
        clearTimeout(timer);
        pass.closed = true;
      }
    },
  });
}

class PassGuard {
  closed = false;
  private statements = 0;
  private steps = 0;
  private http = 0;
  private readonly start: { rowsRead: number; rowsWritten: number } | null;

  constructor(
    readonly runId: string,
    private readonly limits: Limits,
    private readonly options: GuardOptions,
  ) {
    this.start = options.usage?.of(runId) ?? null;
  }

  error(message: string, nonRetryable = false): Error {
    this.options.onTrip?.(message, this.runId);
    return nonRetryable ? new NonRetryableError(message) : new Error(message);
  }

  open(): void {
    if (this.closed) throw new Error("This pass has ended.");
  }

  statement(): void {
    this.open();
    if (++this.statements > this.limits.dbStatements) {
      throw this.error(`A single pass may run at most ${this.limits.dbStatements} database statements.`);
    }
    this.rows();
  }

  /** On the platform this fails the journal write, outside the step, so the run fails without retrying. */
  step(writes: number): void {
    this.open();
    this.steps += writes;
    if (this.steps > this.limits.stepWrites) throw this.error(`A single pass may record at most ${this.limits.stepWrites} steps.`, true);
  }

  rows(): void {
    if (!this.start || !this.options.usage) return;
    const now = this.options.usage.of(this.runId);
    if (now.rowsWritten - this.start.rowsWritten > this.limits.rowsWritten) {
      throw this.error(`A single pass may write at most ${this.limits.rowsWritten} rows.`);
    }
    if (now.rowsRead - this.start.rowsRead > this.limits.rowsRead) {
      throw this.error(`A single pass may read at most ${this.limits.rowsRead.toLocaleString("en")} rows.`);
    }
  }

  httpRequest(): void {
    this.open();
    if (++this.http > this.limits.httpRequests) throw this.error(`A single pass may make at most ${this.limits.httpRequests} HTTP requests.`);
  }

  sql(sql: unknown, params: unknown): void {
    // The runtime itself refuses non-strings and _actuate_ tables first, with its own message.
    if (typeof sql !== "string" || /\b_actuate_/i.test(sql)) return;
    try {
      checkActuatorSql(sql, Array.isArray(params) ? params : [], this.limits.paramBytes);
    } catch (err) {
      throw this.error((err as Error).message);
    }
  }
}

/** The context with ctx.db calls attributed to the run, and nothing enforced. */
function attributeOnly(ctx: BaseContext, usage: UsageTracker | undefined): BaseContext {
  if (!usage) return ctx;
  const db = ctx.db as unknown as Record<string, unknown>;
  const wrapped: Record<string, unknown> = { ...db };
  for (const [name, fn] of Object.entries(db)) {
    if (typeof fn === "function") wrapped[name] = (...args: unknown[]) => usage.attribute(ctx.runId, () => Reflect.apply(fn as (...a: unknown[]) => unknown, db, args));
  }
  return { ...(ctx as unknown as Record<string, unknown>), db: wrapped } as unknown as BaseContext;
}

function guardContext(ctx: BaseContext, pass: PassGuard, limits: Limits, options: GuardOptions, actuator: Actuator): BaseContext {
  const source = ctx as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source, db: guardDb(ctx, pass, options.usage), step: guardStep(ctx.step, pass, limits) };
  const plan = options.plan;
  for (const cap of CAPABILITIES) {
    if (plan && !plan.capabilities.includes(cap) && cap in source) {
      if ((actuator.optionalCapabilities as readonly string[] | undefined)?.includes(cap)) out[cap] = undefined;
      else out[cap] = refusedProvider(`The ${plan.name} plan cannot use ${cap}. Upgrade to Maker to use providers.`, pass);
      continue;
    }
    const provider = source[cap];
    if (provider && typeof provider === "object") out[cap] = guardProvider(cap, provider, pass);
  }
  return out as unknown as BaseContext;
}

/** A provider whose every method fails with `message`. */
function refusedProvider(message: string, pass: PassGuard): object {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        typeof prop === "symbol" || prop === "then"
          ? undefined
          : () => {
              throw pass.error(message, true);
            },
    },
  );
}

function guardDb(ctx: BaseContext, pass: PassGuard, usage: UsageTracker | undefined): BaseContext["db"] {
  const db = ctx.db as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...db };
  for (const [name, fn] of Object.entries(db)) {
    if (typeof fn !== "function") continue;
    // Synchronous helpers stay synchronous: statement builds a { sql, params } value, commitWithStep queues writes.
    if (name === "statement") continue;
    if (name === "commitWithStep") {
      out[name] = (statements: unknown) => {
        for (const st of Array.isArray(statements) ? statements : []) {
          pass.statement();
          pass.sql((st as { sql?: unknown } | null)?.sql, (st as { params?: unknown } | null)?.params ?? []);
        }
        return Reflect.apply(fn as (...a: unknown[]) => unknown, db, [statements]);
      };
      continue;
    }
    out[name] = async (...args: unknown[]) => {
      // A batch counts and checks each statement, as the platform does.
      if (name === "batch" && Array.isArray(args[0])) {
        for (const st of args[0] as Array<{ sql?: unknown; params?: unknown } | null>) {
          pass.statement();
          pass.sql(st?.sql, st?.params ?? []);
        }
      } else pass.statement();
      if (name === "query" || name === "first") pass.sql(args[0], args[1]);
      else if (name === "sql" && Array.isArray(args[0])) pass.sql((args[0] as string[]).join("?"), args.slice(1));
      else if (name === "migrate" && Array.isArray(args[0])) for (const statement of args[0]) pass.sql(statement, []);
      // ctx.db reaches SQLite synchronously, so attributing the call attributes its statements.
      const call = () => Reflect.apply(fn as (...a: unknown[]) => unknown, db, args);
      const result = await (usage ? usage.attribute(ctx.runId, call) : call());
      pass.rows();
      return result;
    };
  }
  return out as unknown as BaseContext["db"];
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value === undefined ? null : value)?.length ?? 0;
  } catch {
    return 0; // not JSON: the runtime reports that itself
  }
}

function guardStep(step: Step, pass: PassGuard, limits: Limits): Step {
  const run = <T>(name: string, options: StepOptions | undefined, fn: (info: StepInfo) => T | Promise<T>) => {
    const guarded = async (info: StepInfo): Promise<T> => {
      // A step that can retry is written before it runs and again when it ends.
      pass.step((options?.retries ?? 0) > 0 ? 2 : 1);
      const result = await fn(info);
      pass.open();
      if (jsonLength(result) > limits.stepOutputBytes) throw pass.error(`A step's result may be at most ${limits.stepOutputBytes / 1024} KiB of JSON.`, true);
      return result;
    };
    return options ? step.do(name, options, guarded) : step.do(name, guarded);
  };
  return {
    ...step,
    do: ((name: string, a: unknown, b?: unknown) => {
      const fn = typeof a === "function" ? a : b;
      if (typeof fn !== "function") return (step.do as (...args: unknown[]) => unknown)(name, a, b); // the runtime explains
      return run(name, typeof a === "function" ? undefined : (a as StepOptions), fn as (info: StepInfo) => unknown);
    }) as Step["do"],
  };
}

function guardProvider(cap: string, provider: object, pass: PassGuard): object {
  return new Proxy(provider, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        pass.open();
        if (cap === "http" && prop === "fetch") pass.httpRequest();
        return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
      };
    },
  });
}
