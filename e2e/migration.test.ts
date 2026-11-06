/** A 0.4.x database on a real SQLite-backed Durable Object gets the 0.5.0 input_key column and index. */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, expect, it } from "vitest";

let mf: Miniflare | undefined;
afterAll(() => mf?.dispose());

it("adds input_key and its index to an existing _actuate_runs table, keeping its runs", async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/migrate-entry.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"],
    conditions: ["workerd", "worker", "import"], mainFields: ["module", "main"], write: false,
  });
  mf = new Miniflare({
    modules: true,
    script: out.outputFiles[0]!.text,
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { OLD: { className: "OldObject", useSQLite: true } },
  });
  const res = await mf.dispatchFetch("http://migrate.test/");
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.columns.filter((c: string) => c === "input_key")).toHaveLength(1);
  expect(body.index).toContain("CREATE UNIQUE INDEX _actuate_runs_input ON _actuate_runs (input_key) WHERE input_key IS NOT NULL");
  expect(body).toMatchObject({ old: { status: "COMPLETED", idempotencyKey: "old-key" }, first: { created: true, status: "COMPLETED" }, sameRun: true, explicit: "run_old" });
}, 60_000);
