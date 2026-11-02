import type { z } from "zod";
import type { Duration } from "./duration.js";
import { ActuatorError } from "./errors.js";
import { CAPABILITIES, type Capability, type Providers } from "./providers.js";

/** Any JSON value. Step outputs, event payloads and run results must be serialisable to this. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;
export type Row = Record<string, SqlValue>;

/**
 * The actuator's own SQLite database. Only parameterised statements are
 * exposed: there is deliberately no string-interpolated `exec`.
 */
export interface Db {
  /** Run one statement with `?` placeholders and return all rows. */
  query<T extends object = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** Like {@link Db.query} but returns the first row or `null`. */
  first<T extends object = Row>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  /**
   * Tagged template. Interpolated values become bound parameters, never SQL:
   * `` await ctx.db.sql`SELECT * FROM bookings WHERE id = ${id}` ``
   */
  sql<T extends object = Row>(strings: TemplateStringsArray, ...values: SqlValue[]): Promise<T[]>;
  /**
   * Apply schema migrations in order. Each entry is applied exactly once per
   * actuator (tracked by index), so it is safe to call at the top of every run.
   * Never reorder or edit an entry that has shipped; append a new one.
   */
  migrate(statements: readonly string[]): Promise<void>;
}

export interface StepInfo {
  /** Stable for this run and step: pass it to payment and messaging APIs that deduplicate. */
  idempotencyKey: string;
  /** The host's clock when the step started, epoch ms. Prefer it to Date.now(): tests can control it. */
  now: number;
  /** 1 on the first try, 2 on the first retry, and so on. */
  attempt: number;
}

export interface StepOptions {
  /** How many times to retry after the first failure. Default 0. */
  retries?: number;
  /** Delay before the first retry; doubles on each further retry. Default "1 second". */
  backoff?: Duration;
}

export interface WaitForEventOptions {
  /** The event key to wait for, e.g. `payment.${bookingId}`. */
  event: string;
  /** Give up after this long and resolve to `null`. Default: wait forever. */
  timeout?: Duration;
}

export interface WaitForApprovalOptions {
  /** Shown to the approver. */
  message?: string;
  /** Who gets the signed link: a chat ID, phone or email understood by the messaging provider. */
  notify?: string;
  /** Give up after this long and resolve to `null`. Default "7 days". */
  timeout?: Duration;
}

export interface ApprovalResult {
  approved: boolean;
  /** ISO timestamp of the decision. */
  at: string;
  note?: string;
}

/**
 * Durable steps. `run` is replayed from the top after every pause, so
 * anything with a side effect (network, database writes, `Date.now()`) must
 * sit inside `step.do`.
 */
export interface Step {
  /** Run `fn` once per run. On replay the stored result is returned without calling `fn`. */
  do<T>(name: string, fn: (info: StepInfo) => T | Promise<T>): Promise<T>;
  do<T>(name: string, options: StepOptions, fn: (info: StepInfo) => T | Promise<T>): Promise<T>;
  /** Pause the run. Nothing runs, and nothing is billed, while it sleeps. */
  sleep(duration: Duration): Promise<void>;
  sleep(name: string, duration: Duration): Promise<void>;
  /** Pause until a point in time. */
  sleepUntil(name: string, until: Date | number): Promise<void>;
  /** Pause until an event with this key is posted, or the timeout passes (resolves to `null`). */
  waitForEvent<T = Json>(name: string, options: WaitForEventOptions): Promise<T | null>;
  /** Pause until a person clicks a signed approve or reject link, or the timeout passes (resolves to `null`). */
  waitForApproval(name: string, options?: WaitForApprovalOptions): Promise<ApprovalResult | null>;
}

export interface Logger {
  info(message: string, data?: Json): void;
  warn(message: string, data?: Json): void;
  error(message: string, data?: Json): void;
}

export type TriggerKind = "webhook" | "cron" | "mcp" | "manual" | "api";

export interface Trigger {
  kind: TriggerKind;
  /** The cron expression, for cron triggers. */
  cron?: string;
}

export interface BaseContext {
  /** Unique per run. Reused across every replay of the run. */
  runId: string;
  actuator: string;
  trigger: Trigger;
  step: Step;
  db: Db;
  log: Logger;
}

/** The context passed to `run`: base context, a client per declared capability, and optional ones that may be absent. */
export type Context<K extends Capability = never, P extends Capability = never> = BaseContext &
  Pick<Providers, K> &
  Partial<Pick<Providers, P>>;

export type AnySchema = z.ZodType;

export interface ActuatorDefinition<
  C extends AnySchema = AnySchema,
  I extends AnySchema = AnySchema,
  O = unknown,
  K extends Capability = Capability,
  P extends Capability = Capability,
> {
  /** Tool name: lowercase letters, digits and underscores, starting with a letter, at most 64 characters. */
  name: string;
  /** What the actuator does. Becomes the MCP tool description, so write it for a model. */
  description: string;
  /** Operator settings, set once. Defaults are used for anything not configured. */
  config?: C;
  /** The payload of one run. Validated before any code runs. */
  input: I;
  /** Optional schema for the run's return value; published in the MCP tool and OpenAPI document. */
  output?: z.ZodType<O>;
  /** Capabilities this actuator uses. Undeclared capabilities are absent from `ctx`. */
  capabilities?: readonly K[];
  /**
   * Capabilities the actuator can do without, e.g. an alert channel. Present on
   * `ctx` (possibly `undefined`) and never required to deploy: `ctx.messaging?.send(...)`.
   */
  optionalCapabilities?: readonly P[];
  /** Domains the `http` capability may reach, e.g. ["api.github.com", "*.example.com"]. */
  http?: { allow: readonly string[] };
  /** Cron schedules. Each firing starts a run with an empty input `{}`. */
  cron?: readonly string[];
  run(ctx: Context<K, P>, input: z.output<I>, config: z.output<C>): Promise<O> | O;
}

export interface Actuator<
  C extends AnySchema = AnySchema,
  I extends AnySchema = AnySchema,
  O = unknown,
  K extends Capability = Capability,
  P extends Capability = Capability,
> extends ActuatorDefinition<C, I, O, K, P> {
  readonly __actuate: 1;
}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Declare an actuator. The default export of an actuator file must be the result of this call. */
export function defineActuator<
  C extends AnySchema,
  I extends AnySchema,
  O,
  const K extends Capability = never,
  const P extends Capability = never,
>(definition: ActuatorDefinition<C, I, O, K, P>): Actuator<C, I, O, K, P> {
  if (!NAME_RE.test(definition.name)) {
    throw new ActuatorError(
      `Actuator name "${definition.name}" must match ${NAME_RE} (lowercase, digits, underscores; it becomes an MCP tool name).`,
    );
  }
  if (!definition.description?.trim()) throw new ActuatorError(`Actuator "${definition.name}" needs a description.`);
  for (const cap of [...(definition.capabilities ?? []), ...(definition.optionalCapabilities ?? [])]) {
    if (!CAPABILITIES.includes(cap)) throw new ActuatorError(`Unknown capability "${String(cap)}".`);
  }
  const both = (definition.optionalCapabilities ?? []).filter((c) => (definition.capabilities as readonly Capability[] | undefined)?.includes(c));
  if (both.length) throw new ActuatorError(`"${both.join('", "')}" is listed as both required and optional.`);
  if ((definition.optionalCapabilities as readonly Capability[] | undefined)?.includes("http")) {
    throw new ActuatorError(`"http" cannot be optional; declare it in capabilities with http.allow.`);
  }
  if (definition.capabilities?.includes("http" as K) && !definition.http?.allow?.length) {
    throw new ActuatorError(`Actuator "${definition.name}" declares "http" but no http.allow domains.`);
  }
  return Object.freeze({ ...definition, __actuate: 1 as const });
}

export function isActuator(value: unknown): value is Actuator {
  return typeof value === "object" && value !== null && (value as { __actuate?: unknown }).__actuate === 1;
}
