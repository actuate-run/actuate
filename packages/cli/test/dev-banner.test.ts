/**
 * The real `actuate dev`: wrangler prints the worker's bindings when it starts. Values from .dev.vars and the
 * config must show as "(hidden)", never in full.
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { secretProject } from "./helpers.js";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

/** Start `actuate dev` in `cwd`, wait until wrangler is ready (or gives up), call `ready`, stop it, and return what it printed. */
async function devOutput(cwd: string, ready: (port: number) => Promise<void>): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, [bin, "dev", "--port", String(port), "--plan", "maker", "--offline"], {
    cwd,
    detached: true,
    env: { ...process.env, ACTUATE_API_TOKEN: "", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  let out = "";
  const append = (chunk: Buffer) => void (out += chunk.toString());
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const exited = new Promise<void>((done) => child.on("exit", () => done()));
  await Promise.race([
    exited,
    new Promise<void>((done) => {
      const timer = setInterval(() => /Ready on/.test(out) && (clearInterval(timer), done()), 100);
      setTimeout(() => (clearInterval(timer), done()), 60_000);
    }),
  ]);
  if (/Ready on/.test(out)) await ready(port);
  try {
    process.kill(-child.pid!, "SIGINT");
  } catch {
    // already gone
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    // already gone
  }
  return out;
}

describe("actuate dev's startup banner", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("shows configuration and .dev.vars values as hidden, never in full", async () => {
    const dir = secretProject({ greeting: "Hi", apiKey: "sk_live_FILE_SECRET_123" });
    dirs.push(dir);
    writeFileSync(join(dir, ".dev.vars"), `ACTUATE_CONFIG={"webhook":{"token":"whk_DEVVARS_SECRET_456"}}\nTELEGRAM_BOT_TOKEN=tg_TOKEN_SECRET_789\n`);
    let run: { status?: string; output?: unknown } = {};
    const out = await devOutput(dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/run`, { method: "POST", body: JSON.stringify({ name: "Ana" }), headers: { "content-type": "application/json" } });
      run = (await res.json()) as typeof run;
    });
    // The merged config reached the worker through wrangler's secrets: the file's greeting, the key from either.
    expect(run).toMatchObject({ status: "COMPLETED", output: "Hi, Ana! (with a key)" });
    expect(out).toContain("Ready on");
    expect(out).toContain("Config:          actuate.config.json, with ACTUATE_CONFIG in .dev.vars merged over it");
    expect(out).toContain('env.ACTUATE_CONFIG ("(hidden)")');
    expect(out).toContain('env.TELEGRAM_BOT_TOKEN ("(hidden)")');
    for (const secret of ["sk_live_FILE", "whk_DEVVARS", "tg_TOKEN_SECRET"]) expect(out).not.toContain(secret);
  }, 90_000);
});
