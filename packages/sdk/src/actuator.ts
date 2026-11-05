import type { z } from "zod";
import type { Duration } from "./duration.js";
import { ActuatorError } from "./errors.js";
import { CAPABILITIES, type Capability, type Providers } from "./providers.js";

/** Any JSON value. Step outputs, event payloads and run results must be serialisable to this. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;
export type Row = Record<string, SqlValue>;

/** One parameterised statement for {@link Db.batch} and {@link Db.commitWithStep}. Build one with {@link Db.statement}. */
export interface DbStatement {
  /** One statement with `?` placeholders. Transaction control (BEGIN, COMMIT, SAVEPOINT, ...) is refused. */
  sql: string;
  params?: readonly SqlValue[];
}

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
   * Build a statement for {@link Db.batch} or {@link Db.commitWithStep} without running it. Tagged template:
   * interpolated values become bound parameters, as in {@link Db.sql}.
   */
  statement(strings: TemplateStringsArray, ...values: SqlValue[]): DbStatement;
  /**
   * Run several statements all-or-nothing, in one transaction: if any statement fails, none of them is
   * applied and the error says which one failed. Resolves to each statement's rows, in order
   * (`RETURNING` rows for writes; an empty array for writes without `RETURNING`).
   * Later statements see earlier ones' writes, but nothing outside the batch runs in between.
   *
   * A batch is atomic on its own, not with the step around it: if the step throws after the batch and is
   * retried, the batch runs again. For writes that should happen exactly once, together with the step's
   * result, use {@link Db.commitWithStep}.
   *
   * ```ts
   * await ctx.db.batch([
   *   ctx.db.statement`UPDATE stock SET qty = qty - ${qty} WHERE sku = ${sku}`,
   *   ctx.db.statement`INSERT INTO orders (id, sku, qty) VALUES (${orderId}, ${sku}, ${qty})`,
   * ]);
   * ```
   */
  batch<T extends object = Row>(statements: readonly DbStatement[]): Promise<T[][]>;
  /**
   * Queue statements to apply when the current step completes, in the same transaction that records the
   * step's result. Only inside `ctx.step.do`. If the step throws (or is retried), none of them is applied;
   * once the step has completed they are never applied again, even if the run is replayed. If one of them
   * fails, none is applied and the step attempt fails with that error (and retries if it can).
   *
   * They run after the step function returns, so the step cannot read their effects or rows: use
   * {@link Db.batch} for writes whose results you need.
   */
  commitWithStep(statements: readonly DbStatement[]): void;
  /**
   * Apply schema migrations in order. Each entry is applied exactly once per
   * actuator (tracked by index), so it is safe to call at the top of every run.
   * Never reorder or edit an entry that has shipped; append a new one.
   */
  migrate(statements: readonly string[]): Promise<void>;
}

export interface StepInfo {
  /**
   * Stable for this run and step (`<runId>:<step name>`), the same on every retry and replay.
   *
   * Provider calls made in the step that accept an idempotency key (`messaging.send`, `payment.createBill`,
   * `payment.refund`) get one derived from it when you pass none: `<this key>:<method>:<n>`, where `n` counts
   * that method's calls in this attempt of the step from 0 (in a step named "notify", the second
   * `send` gets `<runId>:notify:send:1`). So two sends in one step get different keys, and a retried step gives the same call the same key.
   * A key you pass yourself is used as is. The adapter forwards it where the provider's API deduplicates.
   */
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
  /** Give up after this long and resolve to `null`. Default: wait forever (or the plan's longest wait). */
  timeout?: Duration;
  /** Give up at this moment instead (use one of `timeout` or `until`). An event cancels the wait early. */
  until?: Date | number;
}

export interface WaitForInputOptions {
  /** The question shown on the form. */
  prompt: string;
  /** Who gets the signed link: a chat ID, phone or email understood by the messaging provider. */
  notify?: string;
  /** Pre-filled text, e.g. a draft to edit. */
  initial?: string;
  /** Longest answer accepted, characters. Default 4,000. */
  maxLength?: number;
  /** Give up after this long and resolve to `null`. Default "7 days". */
  timeout?: Duration;
}

export interface InputResult {
  text: string;
  /** ISO timestamp of the answer. */
  at: string;
  /** Who answered; see ApprovalResult.by (link answers are self-reported). */
  by?: string;
  via?: "link" | "dashboard" | "api";
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
  /** Optional note typed by the approver (on the approval page or in the dashboard). */
  note?: string;
  /**
   * Who decided. From the dashboard or API it is the signed-in account (email or
   * token name); from a signed link it is the name the person typed, if any (self-reported).
   */
  by?: string;
  /** Where the decision came from. */
  via?: "link" | "dashboard" | "api";
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
  /**
   * Pause until a person answers through a signed link to a short text form, or the timeout passes
   * (resolves to `null`). For questions an agent can't answer: "What should we tell the customer?"
   */
  waitForInput(name: string, options: WaitForInputOptions): Promise<InputResult | null>;
}

export interface ToolHints {
  /** Only reads; never changes anything. */
  readOnly?: boolean;
  /** Calling twice with the same arguments has the same effect as calling once. */
  idempotent?: boolean;
  /** May delete or irreversibly change data. */
  destructive?: boolean;
  /** Talks to the outside world (messages, payments, other APIs). */
  openWorld?: boolean;
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

/** Longest `ctx.notifyOwner` text, characters. */
export const NOTIFY_OWNER_MAX_TEXT = 4_000;
/** Longest `ctx.notifyOwner` subject, characters. */
export const NOTIFY_OWNER_MAX_SUBJECT = 200;

export interface NotifyOwnerOptions {
  /** Subject line: one line (no line breaks or other control characters), at most 200 characters. The hosted platform's default: `<actuator>: message from your actuator`. */
  subject?: string;
}

/** What became of a `ctx.notifyOwner` message. */
export interface NotifyOwnerResult {
  /** Whether the message went out. */
  sent: boolean;
  /** Why not, when it didn't: no notifier configured, a daily cap reached, ... */
  reason?: string;
}

/** One `ctx.notifyOwner` message, as the runtime hands it to an {@link OwnerNotifier}. */
export interface OwnerNotification {
  /** 1 to 4,000 characters. */
  text: string;
  /** At most 200 characters, one line (no control characters). */
  subject?: string;
  runId: string;
  actuator: string;
  /**
   * `<step idempotency key>:notifyOwner:<n>`, `n` counting this step attempt's `notifyOwner` calls from 0, as for
   * provider calls (see {@link StepInfo.idempotencyKey}): the same on every retry of the step, so a notifier
   * that deduplicates on it never sends one message twice.
   */
  idempotencyKey: string;
}

/**
 * Delivers `ctx.notifyOwner` messages: the hosted platform emails the account (and its alert channel);
 * `actuate dev` prints them. Return `{ sent: false, reason }` for a delivery limit (a daily cap) rather than
 * throwing: the runtime logs the reason and the step carries on. Throw only for a failure worth retrying the step for.
 */
export interface OwnerNotifier {
  notify(message: OwnerNotification): Promise<NotifyOwnerResult>;
}

export interface BaseContext {
  /** Unique per run. Reused across every replay of the run. */
  runId: string;
  actuator: string;
  trigger: Trigger;
  step: Step;
  db: Db;
  log: Logger;
  /**
   * Send the actuator's owner a short message: on the hosted platform, an email to the account (and the
   * account's alert channel, when one is set up); under `actuate dev`, a line in the terminal. For things a
   * person should hear about ("3 refunds are waiting longer than a day"), not for messaging customers
   * (use `ctx.messaging`). No capability to declare.
   *
   * Call it inside `ctx.step.do`, like provider calls: a retried step reuses the message's idempotency key,
   * so it is not sent twice. `text` is 1 to 4,000 characters and `subject` one line of at most 200; secret config
   * values in either are redacted. Resolves to `{ sent: false, reason }` instead of throwing when the
   * message can't go out (no notifier, a daily cap reached); the reason is also logged.
   */
  notifyOwner(text: string, options?: NotifyOwnerOptions): Promise<NotifyOwnerResult>;
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
  /**
   * Operator settings, set once. Defaults are used for anything not configured. Wrap API keys, tokens and
   * passwords in {@link secret} (`apiKey: secret(z.string())`): their values are redacted from logs, errors
   * and run records, and the platform never shows them again once set.
   */
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
  /**
   * Hints for MCP clients about what calling this tool does (they shape how agents
   * and people approve tool calls). Defaults: not read-only, not idempotent.
   */
  hints?: ToolHints;
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
