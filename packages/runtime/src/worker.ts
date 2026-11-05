import { DurableObject } from "cloudflare:workers";
import { z, type Actuator, type Json, type Providers } from "@actuate/sdk";
import { RunManager, type ApprovalRequest, type RunManagerOptions, type RunStatus } from "./manager.js";
import { executePass } from "./pass.js";
import { createHttpProvider } from "./providers.js";
import { collectSecrets, mergeSecrets, redactSecrets } from "./secrets.js";
import { durableObjectSql } from "./sql.js";
import { approvalPage, toCsv } from "./http-util.js";

export interface RuntimeEnv {
  ACTUATOR: DurableObjectNamespace;
  /** JSON object of configuration values, validated against the actuator's ConfigSchema. */
  ACTUATE_CONFIG?: string;
  /** The owner's bearer token: every admin route (runs, approvals, events, tables). Unset means open (local dev only). */
  ACTUATE_TOKEN?: string;
  /**
   * A bearer token to give an agent: it can describe the actuator, start runs (POST /run) and read
   * one run (GET /runs/:runId), and nothing else. It never approves, answers, posts events or reads tables,
   * so the agent a run is gated against can't let itself through.
   */
  ACTUATE_RUN_TOKEN?: string;
  /** Secret for POST /webhook: sent as `x-actuate-secret` or `?secret=`, or used to sign the body (`X-Hub-Signature-256`). */
  ACTUATE_WEBHOOK_SECRET?: string;
  /** HMAC secret for approval links. Generated and stored on first use if unset. */
  ACTUATE_APPROVAL_SECRET?: string;
  /**
   * Public origin, e.g. https://bot.example.com. Set it in production. If unset, the origin of the first request
   * made with ACTUATE_TOKEN is used (under `actuate dev`, the first request to localhost).
   */
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
  providerWebhook?: (kind: string, request: Request, env: E) => Promise<ProviderWebhookOutcome>;
  /** Runtime guards passed to the RunManager (wait/retry limits, pass admission, event caps, max passes). */
  guards?: Pick<RunManagerOptions, "passLimits" | "admitPass" | "maxBufferedEvents" | "maxEventBytes" | "maxPasses" | "maxLogLinesPerPass">;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** The page behind a signed link carries the token: never cache it, never frame it. */
const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
    },
  });

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `actuate dev` serves routes whose secret is unset without one. Those answer only requests made on this
 * machine and not by a web page: a page the developer has open could otherwise start runs (with the real
 * providers in .dev.vars) or, through DNS rebinding, read them. Returns why a request is refused, or null.
 */
function devOpenRouteRefusal(request: Request, url: URL): string | null {
  if (!LOOPBACK.has(url.hostname)) {
    return `Without a secret, actuate dev serves this route only on localhost (got host "${url.hostname}"). Set ACTUATE_TOKEN or ACTUATE_WEBHOOK_SECRET in .dev.vars to use it from elsewhere.`;
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "Cross-site requests are refused by actuate dev.";
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return "Cross-origin requests are refused by actuate dev.";
  return null;
}

/** Routes an agent's ACTUATE_RUN_TOKEN reaches: describe, start a run, read one run. */
function agentRoute(method: string, path: string): boolean {
  if (method === "GET" && path === "/") return true;
  if (method === "POST" && path === "/run") return true;
  return method === "GET" && /^\/runs\/[^/]+$/.test(path);
}

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

/** The values of the config's secret fields, from its JSON Schema (`writeOnly`), raw and parsed. */
function configSecrets(schema: z.ZodType, raw: unknown, parsed: unknown): string[] {
  let jsonSchema: unknown;
  try {
    jsonSchema = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return [];
  }
  return mergeSecrets(collectSecrets(jsonSchema, raw), parsed === undefined ? [] : collectSecrets(jsonSchema, parsed));
}

type ProviderWebhookEvent = { event: string; payload: Json };
/** What a provider webhook handler returns: events to deliver, none, or a plain-text handshake reply. */
export type ProviderWebhookOutcome = ProviderWebhookEvent | ProviderWebhookEvent[] | { reply: string } | null;

export function createRuntime<E extends RuntimeEnv = RuntimeEnv>(actuator: Actuator, options: RuntimeOptions<E> = {}): Runtime<E> {
  const configSchema = actuator.config ?? z.object({});

  class ActuatorObject extends DurableObject<E> {
    private manager!: RunManager;
    private publicUrl = "";
    private providers: Partial<Providers> = {};
    private config: unknown;
    private configError: string | null = null;
    /** Values of the config's secret (writeOnly) fields, kept out of logs, errors and every run read. */
    private secrets: string[] = [];

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
          secrets: () => this.secrets,
          approvalSecret: secret,
          approvalUrl: () => {
            if (!this.publicUrl) console.warn("[actuate] ACTUATE_PUBLIC_URL is not set, so approval links are relative. Set it to this actuator's origin.");
            return `${this.publicUrl}/approve`;
          },
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
        // Secrets from the raw config too: an invalid config, or one a transform changes, still holds them.
        this.secrets = configSecrets(configSchema, raw, parsed.success ? parsed.data : undefined);
        if (parsed.success) this.config = parsed.data;
        else this.configError = redactSecrets(`Invalid configuration: ${parsed.error.message}`, this.secrets);
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

    /**
     * Without ACTUATE_PUBLIC_URL, learn the origin for approval links and provider callbacks. Only from a
     * request we trust to name it: anyone can send a Host header, and the origin is kept for good, so the
     * first stranger to call would otherwise choose where every approval link (and its token) points.
     */
    private async rememberOrigin(url: URL): Promise<void> {
      if (this.publicUrl) return;
      this.publicUrl = url.origin;
      this.providers = {}; // rebuilt with the new callback URLs
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
      const response = await this.route(request);
      // Most routes ignore the body. Left unread, workerd logs "Can't read from request stream
      // after response has been sent" for every such request. Cancelling the stream doesn't stop
      // it, so read it to the end, a chunk at a time so a large body isn't held in memory.
      if (request.body && !request.bodyUsed) {
        try {
          const reader = request.body.getReader();
          while (!(await reader.read()).done);
        } catch {
          // The client went away mid-body; nothing left to release.
        }
      }
      return response;
    }

    private async route(request: Request): Promise<Response> {
      const url = new URL(request.url);
      // Fail closed: without secrets, only `actuate dev` (ACTUATE_DEV=1) serves the open routes.
      const dev = this.env.ACTUATE_DEV === "1";
      if (dev && LOOPBACK.has(url.hostname)) await this.rememberOrigin(url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method;
      const m = this.manager;

      try {
        // Public routes.
        if (path === "/health") return json({ ok: true });
        if (path === "/approve" && method === "GET") {
          const token = url.searchParams.get("token") ?? "";
          return html(approvalPage(actuator.name, token, await m.describeLink(token)));
        }
        if (path === "/approve" && method === "POST") {
          const form = new URLSearchParams((await request.text()).slice(0, 64 * 1024));
          const result = await m.decide(String(form.get("token") ?? ""), {
            note: form.get("note") ?? undefined,
            text: form.get("text") ?? undefined,
            by: form.get("by") ?? undefined,
          });
          const message = result.ok
            ? form.has("text")
              ? "Answer sent. You can close this page."
              : result.approved
                ? "Approved. You can close this page."
                : "Rejected. You can close this page."
            : result.reason;
          return html(approvalPage(actuator.name, "", null, message), result.ok ? 200 : 410);
        }
        const providerHook = /^\/providers\/([a-z0-9-]+)\/webhook$/.exec(path);
        if (providerHook && options.providerWebhook) {
          try {
            const out = await options.providerWebhook(providerHook[1]!, request, this.env);
            if (out && "reply" in out) return new Response(out.reply, { headers: { "content-type": "text/plain; charset=utf-8" } });
            const events = out ? (Array.isArray(out) ? out : [out]) : [];
            if (events.length === 0) return json({ ignored: true });
            const delivered = [];
            for (const e of events) delivered.push({ event: e.event, ...(await m.deliverEvent(e.event, e.payload)) });
            return json(delivered.length === 1 ? delivered[0] : { events: delivered });
          } catch (err) {
            if ((err as Error)?.name === "WebhookVerificationError") return json({ error: (err as Error).message }, 401);
            throw err;
          }
        }
        if (path === "/webhook" && method === "POST") {
          const secret = this.env.ACTUATE_WEBHOOK_SECRET;
          if (!secret && !dev) return json({ error: "Set ACTUATE_WEBHOOK_SECRET to accept webhooks." }, 503);
          if (!secret) {
            const refused = devOpenRouteRefusal(request, url);
            return refused ? json({ error: refused }, 403) : this.startRun(request, "webhook");
          }
          const given = request.headers.get("x-actuate-secret") ?? url.searchParams.get("secret");
          if (given !== null) {
            if (!safeEqual(given, secret)) return json({ error: "unauthorized" }, 401);
            return this.startRun(request, "webhook");
          }
          // GitHub-style signature of the body. Headers aren't signed, so a captured request could be
          // replayed with a new Idempotency-Key or X-GitHub-Delivery: the signature itself is the key.
          const sig = request.headers.get("x-hub-signature-256") ?? "";
          if (!sig.startsWith("sha256=")) return json({ error: "unauthorized" }, 401);
          const raw = await request.text();
          if (!safeEqual(sig.slice(7), await hmacSha256Hex(secret, raw))) return json({ error: "unauthorized" }, 401);
          return this.startRun(new Request(request.url, { method: "POST", body: raw }), "webhook", `sig:${sig.slice(7, 39)}`);
        }

        // Admin routes. ACTUATE_TOKEN (the owner) reaches every one; ACTUATE_RUN_TOKEN (an agent) only
        // starts and reads runs, so an agent can never approve, answer or fake an event for its own run.
        const token = this.env.ACTUATE_TOKEN;
        const runToken = this.env.ACTUATE_RUN_TOKEN;
        const authorization = request.headers.get("authorization") ?? "";
        const owner = token ? safeEqual(authorization, `Bearer ${token}`) : dev;
        const agent = !owner && !!runToken && safeEqual(authorization, `Bearer ${runToken}`);
        if (!owner && !agent) {
          if (!token && !runToken) return json({ error: "Set ACTUATE_TOKEN to use the admin API." }, 503);
          return json({ error: "unauthorized" }, 401);
        }
        if (owner && !token) {
          const refused = devOpenRouteRefusal(request, url);
          if (refused) return json({ error: refused }, 403);
        }
        if (agent && !agentRoute(method, path)) {
          return json({ error: "ACTUATE_RUN_TOKEN can only describe the actuator, start runs and read a run. Use ACTUATE_TOKEN." }, 403);
        }
        if (owner && token) await this.rememberOrigin(url);

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
        const inputMatch = /^\/runs\/([^/]+)\/inputs\/([^/]+)$/.exec(path);
        if (inputMatch && method === "POST") {
          const body = (await request.json().catch(() => ({}))) as { text?: string; by?: string };
          return json(
            await m.answerDirect(decodeURIComponent(inputMatch[1]!), decodeURIComponent(inputMatch[2]!), String(body.text ?? ""), {
              by: body.by ?? "owner",
              via: "api",
            }),
          );
        }
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
            const body = (await request.json().catch(() => ({}))) as { note?: string; by?: string };
            return json(await m.decideDirect(runId, decodeURIComponent(runMatch[3]), runMatch[4] === "approve", body.note, { by: body.by ?? "owner", via: "api" }));
          }
        }
        const eventMatch = /^\/events\/(.+)$/.exec(path);
        if (eventMatch && (method === "POST" || (method === "GET" && dev))) {
          // Under `actuate dev`, GET is accepted so the dev payment provider's "bill URL" can be clicked in a browser.
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
        return json({ error: m.redact(err instanceof Error ? err.message : String(err)) }, 500);
      }
    }

    private async startRun(request: Request, kind: "api" | "webhook", signedKey?: string): Promise<Response> {
      const body = await request.json().catch(() => undefined);
      if (body === undefined) return json({ error: "Request body must be JSON." }, 400);
      const parsed = actuator.input.safeParse(body);
      if (!parsed.success) return json({ error: "Invalid input", issues: parsed.error.issues }, 400);
      const idempotencyKey = signedKey ?? request.headers.get("idempotency-key") ?? request.headers.get("x-github-delivery") ?? undefined;
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
