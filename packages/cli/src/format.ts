/** Human-readable output for run records, shared by `run`, `logs`, `event`, `approve`, `reject`, `answer` and `cancel`. */

export interface RunJson {
  runId: string;
  status: string;
  trigger?: { kind?: string; cron?: string };
  output?: unknown;
  error?: { name?: string; message?: string } | null;
  passes?: number;
  wakeAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  steps?: StepJson[];
  logs?: LogJson[];
  /** Added by `actuate dev`: rows billed to this run, journal included. */
  usage?: { statements: number; rowsRead: number; rowsWritten: number };
}

export interface StepJson {
  name: string;
  status: string;
  wakeAt?: number | null;
  event?: string | null;
  attempts?: number;
  error?: string | null;
}

export interface LogJson {
  ts: number;
  level: string;
  message: string;
  data?: unknown;
}

const iso = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "");

/** "2 passes · 9 rows written · 31 rows read": what this run cost, as far as the server reports it. */
export function costLine(run: RunJson): string {
  const passes = run.passes ?? 0;
  const parts = [`${passes.toLocaleString("en")} ${passes === 1 ? "pass" : "passes"}`];
  if (run.usage) {
    parts.push(`${run.usage.rowsWritten.toLocaleString("en")} rows written`, `${run.usage.rowsRead.toLocaleString("en")} rows read`);
  }
  return parts.join(" · ");
}

/** The commands that move a waiting run on. `flags` is appended to each (e.g. " --local"). */
export function nextSteps(run: RunJson, flags: string): string[] {
  if (run.status !== "WAITING" && run.status !== "RUNNING") return [];
  const out: string[] = [];
  for (const s of run.steps ?? []) {
    const step = /^[\w.-]+$/.test(s.name) ? s.name : `'${s.name.replace(/'/g, "'\\''")}'`;
    if (s.status === "WAITING_APPROVAL") {
      out.push(`actuate approve ${run.runId} --step ${step}${flags}    (or: actuate reject ...)`);
    } else if (s.status === "WAITING_INPUT") {
      out.push(`actuate answer ${run.runId} "<your answer>" --step ${step}${flags}`);
    } else if (s.status === "WAITING_EVENT" && s.event) {
      out.push(`actuate event ${s.event} '{}'${flags}`);
    } else if ((s.status === "SLEEPING" || s.status === "RETRYING") && s.wakeAt) {
      out.push(`${s.status === "SLEEPING" ? "sleeps" : "retries"} until ${iso(s.wakeAt)} (step "${s.name}")`);
    }
  }
  return out;
}

/** One run in detail: status, cost, steps, logs, output or error, and what to do next. */
export function formatRun(run: RunJson, flags = ""): string {
  const lines = [`${run.runId}  ${run.status}  ${run.trigger?.kind ?? ""}${run.trigger?.cron ? ` (${run.trigger.cron})` : ""}  ${iso(run.createdAt)}`.trimEnd()];
  lines.push(`  ${costLine(run)}`);
  for (const s of run.steps ?? []) {
    const extra = [
      s.wakeAt && s.status !== "COMPLETED" ? `${s.status === "WAITING_APPROVAL" || s.status === "WAITING_INPUT" ? "expires" : "until"} ${iso(s.wakeAt)}` : "",
      s.event && s.status === "WAITING_EVENT" ? `event ${s.event}` : "",
      (s.attempts ?? 0) > 1 ? `attempt ${s.attempts}` : "",
      s.error ? `(${s.error})` : "",
    ].filter(Boolean);
    lines.push(`  step  ${s.status.padEnd(16)} ${s.name}${extra.length ? `  ${extra.join("  ")}` : ""}`);
  }
  for (const l of run.logs ?? []) {
    lines.push(`  ${iso(l.ts)}  ${String(l.level).padEnd(5)} ${l.message}`);
    if (l.data !== null && l.data !== undefined) lines.push(`        ${JSON.stringify(l.data)}`);
  }
  if (run.status === "COMPLETED") lines.push(`  output ${JSON.stringify(run.output ?? null)}`);
  if (run.error) lines.push(`  error  ${run.error.name && run.error.name !== "Error" ? `${run.error.name}: ` : ""}${run.error.message ?? JSON.stringify(run.error)}`);
  const next = nextSteps(run, flags);
  if (next.length) lines.push("", "Next", ...next.map((n) => `  ${n}`));
  return lines.join("\n");
}

/** A table of runs, newest first. */
export function formatRunList(runs: RunJson[]): string {
  if (!runs.length) return "No runs yet.";
  const withRows = runs.some((r) => r.usage);
  const header = ["RUN", "STATUS", "PASSES", ...(withRows ? ["ROWS W/R"] : []), "STARTED", "TRIGGER"];
  const rows = runs.map((r) => [
    r.runId,
    r.status,
    String(r.passes ?? ""),
    ...(withRows ? [r.usage ? `${r.usage.rowsWritten}/${r.usage.rowsRead}` : ""] : []),
    iso(r.createdAt),
    `${r.trigger?.kind ?? ""}${r.trigger?.cron ? ` ${r.trigger.cron}` : ""}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ")).join("\n");
}
