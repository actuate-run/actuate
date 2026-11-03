import { describe, expect, it } from "vitest";
import { costLine, formatRun, formatRunList, nextSteps } from "../src/format.js";

const waiting = {
  runId: "run_1",
  status: "WAITING",
  trigger: { kind: "api" },
  passes: 1,
  createdAt: Date.UTC(2026, 0, 5),
  usage: { statements: 9, rowsRead: 20, rowsWritten: 9 },
  steps: [
    { name: "draft", status: "COMPLETED", attempts: 1 },
    { name: "manager ok", status: "WAITING_APPROVAL", wakeAt: Date.UTC(2026, 0, 6) },
    { name: "paid", status: "WAITING_EVENT", event: "payment.run_1" },
  ],
  logs: [{ ts: Date.UTC(2026, 0, 5), level: "info", message: "Approval requested", data: { step: "manager ok" } }],
};

describe("formatting runs", () => {
  it("shows cost, steps, logs and the commands that move the run on", () => {
    expect(formatRun(waiting, " --local")).toBe(
      [
        "run_1  WAITING  api  2026-01-05T00:00:00.000Z",
        "  1 pass · 9 rows written · 20 rows read",
        "  step  COMPLETED        draft",
        "  step  WAITING_APPROVAL manager ok  expires 2026-01-06T00:00:00.000Z",
        "  step  WAITING_EVENT    paid  event payment.run_1",
        "  2026-01-05T00:00:00.000Z  info  Approval requested",
        '        {"step":"manager ok"}',
        "",
        "Next",
        "  actuate approve run_1 --step 'manager ok' --local    (or: actuate reject ...)",
        "  actuate event payment.run_1 '{}' --local",
      ].join("\n"),
    );
  });

  it("shows the output or the error of a settled run, and no next steps", () => {
    expect(formatRun({ runId: "r", status: "COMPLETED", passes: 2, output: { ok: true } })).toBe("r  COMPLETED\n  2 passes\n  output {\"ok\":true}");
    expect(formatRun({ runId: "r", status: "FAILED", passes: 1, error: { name: "ActuatorError", message: "boom" } })).toContain("  error  ActuatorError: boom");
    expect(nextSteps({ runId: "r", status: "COMPLETED", steps: [{ name: "x", status: "WAITING_INPUT" }] }, "")).toEqual([]);
    expect(costLine({ runId: "r", status: "WAITING" })).toBe("0 passes");
  });

  it("lists runs as a table, with rows when the server reports them", () => {
    const list = formatRunList([waiting, { runId: "run_2", status: "COMPLETED", passes: 2, createdAt: Date.UTC(2026, 0, 4), trigger: { kind: "cron", cron: "0 9 * * *" } }]);
    expect(list.split("\n")).toEqual([
      "RUN    STATUS     PASSES  ROWS W/R  STARTED                   TRIGGER",
      "run_1  WAITING    1       9/20      2026-01-05T00:00:00.000Z  api",
      "run_2  COMPLETED  2                 2026-01-04T00:00:00.000Z  cron 0 9 * * *",
    ]);
    expect(formatRunList([])).toBe("No runs yet.");
  });
});
