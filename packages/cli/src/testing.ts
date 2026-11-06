/**
 * Test an actuator in-process: the real step engine on `node:sqlite`, a clock
 * you move, recording fakes for every provider, and the hosted platform's
 * guards and rows meter.
 *
 * ```ts
 * import { test } from "node:test";
 * import assert from "node:assert/strict";
 * import { testActuator } from "@actuate/cli/testing";
 * import actuator from "./actuator.js";
 *
 * test("greets, then follows up", async () => {
 *   const t = testActuator(actuator);
 *   const run = await t.start({ name: "Aina" });
 *   await t.advance("10 seconds");
 *   assert.equal(t.run(run.runId).status, "COMPLETED");
 *   assert.ok(t.usage(run.runId).rowsWritten <= 10);
 * });
 * ```
 *
 * Run it with `actuate test`. Works the same under Vitest.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  parseDuration,
  z,
  type Actuator,
  type Bill,
  type CreateBillRequest,
  type Duration,
  type Json,
  type LlmRequest,
  type LlmResponse,
  type MessagingSendOptions,
  type OwnerNotification,
  type PaymentEvent,
  type Providers,
  type RefundRequest,
  type Row,
  type SqlValue,
  type Trigger,
  type TriggerKind,
} from "@actuate/sdk";
import {
  RunManager,
  collectSecrets,
  createHttpProvider,
  executePass,
  mergeSecrets,
  meteredNodeSqlite,
  type ApprovalRequest,
  type LogRecord,
  type RunRecord,
  type StepRecord,
} from "@actuate/runtime";
import { planGuards, withPlatformGuards } from "./guards.js";
import { PLANS, isPlanId, type PlanId } from "./plans.js";
import { formatIssues } from "./platform-checks.js";
import { UsageTracker, type RunUsage } from "./usage.js";

export type { ApprovalRequest, LogRecord, RunRecord, StepRecord } from "@actuate/runtime";
export type { RunUsage } from "./usage.js";
export type { PlanId } from "./plans.js";

/** Where the test clock starts unless you pass `now`: Monday 5 January 2026, 00:00 UTC. */
export const TEST_START = Date.UTC(2026, 0, 5);

export interface TestActuatorOptions {
  /** Operator configuration, parsed with the actuator's config schema (defaults apply). */
  config?: unknown;
  /**
   * Replace the recording fakes. Set a capability to `undefined` to test an
   * optional capability that has no provider.
   */
  providers?: Partial<{ [K in keyof Providers]: Providers[K] | undefined }>;
  /** Replies for `ctx.llm.complete`, in order, or a function that answers each request. */
  llm?: string[] | ((request: LlmRequest) => string | LlmResponse | Promise<string | LlmResponse>);
  /**
   * Answers `ctx.http.fetch`, after the real `http.allow` check. Return a
   * Response, or any JSON value for a 200 JSON response.
   */
  http?: (request: Request) => Response | Json | Promise<Response | Json>;
  /**
   * The hosted plan whose guards apply: per-pass limits, the longest wait and
   * passes per run. Default: `ACTUATE_PLAN` (set by `actuate test --plan`),
   * else "sandbox". `false` turns the guards off.
   */
  plan?: PlanId | false;
  /** Start time of the test clock. Default {@link TEST_START}. */
  now?: number | string | Date;
  /** Make `Date.now()` and `new Date()` follow the test clock (default true). */
  fakeDate?: boolean;
  /** Print run logs to the console (default false). */
  logs?: boolean;
  /**
   * Redact `secret()` config values as the platform and `actuate dev` do (default false): runs, step outputs, logs,
   * errors and `ownerNotifications` show `[secret]` instead. Replays still see the real value. Turn it on to assert
   * that a secret never shows; leave it off to assert on real values.
   */
  redactSecrets?: boolean;
}

export interface SentMessage {
  to: string;
  text: string;
  options?: MessagingSendOptions;
}

export interface DecideOptions {
  /** Which run, when several are waiting. Default: the most recent request. */
  runId?: string;
  /** The approver's note (approvals) or who answered. */
  note?: string;
  by?: string;
}

/** node:sqlite, loaded at run time (bundlers drop the `node:` prefix it can't do without). */
function sqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!mod) {
    throw new Error(`testActuator needs node:sqlite, which Node.js ${process.versions.node} doesn't enable by default. Use Node.js 22.13 or later, or run the tests with \`actuate test\` (it adds --experimental-sqlite).`);
  }
  return mod;
}

// ---------------------------------------------------------------- the test clock behind Date

const RealDate = globalThis.Date;
let activeClock: (() => number) | null = null;
let openHarnesses = 0;

class TestDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0 && activeClock) super(activeClock());
    else super(...(args as [string | number | Date]));
  }
  static override now(): number {
    return activeClock ? activeClock() : RealDate.now();
  }
}

/**
 * Start a test of `actuator`. Every capability gets a recording fake unless
 * you replace it; inputs and config are validated with the actuator's schemas,
 * as the platform does. Unlike the platform and `actuate dev`, it does not redact
 * `secret()` config values from runs, steps and logs unless you pass `redactSecrets: true`,
 * so tests can assert on real values.
 */
export function testActuator<A extends Actuator>(actuator: A, options: TestActuatorOptions = {}): ActuatorTest<A> {
  return new ActuatorTest(actuator, options);
}

/** What the actuator's `run` returns (after the JSON round trip every result makes). */
export type OutputOf<A> = A extends { run(...args: never[]): infer R } ? Awaited<R> : unknown;

/** A run record whose `output` has the actuator's output type. */
export type TestRun<T = unknown> = Omit<RunRecord, "output"> & { output: T | null };

/** An approval or input request as the runtime sent it; `message` is "" when the step gave none. */
export type TestApprovalRequest = ApprovalRequest & { message: string };

/** What following a signed link did: the decision, or why the link was refused (expired, already used). */
export type LinkResult = { ok: true; runId: string; step: string; approved: boolean } | { ok: false; reason: string };

export class ActuatorTest<A extends Actuator = Actuator> {
  /** Messages sent through `ctx.messaging`. */
  readonly messages: SentMessage[] = [];
  /** Bills created through `ctx.payment`, with the ID the fake gave each. */
  readonly bills: Array<CreateBillRequest & { id: string }> = [];
  readonly refunds: RefundRequest[] = [];
  /** Requests made to `ctx.llm`. */
  readonly prompts: LlmRequest[] = [];
  /** Replies still queued for `ctx.llm` (push more at any time). */
  readonly llmReplies: string[];
  /** Requests made through `ctx.http` (clones, so you can read their bodies). */
  readonly requests: Request[] = [];
  /** Messages sent through `ctx.notifyOwner` (each reported sent). */
  readonly ownerNotifications: OwnerNotification[] = [];
  /** Approval and input requests as the runtime sent them, links included (see {@link followLink}). */
  readonly approvals: TestApprovalRequest[] = [];
  readonly manager: RunManager;
  readonly db: DatabaseSync;
  /** The plan whose guards apply, or null when they are off. */
  readonly plan: PlanId | null;

  private clock: number;
  private readonly tracker = new UsageTracker();
  private readonly paidStatus = new Map<string, Bill["status"]>();
  /** Idempotency key → bill or refund ID: a repeated key gets the first one back, as real providers do. */
  private readonly billKeys = new Map<string, string>();
  private readonly refundKeys = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly actuator: A,
    private readonly options: TestActuatorOptions = {},
  ) {
    this.clock = options.now === undefined ? TEST_START : new RealDate(options.now).getTime();
    if (!Number.isFinite(this.clock)) throw new Error(`testActuator: invalid start time ${String(options.now)}.`);
    this.llmReplies = Array.isArray(options.llm) ? [...options.llm] : [];
    const envPlan = process.env.ACTUATE_PLAN;
    this.plan = options.plan === false ? null : (options.plan ?? (isPlanId(envPlan) ? envPlan : "sandbox"));
    if (this.plan !== null && !isPlanId(this.plan)) throw new Error(`testActuator: unknown plan "${String(this.plan)}". Use sandbox, maker or agency.`);

    const parsed = (actuator.config ?? z.object({})).safeParse(options.config ?? {});
    if (!parsed.success) throw new Error(`testActuator: invalid config:${formatIssues(parsed.error.issues)}`);
    const config = parsed.data;
    // The same values the platform redacts: secret fields of the config as given, and of the parsed one (defaults).
    let secrets: readonly string[] = [];
    if (options.redactSecrets && actuator.config) {
      const schema = z.toJSONSchema(actuator.config, { io: "input", unrepresentable: "any" });
      secrets = mergeSecrets(collectSecrets(schema, options.config ?? {}), collectSecrets(schema, config));
    }

    // With the guards off, the wrapper still attributes ctx.db rows to runs for t.usage().
    const guarded = withPlatformGuards(actuator, { usage: this.tracker, enforce: this.plan !== null });
    const providers = { ...this.fakes(), ...options.providers } as Partial<Providers>;
    this.db = new (sqlite().DatabaseSync)(":memory:");
    this.manager = new RunManager({
      sql: meteredNodeSqlite(this.db, { onStatement: (cost) => this.tracker.record(cost.params, cost), wrapTransaction: (run) => this.tracker.transaction(run) }),
      approvalSecret: "actuate-test",
      approvalUrl: "https://actuator.test/approve",
      now: () => this.clock,
      consoleLogs: options.logs ?? false,
      notifyApproval: async (request) => void this.approvals.push({ ...request, message: request.message ?? "" }),
      ...(this.plan ? planGuards(PLANS[this.plan]) : {}),
      ...(secrets.length ? { secrets: () => secrets } : {}),
      invoke: (request, journal) =>
        executePass(guarded, request, {
          journal,
          config,
          providers,
          owner: { notify: async (m) => (this.ownerNotifications.push(secrets.length ? this.manager.redact(m) : m), { sent: true }) },
        }),
    });
    openHarnesses++;
    if (options.fakeDate !== false) globalThis.Date = TestDate as DateConstructor;
    this.activate();
  }

  /** The test clock, epoch ms. */
  now(): number {
    return this.clock;
  }

  /** Start a run. The input is validated with the input schema first, as the platform does. */
  async start(input: unknown = {}, opts: { trigger?: Trigger | TriggerKind; idempotencyKey?: string } = {}): Promise<TestRun<OutputOf<A>>> {
    this.activate();
    const parsed = this.actuator.input.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid input:${formatIssues(parsed.error.issues)}`);
    const trigger = typeof opts.trigger === "string" ? { kind: opts.trigger } : (opts.trigger ?? { kind: "api" as const });
    const { run } = await this.manager.start({
      input: parsed.data as Json,
      trigger,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    return run as TestRun<OutputOf<A>>;
  }

  /** Fire a cron schedule: a run with the input `{}`. Default: the actuator's first schedule. */
  async cron(expression = this.actuator.cron?.[0] ?? "* * * * *"): Promise<TestRun<OutputOf<A>>> {
    this.activate();
    const parsed = this.actuator.input.safeParse({});
    if (!parsed.success) throw new Error(`Cron runs start with the input {}, which the input schema rejects:${formatIssues(parsed.error.issues)}`);
    return (await this.manager.start({ input: parsed.data as Json, trigger: { kind: "cron", cron: expression } })).run as TestRun<OutputOf<A>>;
  }

  /** A run's record, its output typed as the actuator's (or as `T`). Throws if there is no such run. */
  run<T = OutputOf<A>>(runId: string): TestRun<T> {
    const run = this.manager.getRun(runId);
    if (!run) throw new Error(`No run ${runId}.`);
    return run as TestRun<T>;
  }

  steps(runId: string): StepRecord[] {
    return this.manager.getSteps(runId);
  }

  logs(runId: string): LogRecord[] {
    return this.manager.getLogs(runId);
  }

  /**
   * Move the clock forward, firing every alarm on the way in order, as the
   * Durable Object would: a run that sleeps twice inside the window wakes twice.
   */
  async advance(by: Duration): Promise<void> {
    await this.advanceTo(this.clock + parseDuration(by));
  }

  async advanceTo(time: number | string | Date): Promise<void> {
    this.activate();
    const target = new RealDate(time).getTime();
    for (let i = 0; i < 10_000; i++) {
      const next = this.manager.nextWakeAt();
      if (next === null || next > target) break;
      this.clock = Math.max(this.clock, next);
      await this.manager.alarm();
    }
    this.clock = Math.max(this.clock, target);
    await this.manager.alarm();
  }

  /** Post an event, as `POST /events/:key` does. */
  event(key: string, payload: Json = {}): Promise<{ resumed: string[]; buffered: boolean }> {
    this.activate();
    return this.manager.deliverEvent(key, payload);
  }

  /** Pay a bill: the `payment.<referenceId>` event a payment provider's webhook delivers, filled in from the bill. */
  pay(referenceId: string, payment: Partial<PaymentEvent> = {}): Promise<{ resumed: string[]; buffered: boolean }> {
    const bill = this.bills.findLast((b) => b.referenceId === referenceId);
    const event: PaymentEvent = {
      provider: "test",
      status: "paid",
      referenceId,
      ...(bill ? { billId: bill.id, amount: bill.amount, currency: bill.currency ?? "MYR" } : {}),
      ...payment,
    };
    if (bill) this.paidStatus.set(bill.id, event.status);
    return this.event(`payment.${referenceId}`, event as unknown as Json);
  }

  /**
   * Approve a waiting `waitForApproval` through its signed link, as a click would. Default: the most recent request.
   * Throws, saying what is waiting, when nothing matches or the link is refused; to test a refusal, use {@link followLink}.
   */
  approve(step?: string, opts: DecideOptions = {}): Promise<void> {
    return this.decide("approval", step, opts, (token) => this.manager.decide(token, { ...(opts.note ? { note: opts.note } : {}), ...(opts.by ? { by: opts.by } : {}) }), "approve");
  }

  reject(step?: string, opts: DecideOptions = {}): Promise<void> {
    return this.decide("approval", step, opts, (token) => this.manager.decide(token, { ...(opts.note ? { note: opts.note } : {}), ...(opts.by ? { by: opts.by } : {}) }), "reject");
  }

  /** Answer a waiting `waitForInput` through its signed form link. */
  answer(text: string, opts: DecideOptions & { step?: string } = {}): Promise<void> {
    return this.decide("input", opts.step, opts, (token) => this.manager.decide(token, { text, ...(opts.by ? { by: opts.by } : {}) }), "answer");
  }

  /**
   * Follow a signed link (an `approveUrl`, `rejectUrl` or `answerUrl` from {@link approvals}) as a person would,
   * and return what happened instead of throwing: use it to test that an expired or used link is refused.
   * `text` answers a waitForInput; `note` goes with an approval.
   */
  async followLink(url: string, opts: { note?: string; text?: string; by?: string } = {}): Promise<LinkResult> {
    this.activate();
    const token = new URL(url).searchParams.get("token") ?? "";
    return this.manager.decide(token, { ...(opts.note ? { note: opts.note } : {}), ...(opts.text !== undefined ? { text: opts.text } : {}), ...(opts.by ? { by: opts.by } : {}) });
  }

  /** Steps waiting for a person, oldest first. */
  pending(): ReturnType<RunManager["pendingApprovals"]> {
    return this.manager.pendingApprovals();
  }

  /** Every row of one of your tables. */
  rows<T extends object = Row>(table: string): T[] {
    const tables = this.manager.listTables();
    if (!tables.includes(table)) throw new Error(`No table "${table}". Tables: ${tables.join(", ") || "none yet (has a run applied the migrations?)"}.`);
    // node:sqlite rows have no prototype, which node:assert's deepStrictEqual reports as a difference: copy them.
    return this.manager.readTable(table, { limit: 10_000 }).rows.map((r) => ({ ...r })) as T[];
  }

  /** Run SQL directly against the database, unmetered, for assertions. */
  query<T extends object = Row>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])).map((r) => ({ ...r })) as T[];
  }

  /**
   * Rows read and written by one run, in the units the platform bills,
   * journal included (estimated: see `meteredNodeSqlite`), and its passes.
   * Without a run ID, the totals of every run.
   */
  usage(runId?: string): RunUsage & { passes: number } {
    if (runId) return { ...this.tracker.of(runId), passes: this.run(runId).passes };
    const runs = this.manager.listRuns({ limit: 500 });
    const total = { statements: 0, rowsRead: 0, rowsWritten: 0, passes: 0 };
    for (const r of runs) {
      const u = this.tracker.of(r.runId);
      total.statements += u.statements;
      total.rowsRead += u.rowsRead;
      total.rowsWritten += u.rowsWritten;
      total.passes += r.passes;
    }
    return total;
  }

  /** Close the database and give `Date` back once the last open test closes. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    if (--openHarnesses === 0) {
      globalThis.Date = RealDate;
      activeClock = null;
    }
  }

  /** The most recent test touched owns `Date`. */
  private activate(): void {
    if (this.closed) throw new Error("This test actuator is closed.");
    activeClock = () => this.clock;
  }

  private async decide(
    kind: "approval" | "input",
    step: string | undefined,
    opts: DecideOptions,
    apply: (token: string) => Promise<{ ok: true } | { ok: false; reason: string }>,
    action: "approve" | "reject" | "answer",
  ): Promise<void> {
    this.activate();
    const waiting = this.manager.pendingApprovals();
    const target = waiting.filter((p) => p.kind === kind && (!step || p.step === step) && (!opts.runId || p.runId === opts.runId)).at(-1);
    if (!target) {
      const what = kind === "input" ? "question (waitForInput)" : "approval (waitForApproval)";
      const list = waiting.map((p) => `"${p.step}" (${p.kind}, ${p.runId})`).join(", ");
      throw new Error(`No ${what} is waiting${step ? ` at step "${step}"` : ""}. Waiting: ${list || "nothing"}.`);
    }
    const links = await this.manager.approvalLinks(target.runId, target.step);
    const url = !links ? undefined : action === "answer" ? (links as { answerUrl?: string }).answerUrl : (links as { approveUrl?: string; rejectUrl?: string })[action === "approve" ? "approveUrl" : "rejectUrl"];
    if (!url) throw new Error(`No link to ${action} "${target.step}".`);
    const result = await apply(new URL(url).searchParams.get("token") ?? "");
    if (!result.ok) throw new Error(result.reason);
  }

  private fakes(): Partial<Providers> {
    const allow = this.actuator.http?.allow ?? [];
    const http = this.options.http;
    return {
      messaging: {
        send: async (to, text, options) => {
          this.messages.push({ to, text, ...(options ? { options } : {}) });
          return { id: `msg-${this.messages.length}`, channel: options?.channel ?? "test" };
        },
      },
      payment: {
        createBill: async (request) => {
          const known = request.idempotencyKey ? this.billKeys.get(request.idempotencyKey) : undefined;
          if (known) return this.bill(known)!;
          const id = `bill-${this.bills.length + 1}`;
          this.bills.push({ ...request, id });
          if (request.idempotencyKey) this.billKeys.set(request.idempotencyKey, id);
          return this.bill(id)!;
        },
        getBill: async (id) => {
          const bill = this.bill(id);
          if (!bill) throw new Error(`Unknown bill ${id}`);
          return bill;
        },
        refund: async (request) => {
          const known = request.idempotencyKey ? this.refundKeys.get(request.idempotencyKey) : undefined;
          if (known) return { id: known, status: "succeeded" as const };
          this.refunds.push(request);
          const id = `refund-${this.refunds.length}`;
          if (request.idempotencyKey) this.refundKeys.set(request.idempotencyKey, id);
          return { id, status: "succeeded" as const };
        },
      },
      llm: {
        complete: async (request) => {
          this.prompts.push(request);
          const reply = typeof this.options.llm === "function" ? await this.options.llm(request) : this.llmReplies.shift();
          if (reply === undefined) {
            throw new Error("testActuator: ctx.llm.complete was called with no reply queued. Pass testActuator(actuator, { llm: [\"...\"] }).");
          }
          return typeof reply === "string" ? { text: reply, model: "test" } : reply;
        },
      },
      http: createHttpProvider({
        allow,
        fetch: async (input, init) => {
          const request = new Request(input as string, init);
          this.requests.push(request.clone());
          if (!http) {
            throw new Error(`testActuator: ctx.http.fetch(${request.url}) was called, but no http handler was given. Pass testActuator(actuator, { http: (request) => ({ ok: true }) }).`);
          }
          const out = await http(request);
          return out instanceof Response ? out : Response.json(out);
        },
      }),
    };
  }

  private bill(id: string): Bill | undefined {
    const b = this.bills.find((x) => x.id === id);
    if (!b) return undefined;
    return {
      id,
      url: `https://pay.test/${encodeURIComponent(b.referenceId)}`,
      status: this.paidStatus.get(id) ?? "pending",
      amount: b.amount,
      currency: b.currency ?? "MYR",
      referenceId: b.referenceId,
    };
  }
}
