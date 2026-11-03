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
  createHttpProvider,
  executePass,
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
 * as the platform does.
 */
export function testActuator(actuator: Actuator, options: TestActuatorOptions = {}): ActuatorTest {
  return new ActuatorTest(actuator, options);
}

export class ActuatorTest {
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
  /** Approval and input requests as the runtime sent them, links included. */
  readonly approvals: ApprovalRequest[] = [];
  readonly manager: RunManager;
  readonly db: DatabaseSync;
  /** The plan whose guards apply, or null when they are off. */
  readonly plan: PlanId | null;

  private clock: number;
  private readonly tracker = new UsageTracker();
  private readonly paidStatus = new Map<string, Bill["status"]>();
  private closed = false;

  constructor(
    private readonly actuator: Actuator,
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
      notifyApproval: async (request) => void this.approvals.push(request),
      ...(this.plan ? planGuards(PLANS[this.plan]) : {}),
      invoke: (request, journal) => executePass(guarded, request, { journal, config, providers }),
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
  async start(input: unknown = {}, opts: { trigger?: Trigger | TriggerKind; idempotencyKey?: string } = {}): Promise<RunRecord> {
    this.activate();
    const parsed = this.actuator.input.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid input:${formatIssues(parsed.error.issues)}`);
    const trigger = typeof opts.trigger === "string" ? { kind: opts.trigger } : (opts.trigger ?? { kind: "api" as const });
    const { run } = await this.manager.start({
      input: parsed.data as Json,
      trigger,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    return run;
  }

  /** Fire a cron schedule: a run with the input `{}`. Default: the actuator's first schedule. */
  async cron(expression = this.actuator.cron?.[0] ?? "* * * * *"): Promise<RunRecord> {
    this.activate();
    const parsed = this.actuator.input.safeParse({});
    if (!parsed.success) throw new Error(`Cron runs start with the input {}, which the input schema rejects:${formatIssues(parsed.error.issues)}`);
    return (await this.manager.start({ input: parsed.data as Json, trigger: { kind: "cron", cron: expression } })).run;
  }

  /** A run's record. Throws if there is no such run. */
  run(runId: string): RunRecord {
    const run = this.manager.getRun(runId);
    if (!run) throw new Error(`No run ${runId}.`);
    return run;
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

  /** Approve a waiting `waitForApproval` through its signed link, as a click would. Default: the most recent request. */
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

  /** Steps waiting for a person, oldest first. */
  pending(): ReturnType<RunManager["pendingApprovals"]> {
    return this.manager.pendingApprovals();
  }

  /** Every row of one of your tables. */
  rows<T extends object = Row>(table: string): T[] {
    const tables = this.manager.listTables();
    if (!tables.includes(table)) throw new Error(`No table "${table}". Tables: ${tables.join(", ") || "none yet (has a run applied the migrations?)"}.`);
    return this.manager.readTable(table, { limit: 10_000 }).rows as T[];
  }

  /** Run SQL directly against the database, unmetered, for assertions. */
  query<T extends object = Row>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
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
          const id = `bill-${this.bills.length + 1}`;
          this.bills.push({ ...request, id });
          return this.bill(id)!;
        },
        getBill: async (id) => {
          const bill = this.bill(id);
          if (!bill) throw new Error(`Unknown bill ${id}`);
          return bill;
        },
        refund: async (request) => {
          this.refunds.push(request);
          return { id: `refund-${this.refunds.length}`, status: "succeeded" as const };
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
