import { DurableObject } from "cloudflare:workers";
import { z, type Actuator, type Json, type Providers } from "@actuate/sdk";
import { RunManager, type ApprovalRequest, type RunManagerOptions, type RunStatus } from "./manager.js";
import { executePass } from "./pass.js";
import { createHttpProvider } from "./providers.js";
import { durableObjectSql } from "./sql.js";
import { approvalPage, toCsv } from "./http-util.js";

export interface RuntimeEnv {
  ACTUATOR: DurableObjectNamespace;
  /** JSON object of configuration values, validated against the actuator's ConfigSchema. */
  ACTUATE_CONFIG?: string;
  /** Bearer token required for the admin API (runs, events, tables). Unset means open (local dev only). */
  ACTUATE_TOKEN?: string;
  /** Shared secret for POST /webhook, sent as `x-actuate-secret` or `?secret=`. */
  ACTUATE_WEBHOOK_SECRET?: string;
  /** HMAC secret for approval links. Generated and stored on first use if unset. */
  ACTUATE_APPROVAL_SECRET?: string;
  /** Public origin, e.g. https://bot.example.com. Defaults to the origin of the first request; set it in production. */
  ACTUATE_PUBLIC_URL?: string;
  /** "1" only under `actuate dev`: serves admin routes and webhooks without secrets. */
  ACTUATE_DEV?: string;
  [key: string]: unknown;
}

export interface RuntimeOptions<E extends RuntimeEnv = RuntimeEnv> {
  /** Build the configured providers from the environment (secrets live in env). */
  providers?: (env: E, publicUrl: string) => Partial<Providers>;
  /** Resolve raw configuration; defaults to parsing `env.ACTUATE_CONFIG`. */
  config?: (env: E) => unknown;
  /**
   * Verify an inbound provider webhook (POST /providers/:kind/webhook) and map it to an event.
   * Return null to ignore it; throw an error named WebhookVerificationError to answer 401.
   * `@actuate/providers` provides `parseProviderWebhookFromEnv` for this.
   */
  providerWebhook?: (kind: string, request: Request, env: E) => Promise<{ event: string; payload: Json } | null>;
  /** Runtime guards passed to the RunManager (wait/retry limits, pass admission, event caps, max passes). */
  guards?: Pick<RunManagerOptions, "passLimits" | "admitPass" | "maxBufferedEvents" | "maxEventBytes" | "maxPasses" | "maxLogLinesPerPass">;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/**
 * Build a self-contained Worker and Durable Object for one actuator:
 *
 * ```ts
 * import actuator from "./actuator";
 * import { createRuntime } from "@actuate/runtime/worker";
 * const runtime = createRuntime(actuator);
 * export default runtime.worker;
 * export const ActuatorObject = runtime.ActuatorObject;
 * ```
 */
export interface ActuatorObjectInstance {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
  cron(expression: string): Promise<void>;
}

export interface Runtime<E extends RuntimeEnv> {
  worker: ExportedHandler<E>;
  ActuatorObject: new (state: DurableObjectState, env: E) => ActuatorObjectInstance;
}

export function createRuntime<E extends RuntimeEnv = RuntimeEnv>(actuator: Actuator, options: RuntimeOptions<E> = {}): Runtime<E> {
  const configSchema = actuator.config ?? z.object({});

  class ActuatorObject extends DurableObject<E> {
    private manager!: RunManager;
    private publicUrl = "";
    private providers: Partial<Providers> = {};
    private config: unknown;
    private configError: string | null = null;

    constructor(state: DurableObjectState, env: E) {
      super(state, env);
      state.blockConcurrencyWhile(async () => {
        let secret = env.ACTUATE_APPROVAL_SECRET ?? (await state.storage.get<string>("approval_secret"));
        if (!secret) {
          secret = crypto.randomUUID() + crypto.randomUUID();
          await state.storage.put("approval_secret", secret);
        }
        this.publicUrl = env.ACTUATE_PUBLIC_URL ?? (await state.storage.get<string>("public_url")) ?? "";
        this.loadConfig();
        this.manager = new RunManager({
          ...options.guards,
          sql: durableObjectSql(state.storage),
          approvalSecret: secret,
          approvalUrl: () => `${this.publicUrl}/approve`,
          invoke: (request, journal) =>
            this.configError
              ? Promise.resolve({ status: "failed", error: { name: "ConfigError", message: this.configError } })
              : executePass(actuator, request, { journal, config: this.config, providers: this.getProviders() }),
          notifyApproval: (req) => this.notifyApproval(req),
          scheduleWake: async (at) => {
            if (at === null) await state.storage.deleteAlarm();
            else await state.storage.setAlarm(Math.max(at, Date.now()));
          },
        });
      });
    }

    private loadConfig(): void {
      try {
        const raw = options.config ? options.config(this.env) : JSON.parse(this.env.ACTUATE_CONFIG ?? "{}");
        const parsed = configSchema.safeParse(raw);
        if (parsed.success) this.config = parsed.data;
        else this.configError = `Invalid configuration: ${parsed.error.message}`;
      } catch (err) {
        this.configError = `Invalid ACTUATE_CONFIG: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    private getProviders(): Partial<Providers> {
      if (!this.providers.messaging && !this.providers.payment && !this.providers.llm && !this.providers.http) {
        this.providers = { ...(options.providers?.(this.env, this.publicUrl) ?? {}) };
        if (actuator.http?.allow && !this.providers.http) {
          this.providers.http = createHttpProvider({ allow: actuator.http.allow, selfOrigins: this.publicUrl ? [this.publicUrl] : [] });
        }
      }
      return this.providers;
    }

    private async notifyApproval(req: ApprovalRequest): Promise<void> {
      const text =
        req.kind === "input"
          ? `${req.message ?? `${actuator.name} needs your input`}\n\nAnswer: ${req.answerUrl}`
          : `${req.message ?? `Approval needed: ${actuator.name} / ${req.step}`}\n\nApprove: ${req.approveUrl}\nReject: ${req.rejectUrl}`;
      const messaging = this.getProviders().messaging;
      if (req.notify && messaging) await messaging.send(req.notify, text, { subject: `Approval needed: ${actuator.name}` });
      else console.log(`\n🔐  [approval requested] ${text}\n`);
    }

    private async rememberOrigin(url: URL): Promise<void> {
      if (this.publicUrl) return;
      this.publicUrl = url.origin;
      await this.ctx.storage.put("public_url", this.publicUrl);
    }

    /** RPC: start a run from a cron trigger. */
    async cron(expression: string): Promise<void> {
      const input = actuator.input.safeParse({});
      if (!input.success) {
        console.error(`[actuate] cron "${expression}": input schema rejects {}: ${input.error.message}`);
        return;
      }
      await this.manager.start({ input: input.data as Json, trigger: { kind: "cron", cron: expression } });
    }

    override async alarm(): Promise<void> {
      await this.manager.alarm();
    }

    override async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      await this.rememberOrigin(url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method;
      const m = this.manager;

      try {
        // Public routes.
        if (path === "/health") return json({ ok: true });
        if (path === "/approve" && method === "GET") {
          const token = url.searchParams.get("token") ?? "";
          return new Response(approvalPage(actuator.name, token, await m.describeLink(token)), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (path === "/approve" && method === "POST") {
          const form = new URLSearchParams((await request.text()).slice(0, 64 * 1024));
          const result = await m.decide(String(form.get("token") ?? ""), {
            note: form.get("note") ?? undefined,
            text: form.get("text") ?? undefined,
          });
          const message = result.ok
            ? form.has("text")
              ? "Answer sent. You can close this page."
              : result.approved
                ? "Approved. You can close this page."
                : "Rejected. You can close this page."
            : result.reason;
          return new Response(approvalPage(actuator.name, "", null, message), {
            status: result.ok ? 200 : 410,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        const providerHook = /^\/providers\/([a-z0-9-]+)\/webhook$/.exec(path);
        if (providerHook && options.providerWebhook) {
          try {
            const event = await options.providerWebhook(providerHook[1]!, request, this.env);
            if (!event) return json({ ignored: true });
            return json({ event: event.event, ...(await m.deliverEvent(event.event, event.payload)) });
          } catch (err) {
            if ((err as Error)?.name === "WebhookVerificationError") return json({ error: (err as Error).message }, 401);
            throw err;
          }
        }
        // Fail closed: without secrets, only `actuate dev` (ACTUATE_DEV=1) serves the open routes.
        const dev = this.env.ACTUATE_DEV === "1";
        if (path === "/webhook" && method === "POST") {
          const secret = this.env.ACTUATE_WEBHOOK_SECRET;
          if (!secret && !dev) return json({ error: "Set ACTUATE_WEBHOOK_SECRET to accept webhooks." }, 503);
          const given = request.headers.get("x-actuate-secret") ?? url.searchParams.get("secret") ?? "";
          if (secret && !safeEqual(given, secret)) return json({ error: "unauthorized" }, 401);
          return this.startRun(request, "webhook");
        }

        // Admin routes.
        const token = this.env.ACTUATE_TOKEN;
        if (!token && !dev) return json({ error: "Set ACTUATE_TOKEN to use the admin API." }, 503);
        if (token && !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${token}`)) return json({ error: "unauthorized" }, 401);

        if (path === "/" && method === "GET") {
          return json({
            name: actuator.name,
            description: actuator.description,
            capabilities: actuator.capabilities ?? [],
            input: z.toJSONSchema(actuator.input, { io: "input", unrepresentable: "any" }),
            config: z.toJSONSchema(configSchema, { io: "input", unrepresentable: "any" }),
            configError: this.configError,
          });
        }
        if (path === "/run" && method === "POST") return this.startRun(request, "api");
        if (path === "/runs" && method === "GET") {
          const status = url.searchParams.get("status") as RunStatus | null;
          return json(
            m.listRuns({
              limit: Number(url.searchParams.get("limit") ?? 50),
              ...(url.searchParams.has("before") ? { before: url.searchParams.get("before")! } : {}),
              ...(status ? { status } : {}),
            }),
          );
        }
        if (path === "/approvals" && method === "GET") return json(m.pendingApprovals());
        const linksMatch = /^\/runs\/([^/]+)\/approvals\/([^/]+)\/links$/.exec(path);
        if (linksMatch && method === "GET") {
          const links = await m.approvalLinks(decodeURIComponent(linksMatch[1]!), decodeURIComponent(linksMatch[2]!));
          return links ? json(links) : json({ error: "No approval is waiting for that step." }, 404);
        }
        const runMatch = /^\/runs\/([^/]+)(\/cancel|\/resume|\/approvals\/([^/]+)\/(approve|reject))?$/.exec(path);
        if (runMatch) {
          const runId = decodeURIComponent(runMatch[1]!);
          if (!runMatch[2] && method === "GET") {
            const run = m.getRun(runId);
            return run ? json({ ...run, steps: m.getSteps(runId), logs: m.getLogs(runId) }) : json({ error: "not found" }, 404);
          }
          if (runMatch[2] === "/cancel" && method === "POST") return json({ cancelled: m.cancel(runId) });
          if (runMatch[2] === "/resume" && method === "POST") {
            await m.resume(runId);
            return json(m.getRun(runId));
          }
          if (runMatch[3] && method === "POST") {
            const body = (await request.json().catch(() => ({}))) as { note?: string };
            return json(await m.decideDirect(runId, decodeURIComponent(runMatch[3]), runMatch[4] === "approve", body.note));
          }
        }
        const eventMatch = /^\/events\/(.+)$/.exec(path);
        if (eventMatch && (method === "POST" || method === "GET")) {
          // GET is accepted so the dev payment provider's "bill URL" can be clicked in a browser.
          const key = decodeURIComponent(eventMatch[1]!);
          const payload =
            method === "POST"
              ? (((await request.json().catch(() => null)) as Json) ?? {})
              : key.startsWith("payment.")
                ? ({ provider: "dev", status: "paid", referenceId: key.slice("payment.".length), via: "GET" } as Json)
                : ({ via: "GET" } as Json);
          return json(await m.deliverEvent(key, payload));
        }
        if (path === "/tables" && method === "GET") return json(m.listTables());
        const tableMatch = /^\/tables\/([^/]+)$/.exec(path);
        if (tableMatch && method === "GET") {
          if (!m.listTables().includes(decodeURIComponent(tableMatch[1]!))) return json({ error: "Unknown table" }, 404);
          const data = m.readTable(decodeURIComponent(tableMatch[1]!), {
            limit: Number(url.searchParams.get("limit") ?? 100),
            offset: Number(url.searchParams.get("offset") ?? 0),
          });
          if (url.searchParams.get("format") === "csv") {
            return new Response(toCsv(data.columns, data.rows), {
              headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${tableMatch[1]}.csv"` },
            });
          }
          return json(data);
        }
        return json({ error: "not found" }, 404);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    private async startRun(request: Request, kind: "api" | "webhook"): Promise<Response> {
      const body = await request.json().catch(() => undefined);
      if (body === undefined) return json({ error: "Request body must be JSON." }, 400);
      const parsed = actuator.input.safeParse(body);
      if (!parsed.success) return json({ error: "Invalid input", issues: parsed.error.issues }, 400);
      const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
      const { run, created } = await this.manager.start({
        input: parsed.data as Json,
        trigger: { kind },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      return json(run, created ? 201 : 200);
    }
  }

  const worker: ExportedHandler<E> = {
    fetch(request, env) {
      return env.ACTUATOR.get(env.ACTUATOR.idFromName("default")).fetch(request);
    },
    async scheduled(controller, env, ctx) {
      const stub = env.ACTUATOR.get(env.ACTUATOR.idFromName("default")) as unknown as { cron(expr: string): Promise<void> };
      ctx.waitUntil(stub.cron(controller.cron));
    },
  };

  return { worker, ActuatorObject };
}
