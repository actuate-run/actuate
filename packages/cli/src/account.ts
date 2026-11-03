import { fetchMe, readCredentials, rememberAccount, type Credentials, type Me } from "./api.js";
import { PLANS, PLAN_IDS, isPlanId, planFromAccount, type PlanRules } from "./plans.js";

/** An error the CLI reports without a stack trace. `exitCode` 2 means the command was used wrongly. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type PlanSource = "--plan" | "ACTUATE_PLAN" | "your account" | "your last login" | "default";

export interface ResolvedPlan {
  plan: PlanRules;
  source: PlanSource;
  /** GET /v1/me, when it was asked for and answered. */
  me?: Me;
  /** Why GET /v1/me failed, when it was asked for. */
  meError?: string;
}

export function parsePlanFlag(value: string | undefined, from: "--plan" | "ACTUATE_PLAN" = "--plan"): PlanRules | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isPlanId(value)) throw new CliError(`Unknown plan "${value}" in ${from}. Use one of: ${PLAN_IDS.join(", ")}.`, 2);
  return PLANS[value];
}

/**
 * The plan whose rules apply: `--plan`, else `ACTUATE_PLAN`, else the logged-in
 * account's (asked of `GET /v1/me` when `online`, else remembered from the last
 * login or deploy), else Sandbox, the strictest.
 */
export async function resolvePlan(flag: string | undefined, opts: { online?: boolean; creds?: Credentials | null } = {}): Promise<ResolvedPlan> {
  const creds = opts.creds === undefined ? readCredentials() : opts.creds;
  let me: Me | undefined;
  let meError: string | undefined;
  if (opts.online && creds) {
    try {
      me = await fetchMe(creds);
      rememberAccount({ ...(typeof me.plan === "string" ? { plan: me.plan } : {}), ...(me.email ? { email: me.email } : {}) });
    } catch (err) {
      meError = err instanceof Error ? err.message : String(err);
    }
  }
  const extra = { ...(me ? { me } : {}), ...(meError ? { meError } : {}) };
  const fromFlag = parsePlanFlag(flag);
  if (fromFlag) return { plan: fromFlag, source: "--plan", ...extra };
  const fromEnv = parsePlanFlag(process.env.ACTUATE_PLAN, "ACTUATE_PLAN");
  if (fromEnv) return { plan: fromEnv, source: "ACTUATE_PLAN", ...extra };
  const fromAccount = me ? planFromAccount(me) : null;
  if (fromAccount) return { plan: fromAccount, source: "your account", ...extra };
  if (creds && isPlanId(creds.plan)) return { plan: PLANS[creds.plan], source: "your last login", ...extra };
  return { plan: PLANS.sandbox, source: "default", ...extra };
}

/** "Sandbox plan (from your account)", or with a hint when it is only the default. */
export function describePlan(p: ResolvedPlan): string {
  if (p.source === "default") return `${p.plan.name} plan (the default; pass --plan maker or agency, or log in, to use yours)`;
  return `${p.plan.name} plan (from ${p.source})`;
}
