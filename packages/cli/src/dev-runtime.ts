/**
 * The runtime `actuate dev` serves: `createRuntime` plus the hosted
 * platform's guards (for a plan, unless turned off) and a rows meter that
 * attributes Cloudflare's own SQLite counters to runs. `GET /runs/:id`,
 * `GET /runs` and the run records `POST /run` returns gain a `usage` field:
 * `{ statements, rowsRead, rowsWritten }`. Reads made to answer `GET`
 * requests (such as `actuate logs`) are not counted against a run.
 *
 * Bundled into workerd by `actuate dev`, so no Node imports.
 */
import { createRuntime, type ActuatorObjectInstance, type Runtime, type RuntimeEnv, type RuntimeOptions } from "@actuate/runtime/worker";
import type { Actuator } from "@actuate/sdk";
import { planGuards, withPlatformGuards } from "./guards.js";
import { PLANS, type PlanId } from "./plans.js";
import { UsageTracker, type RunUsage } from "./usage.js";

export interface DevRuntimeOptions<E extends RuntimeEnv = RuntimeEnv> extends RuntimeOptions<E> {
  /** Whose guards apply; null turns them off. */
  plan: PlanId | null;
}

/** The parts of DurableObjectState the dev wrapper touches. */
export interface DevState {
  storage: {
    sql: { exec(query: string, ...params: unknown[]): DevCursor };
    transactionSync?<T>(fn: () => T): T;
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export interface DevCursor {
  toArray(): unknown[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly columnNames?: string[];
}

const USAGE_KEY = "actuate-dev:usage";
const RUN_PATHS = /^\/(run|webhook|runs(\/[^/]+(\/resume)?)?)$/;

/** Count every statement's billed rows (Cloudflare's own counters) into `usage`. */
export function meterSql(state: DevState, usage: UsageTracker): void {
  // A transaction's statements are attributed together (see UsageTracker.transaction).
  const transactionSync = state.storage.transactionSync?.bind(state.storage);
  if (transactionSync) state.storage.transactionSync = <T>(fn: () => T): T => usage.transaction(() => transactionSync(fn));
  const sql = state.storage.sql;
  const exec = sql.exec.bind(sql);
  sql.exec = (query: string, ...params: unknown[]): DevCursor => {
    const cursor = exec(query, ...params);
    const rows = cursor.toArray();
    usage.record(params, { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten });
    return {
      toArray: () => rows,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
      ...(cursor.columnNames ? { columnNames: cursor.columnNames } : {}),
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    } as DevCursor;
  };
}

/** Add `usage` to run records in a JSON response. */
export async function withUsage(path: string, response: Response, usage: UsageTracker): Promise<Response> {
  if (!RUN_PATHS.test(path) || !(response.headers.get("content-type") ?? "").includes("json")) return response;
  const body = (await response.json()) as unknown;
  const add = (r: unknown) => {
    if (r && typeof r === "object" && typeof (r as { runId?: unknown }).runId === "string") {
      (r as { usage?: RunUsage }).usage = usage.of((r as { runId: string }).runId);
    }
  };
  if (Array.isArray(body)) body.forEach(add);
  else add(body);
  return new Response(JSON.stringify(body, null, 2), { status: response.status, headers: response.headers });
}

export interface DevRuntime<E extends RuntimeEnv> {
  worker: Runtime<E>["worker"];
  ActuatorObject: new (state: DevState, env: E) => ActuatorObjectInstance;
  usage: UsageTracker;
}

export function createDevRuntime<E extends RuntimeEnv = RuntimeEnv>(actuator: Actuator, options: DevRuntimeOptions<E>): DevRuntime<E> {
  const usage = new UsageTracker();
  const plan = options.plan ? PLANS[options.plan] : null;
  const warned = new Set<string>();
  // With the guards off, the wrapper still attributes ctx.db rows to runs.
  const guarded = withPlatformGuards(actuator, {
    usage,
    enforce: plan !== null,
    onTrip: (message) => {
      if (warned.has(message)) return;
      warned.add(message);
      console.warn(
        `\n🛑  [platform guard] ${message}\n    The hosted platform stops a pass here too (${plan?.name} plan). Restart with --no-guards to turn the local guards off.\n`,
      );
    },
  });
  const { plan: _plan, ...runtimeOptions } = options;
  const runtime = createRuntime<E>(guarded, {
    ...runtimeOptions,
    ...(plan ? { guards: { ...planGuards(plan), ...runtimeOptions.guards } } : {}),
  });

  const Base = runtime.ActuatorObject as unknown as new (state: DevState, env: E) => ActuatorObjectInstance;
  class DevActuatorObject extends Base {
    private readonly state: DevState;

    constructor(state: DevState, env: E) {
      meterSql(state, usage);
      super(state, env);
      this.state = state;
      void state.blockConcurrencyWhile(async () => usage.load(await state.storage.get<Record<string, RunUsage>>(USAGE_KEY)));
    }

    override async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      // Reads that answer a request (actuate logs, the table browser) aren't part of any run's cost.
      const read = (request.method === "GET" || request.method === "HEAD") && !path.startsWith("/events/");
      if (read) usage.paused++;
      let response: Response;
      try {
        response = await super.fetch(request);
      } finally {
        if (read) usage.paused--;
      }
      await this.flush();
      return withUsage(path, response, usage);
    }

    override async alarm(): Promise<void> {
      await super.alarm();
      await this.flush();
    }

    override async cron(expression: string): Promise<void> {
      await super.cron(expression);
      await this.flush();
    }

    private async flush(): Promise<void> {
      if (!usage.dirty) return;
      usage.dirty = false;
      await this.state.storage.put(USAGE_KEY, usage.toJSON());
    }
  }

  return { worker: runtime.worker, ActuatorObject: DevActuatorObject, usage };
}
