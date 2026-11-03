/**
 * `actuate dev`'s runtime (the CLI's dev entry) on workerd via Miniflare: the platform's guards,
 * and rows metered with Cloudflare's own counters and reported per run.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devEntry } from "../packages/cli/src/dev.js";
import { workerBuildOptions } from "../packages/cli/src/load.js";

const actuator = fileURLToPath(new URL("./fixtures/guarded.ts", import.meta.url));

async function start(plan: "sandbox" | "maker" | null) {
  const out = await build({ ...workerBuildOptions, stdin: { contents: devEntry(actuator, 8787, plan), resolveDir: process.cwd(), loader: "ts" }, write: false });
  const mf = new Miniflare({
    modules: true,
    script: out.outputFiles[0]!.text,
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ACTUATOR: { className: "ActuatorObject", useSQLite: true } },
    bindings: { ACTUATE_DEV: "1" },
  });
  const call = async (path: string, body?: unknown) => {
    const res = await mf.dispatchFetch(`http://localhost${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return res.json<any>();
  };
  return { mf, call };
}

describe("actuate dev with the platform's guards (Sandbox)", () => {
  let dev: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    dev = await start("sandbox");
  }, 60_000);
  afterAll(() => dev?.mf.dispose());

  it("reports rows read and written per run, with Cloudflare's counters, and doesn't count reads made to show them", async () => {
    const run = await dev.call("/run", { mode: "ok" });
    expect(run).toMatchObject({ status: "COMPLETED", usage: { rowsWritten: expect.any(Number), rowsRead: expect.any(Number) } });
    expect(run.usage.rowsWritten).toBeGreaterThanOrEqual(4);
    const first = await dev.call(`/runs/${run.runId}`);
    const again = await dev.call(`/runs/${run.runId}`);
    expect(first.usage).toEqual(run.usage);
    expect(again.usage).toEqual(run.usage);
    const list = await dev.call("/runs");
    expect(list.find((r: { runId: string }) => r.runId === run.runId).usage).toEqual(run.usage);
  });

  it("refuses the SQL the platform refuses", async () => {
    const run = await dev.call("/run", { mode: "pragma" });
    expect(run).toMatchObject({ status: "FAILED", error: { message: "PRAGMA, ATTACH, DETACH, VACUUM and REINDEX are not allowed." } });
  });

  it("fails step results over 1 MiB", async () => {
    const run = await dev.call("/run", { mode: "big" });
    expect(run).toMatchObject({ status: "FAILED", error: { message: "A step's result may be at most 1024 KiB of JSON." } });
  });

  it("applies the plan's longest wait", async () => {
    const run = await dev.call("/run", { mode: "sleep" });
    expect(run).toMatchObject({ status: "FAILED", error: { message: 'Step "long" sleeps 2592000s, longer than this plan allows (604800s).' } });
  });
});

describe("actuate dev --no-guards", () => {
  let dev: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    dev = await start(null);
  }, 60_000);
  afterAll(() => dev?.mf.dispose());

  it("allows what the guards refuse, and still meters rows", async () => {
    expect(await dev.call("/run", { mode: "pragma" })).toMatchObject({ status: "COMPLETED", output: 2 });
    expect(await dev.call("/run", { mode: "big" })).toMatchObject({ status: "COMPLETED", output: 1_100_000 });
    const sleeping = await dev.call("/run", { mode: "sleep" });
    expect(sleeping).toMatchObject({ status: "WAITING" });
    expect(sleeping.usage.rowsWritten).toBeGreaterThan(0);
  });
});
