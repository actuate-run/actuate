/**
 * A duration is either milliseconds as a number, or a human string such as
 * "30 minutes", "2 hours", "24h", "3 days", "500ms".
 */
export type Duration = number | `${number}${string}`;

const UNITS: Record<string, number> = {
  ms: 1, millisecond: 1, milliseconds: 1,
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

/** Parse a {@link Duration} into milliseconds. Throws on anything it does not understand. */
export function parseDuration(value: Duration | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid duration: ${value}`);
    return value;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*$/.exec(value);
  const unit = match?.[2]?.toLowerCase();
  const factor = unit ? UNITS[unit] : undefined;
  if (!match || factor === undefined) throw new RangeError(`Invalid duration: "${value}"`);
  return Math.round(Number(match[1]) * factor);
}
