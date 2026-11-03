import { fetchMe, readCredentials, rememberAccount, type Credentials, type Me } from "./api.js";
import { PLANS, PLAN_IDS, isPlanId, planFromAccount, type PlanRules } from "./plans.js";

/** An error the CLI reports without a stack trace. `exitCode` 2 means the command was used wrongly. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    /** Extra fields for the `--json` error object, e.g. the issues that stopped a deploy. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type PlanSource = "--plan" | "ACTUATE_PLAN" | "account" | "saved" | "default";

export interface ResolvedPlan {
  plan: PlanRules;
  source: PlanSource;
  /** GET /v1/me, when it was asked for and answered. */
  me?: Me;
  /** Why GET /v1/me failed, when it was asked for. */
  meError?: string;
  /** Whether any credentials (saved login or ACTUATE_API_TOKEN) were found. */
  loggedIn: boolean;
}

export function parsePlanFlag(value: string | undefined, from: "--plan" | "ACTUATE_PLAN" = "--plan"): PlanRules | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isPlanId(value)) throw new CliError(`Unknown plan "${value}" in ${from}. Use one of: ${PLAN_IDS.join(", ")}.`, 2);
  return PLANS[value];
}

export interface ResolvePlanOptions {
  /** Ask GET /v1/me when credentials exist (default true). */
  online?: boolean;
  /** Ask it even when --plan or ACTUATE_PLAN already decides the plan (deploy needs the account's usage). */
  alwaysAskAccount?: boolean;
  /** Give up on GET /v1/me after this long and fall back (default 3 s). */
  timeoutMs?: number;
  creds?: Credentials | null;
}

/**
 * The plan whose rules apply: `--plan`, else `ACTUATE_PLAN`, else the logged-in
 * account's (asked of `GET /v1/me`; if the API can't be reached, the plan saved
 * at the last login or deploy), else Sandbox, the strictest.
 */
export async function resolvePlan(flag: string | undefined, opts: ResolvePlanOptions = {}): Promise<ResolvedPlan> {
  const creds = opts.creds === undefined ? readCredentials() : opts.creds;
  const fromFlag = parsePlanFlag(flag);
  const fromEnv = fromFlag ? undefined : parsePlanFlag(process.env.ACTUATE_PLAN, "ACTUATE_PLAN");
  let me: Me | undefined;
  let meError: string | undefined;
  if ((opts.online ?? true) && creds && (opts.alwaysAskAccount || (!fromFlag && !fromEnv))) {
    try {
      me = await fetchMe(creds, opts.timeoutMs ?? 3_000);
      rememberAccount({ ...(typeof me.plan === "string" ? { plan: me.plan } : {}), ...(me.email ? { email: me.email } : {}) });
    } catch (err) {
      meError = err instanceof Error ? err.message : String(err);
    }
  }
  const extra = { ...(me ? { me } : {}), ...(meError ? { meError } : {}), loggedIn: Boolean(creds) };
  if (fromFlag) return { plan: fromFlag, source: "--plan", ...extra };
  if (fromEnv) return { plan: fromEnv, source: "ACTUATE_PLAN", ...extra };
  const fromAccount = me ? planFromAccount(me) : null;
  if (fromAccount) return { plan: fromAccount, source: "account", ...extra };
  if (creds && isPlanId(creds.plan)) return { plan: PLANS[creds.plan], source: "saved", ...extra };
  return { plan: PLANS.sandbox, source: "default", ...extra };
}

/**
 * Where the plan came from, in one parenthesis, e.g. "Maker plan (from your account)" or
 * "Sandbox plan (the default: not logged in)". No trailing punctuation, so it fits mid-sentence.
 */
export function describePlan(p: ResolvedPlan): string {
  const why = {
    "--plan": "from --plan",
    ACTUATE_PLAN: "from ACTUATE_PLAN",
    account: "from your account",
    saved: p.meError ? "saved at your last login, as the API couldn't be reached" : "saved at your last login",
    default: !p.loggedIn ? "the default: not logged in" : p.meError ? "the default: the API couldn't be reached" : "the default",
  }[p.source];
  return `${p.plan.name} plan (${why})`;
}

/** A hint when the plan is only the default, else "". */
export function planHint(p: ResolvedPlan): string {
  return p.source === "default" ? "Pass --plan maker or agency, or run `actuate login`, to use your plan." : "";
}
