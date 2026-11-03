import { describe, expect, it } from "vitest";
import { cronProblem, minCronIntervalMinutes, parseCron } from "../src/cron.js";

describe("cron", () => {
  it("parses the platform's dialect: lists, ranges, steps, Sunday as 0 or 7", () => {
    const s = parseCron("30 9 * * 1-5");
    expect(new Date(s.next(Date.UTC(2026, 0, 3))!).toISOString()).toBe("2026-01-05T09:30:00.000Z"); // Saturday → Monday
    expect(parseCron("0 0 * * 7").matches(new Date(Date.UTC(2026, 0, 4)))).toBe(true); // a Sunday
    expect(parseCron("*/15 * * * *").next(Date.UTC(2026, 0, 5, 0, 1))).toBe(Date.UTC(2026, 0, 5, 0, 15));
    expect(() => parseCron("* * *")).toThrow("must have 5 fields");
    expect(() => parseCron("61 * * * *")).toThrow("out of range");
  });

  it("measures the shortest gap between firings", () => {
    expect(minCronIntervalMinutes("*/5 * * * *")).toBe(5);
    expect(minCronIntervalMinutes("0 9,17 * * *")).toBe(8 * 60);
    expect(minCronIntervalMinutes("0 * * * *")).toBe(60);
  });

  it("applies the plan's count and interval, alone and together", () => {
    expect(cronProblem(["0 * * * *"], 3, 60)).toBeNull();
    expect(cronProblem(["*/30 * * * *"], 3, 60)).toBe('Cron "*/30 * * * *" fires more often than every 60 min.');
    expect(cronProblem(["0 * * * *", "30 * * * *"], 3, 60)).toBe("Together, these cron schedules fire more often than every 60 min.");
    expect(cronProblem(["0 1 * * *", "0 2 * * *", "0 3 * * *", "0 4 * * *"], 3, 60)).toBe("An actuator may have at most 3 cron schedules on this plan.");
    expect(cronProblem(["nope"], 3, 60)).toMatch(/must have 5 fields/);
  });
});
