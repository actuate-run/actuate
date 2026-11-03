import type { Capability } from "@actuate/sdk";

/**
 * The hosted platform's plan rules that decide whether a deploy is accepted
 * and what a run may do, mirrored so the CLI can check them before anything
 * is uploaded. The platform is authoritative: when you are logged in, the
 * numbers come from your account (`GET /v1/me`) and these are only the
 * fallback. No Node imports: `actuate dev` bundles this file into workerd.
 */
export type PlanId = "sandbox" | "maker" | "agency";
export const PLAN_IDS: readonly PlanId[] = ["sandbox", "maker", "agency"];

export interface PlanRules {
  id: PlanId;
  name: string;
  /** Capabilities whose providers this plan may use. */
  capabilities: readonly Capability[];
  maxActuators: number;
  /** Longest single sleep or wait; null means unlimited. */
  maxSleepMs: number | null;
  limits: {
    cronsPerActuator: number;
    minCronIntervalMinutes: number;
    passesPerRun: number;
    deploysPerDay: number;
    deploysPerMonth: number;
  };
}

const DAY = 86_400_000;

export const PLANS: Record<PlanId, PlanRules> = {
  sandbox: {
    id: "sandbox",
    name: "Sandbox",
    capabilities: ["http"],
    maxActuators: 2,
    maxSleepMs: 7 * DAY,
    limits: { cronsPerActuator: 3, minCronIntervalMinutes: 60, passesPerRun: 200, deploysPerDay: 30, deploysPerMonth: 300 },
  },
  maker: {
    id: "maker",
    name: "Maker",
    capabilities: ["messaging", "payment", "llm", "http"],
    maxActuators: 15,
    maxSleepMs: null,
    limits: { cronsPerActuator: 5, minCronIntervalMinutes: 1, passesPerRun: 1_000, deploysPerDay: 200, deploysPerMonth: 2_000 },
  },
  agency: {
    id: "agency",
    name: "Agency",
    capabilities: ["messaging", "payment", "llm", "http"],
    maxActuators: 50,
    maxSleepMs: null,
    limits: { cronsPerActuator: 5, minCronIntervalMinutes: 1, passesPerRun: 1_000, deploysPerDay: 500, deploysPerMonth: 5_000 },
  },
};

/** Guards on one pass, the same on every plan. */
export const PASS_LIMITS = {
  /** Wall time before the pass is abandoned. */
  wallMs: 30_000,
  /** ctx.db calls per pass. */
  dbStatements: 1_000,
  /** Steps written per pass. */
  stepWrites: 1_000,
  /** Billed rows written per pass, journal included. */
  rowsWritten: 20_000,
  /** Billed rows read per pass, journal included. */
  rowsRead: 5_000_000,
  /** Outbound ctx.http requests per pass. */
  httpRequests: 50,
  /** Bytes of bound parameters in one statement. */
  paramBytes: 1024 * 1024,
  /** Bytes of one step's stored result (JSON). */
  stepOutputBytes: 1024 * 1024,
  /** Retries a single step may request. */
  maxRetries: 10,
} as const;

/** Largest bundle the platform accepts. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

/**
 * The account's plan as `GET /v1/me` reports it (`plan` and `planDetails`),
 * over the local mirror, so a limit the platform changed wins.
 */
export function planFromAccount(me: { plan?: unknown; planDetails?: unknown }): PlanRules | null {
  if (!isPlanId(me.plan)) return null;
  const base = PLANS[me.plan];
  const d = (me.planDetails ?? {}) as Partial<PlanRules> & { limits?: Partial<PlanRules["limits"]> };
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    id: base.id,
    name: typeof d.name === "string" ? d.name : base.name,
    capabilities: Array.isArray(d.capabilities) ? (d.capabilities as Capability[]) : base.capabilities,
    maxActuators: num(d.maxActuators, base.maxActuators),
    maxSleepMs: d.maxSleepMs === null ? null : typeof d.maxSleepMs === "number" ? d.maxSleepMs : base.maxSleepMs,
    limits: {
      cronsPerActuator: num(d.limits?.cronsPerActuator, base.limits.cronsPerActuator),
      minCronIntervalMinutes: num(d.limits?.minCronIntervalMinutes, base.limits.minCronIntervalMinutes),
      passesPerRun: num(d.limits?.passesPerRun, base.limits.passesPerRun),
      deploysPerDay: num(d.limits?.deploysPerDay, base.limits.deploysPerDay),
      deploysPerMonth: num(d.limits?.deploysPerMonth, base.limits.deploysPerMonth),
    },
  };
}
