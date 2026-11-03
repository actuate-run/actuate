/**
 * The 5-field cron dialect the hosted platform accepts (minute hour
 * day-of-month month day-of-week, UTC): `*`, lists, ranges and steps;
 * day-of-week 0-7 with 0 and 7 both Sunday; when both day fields are
 * restricted, either may match. Used to check schedules before a deploy.
 */
const FIELDS: Array<[min: number, max: number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(field: string, [min, max]: [number, number]): Set<number> | null {
  if (field === "*") return null;
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Invalid cron field "${field}"`);
    const start = m[1] === "*" ? min : Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : m[1] === "*" || m[3] ? max : start;
    const step = m[3] ? Number(m[3]) : 1;
    if (start < min || end > max || start > end || step < 1) throw new Error(`Cron field "${field}" out of range`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

export interface CronSchedule {
  matches(date: Date): boolean;
  /** The first matching minute strictly after `after` (epoch ms), within about a year; null if none. */
  next(after: number): number | null;
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron "${expression}" must have 5 fields`);
  const [minute, hour, dom, month, dowRaw] = parts.map((p, i) => parseField(p, FIELDS[i]!));
  const dow = dowRaw ? new Set([...dowRaw].map((d) => d % 7)) : null;
  const dayOk = (d: Date) => {
    const domOk = !dom || dom.has(d.getUTCDate());
    const dowOk = !dow || dow.has(d.getUTCDay());
    return dom && dow ? domOk || dowOk : domOk && dowOk;
  };
  return {
    matches(date) {
      if (minute && !minute.has(date.getUTCMinutes())) return false;
      if (hour && !hour.has(date.getUTCHours())) return false;
      if (month && !month.has(date.getUTCMonth() + 1)) return false;
      return dayOk(date);
    },
    next(after) {
      // Walk forward, skipping whole months, days and hours that cannot match.
      let t = Math.floor(after / 60_000) * 60_000 + 60_000;
      const limit = after + 400 * 86_400_000;
      while (t <= limit) {
        const d = new Date(t);
        if (month && !month.has(d.getUTCMonth() + 1)) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        } else if (!dayOk(d)) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
        } else if (hour && !hour.has(d.getUTCHours())) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
        } else if (minute && !minute.has(d.getUTCMinutes())) {
          t += 60_000;
        } else {
          return t;
        }
      }
      return null;
    },
  };
}

/** The platform measures intervals from this Monday. */
const FROM = Date.UTC(2026, 0, 5);

/** Smallest gap between firings, in minutes, over five weeks of firings. */
export function minCronIntervalMinutes(expression: string, from = FROM): number {
  const schedule = parseCron(expression);
  let last: number | null = null;
  let min = Infinity;
  for (let m = 0; m < 7 * 24 * 60 * 5; m++) {
    const t = from + m * 60_000;
    if (!schedule.matches(new Date(t))) continue;
    if (last !== null) min = Math.min(min, (t - last) / 60_000);
    last = t;
    if (min === 1) break;
  }
  return min;
}

/**
 * The platform's cron rules for one actuator: at most `maxCount` schedules,
 * none firing more often than every `minIntervalMinutes`, and all of them
 * together not either. Returns the first problem, as the platform words it, or null.
 */
export function cronProblem(exprs: readonly string[], maxCount: number, minIntervalMinutes: number): string | null {
  try {
    if (exprs.length > maxCount) return `An actuator may have at most ${maxCount} cron schedules on this plan.`;
    const fires = new Set<number>();
    for (const expr of exprs) {
      const s = parseCron(expr);
      let t = FROM;
      for (let i = 0; i < 2_000; i++) {
        const n = s.next(t);
        if (n === null || n > FROM + 14 * 86_400_000) break;
        fires.add(n);
        t = n;
      }
      if (minCronIntervalMinutes(expr) < minIntervalMinutes) return `Cron "${expr}" fires more often than every ${minIntervalMinutes} min.`;
    }
    const sorted = [...fires].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if ((sorted[i]! - sorted[i - 1]!) / 60_000 < minIntervalMinutes) {
        return `Together, these cron schedules fire more often than every ${minIntervalMinutes} min.`;
      }
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
