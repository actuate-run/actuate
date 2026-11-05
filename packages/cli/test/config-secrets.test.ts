import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { committedSecretDiagnostic, committedSecretIssue, gitWouldCommit } from "../src/config-secrets.js";
import { deploy } from "../src/deploy.js";
import { runCli, secretProject } from "./helpers.js";

const schema = { type: "object", properties: { greeting: { type: "string" }, apiKey: { type: "string", writeOnly: true }, hook: { type: "object", properties: { token: { type: "string", writeOnly: true } } } } };
const git = (cwd: string, ...args: string[]) => expect(spawnSync("git", args, { cwd, stdio: "ignore" }).status).toBe(0);

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "actuate-git-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  // Never let a temp folder find a repository above it (a developer's home under git, say).
  vi.stubEnv("GIT_CEILING_DIRECTORIES", tmpdir());
  vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "cli-")));
  vi.stubEnv("ACTUATE_API_TOKEN", "");
  vi.stubEnv("ACTUATE_PLAN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gitWouldCommit", () => {
  it("is false outside a git work tree", () => {
    const dir = temp();
    writeFileSync(join(dir, "actuate.config.json"), "{}");
    expect(gitWouldCommit(dir, "actuate.config.json")).toBe(false);
  });

  it("is true for a file git does not ignore, false for an ignored one, and true again once it is tracked", () => {
    const dir = temp();
    git(dir, "init", "-q");
    writeFileSync(join(dir, "actuate.config.json"), "{}");
    expect(gitWouldCommit(dir, "actuate.config.json")).toBe(true);
    writeFileSync(join(dir, ".gitignore"), "actuate.config.json\n");
    expect(gitWouldCommit(dir, "actuate.config.json")).toBe(false);
    git(dir, "add", "-f", "actuate.config.json");
    expect(gitWouldCommit(dir, "actuate.config.json")).toBe(true);
  });

  it("is false when git is missing", () => {
    const dir = temp();
    git(dir, "init", "-q");
    vi.stubEnv("PATH", "");
    expect(gitWouldCommit(dir, "actuate.config.json")).toBe(false);
  });
});

describe("committedSecretIssue", () => {
  it("warns only when a secret field is set and git would commit the file", () => {
    const dir = temp();
    git(dir, "init", "-q");
    expect(committedSecretIssue(dir, schema, { greeting: "Hi" })).toBeNull();
    expect(committedSecretIssue(dir, schema, { apiKey: "", hook: { token: null } })).toBeNull();
    expect(committedSecretIssue(dir, schema, { apiKey: "sk_live_1", hook: { token: "t" } })).toEqual({
      severity: "warning",
      rule: "config-secret",
      message:
        "actuate.config.json sets the secret fields apiKey, hook.token, and git does not ignore the file, so they would be committed. Set them in the dashboard (Config tab) and leave them out of the file: the platform keeps a stored secret when the file omits it. For `actuate dev`, put them in .dev.vars as ACTUATE_CONFIG.",
    });
    expect(committedSecretIssue(dir, schema, { apiKey: "sk_live_1" })?.message).toMatch(/^actuate\.config\.json sets the secret field apiKey, .* so it would be committed\. Set it in the dashboard \(Config tab\) and leave it out of the file.* For `actuate dev`, put it in \.dev\.vars as ACTUATE_CONFIG\.$/);
    writeFileSync(join(dir, ".gitignore"), "actuate.config.json\n");
    expect(committedSecretIssue(dir, schema, { apiKey: "sk_live_1" })).toBeNull();
  });

  it("stays silent outside a git repository", () => {
    expect(committedSecretIssue(temp(), schema, { apiKey: "sk_live_1" })).toBeNull();
  });
});

describe("actuate check and deploy", () => {
  const projects: string[] = [];
  afterEach(() => {
    for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const project = (config: unknown, opts?: { outsideRepo?: boolean }) => {
    const dir = secretProject(config, opts);
    projects.push(dir);
    return dir;
  };
  // The fixture copies sit inside this repository's work tree; let git see it.
  const inRepo = () => vi.stubEnv("GIT_CEILING_DIRECTORIES", "");

  it("warn when the committed file sets a secret, in text and --json, without failing", async () => {
    inRepo();
    const dir = project({ greeting: "Hi", apiKey: "sk_live_from_file" });
    const text = await runCli(["check"], dir);
    expect(text.code).toBe(0);
    expect(text.out).toContain("actuate.config.json:1:1  warn   actuate.config.json sets the secret field apiKey, and git does not ignore the file");
    expect(text.out).toContain("0 error(s), 1 warning(s)");

    const json = JSON.parse((await runCli(["check", "--json"], dir)).out);
    expect(json).toMatchObject({ ok: true, warnings: 1, diagnostics: [{ file: "actuate.config.json", severity: "warning", rule: "config-secret" }] });

    const platform = JSON.parse((await runCli(["check", "--platform", "--offline", "--plan", "maker", "--json"], dir)).out);
    expect(platform.platform.issues).toEqual([expect.objectContaining({ severity: "warning", rule: "config-secret", message: expect.stringContaining("apiKey") })]);
    expect(platform.diagnostics).toEqual([]);

    const out: string[] = [];
    expect(await deploy("actuator.ts", dir, { config: true, dryRun: true, json: true, plan: "maker", log: (l) => out.push(l) })).toBe(0);
    expect(JSON.parse(out.join("\n")).issues).toEqual([expect.objectContaining({ rule: "config-secret" })]);
    const lines: string[] = [];
    expect(await deploy("actuator.ts", dir, { config: false, dryRun: true, plan: "maker", log: (l) => lines.push(l) })).toBe(0);
    expect(lines.join("\n")).toContain("warn   actuate.config.json sets the secret field apiKey");
  });

  it("plain check doesn't load the actuator when actuate.config.json holds no values", async () => {
    inRepo();
    const dir = project({});
    writeFileSync(join(dir, "actuator.ts"), 'throw new Error("loaded"); export default 1;');
    expect(await committedSecretDiagnostic(dir, "actuator.ts", (async () => { throw new Error("must not load"); }) as never)).toBeNull();
    writeFileSync(join(dir, "actuate.config.json"), JSON.stringify({ greeting: "", apiKey: null }));
    expect(await committedSecretDiagnostic(dir, "actuator.ts", (async () => { throw new Error("must not load"); }) as never)).toBeNull();
    let loaded = false;
    writeFileSync(join(dir, "actuate.config.json"), JSON.stringify({ greeting: "Hi" }));
    await committedSecretDiagnostic(dir, "actuator.ts", (async () => { loaded = true; throw new Error("x"); }) as never);
    expect(loaded).toBe(true);
  });

  it("stay silent when the file sets no secret or git ignores it", async () => {
    inRepo();
    const plain = project({ greeting: "Hi" });
    expect((await runCli(["check"], plain)).out).not.toContain("config-secret");
    const ignored = project({ apiKey: "sk_live_from_file" });
    writeFileSync(join(ignored, ".gitignore"), "actuate.config.json\n");
    expect((await runCli(["check"], ignored)).out).not.toContain("config-secret");
    const platform = JSON.parse((await runCli(["check", "--platform", "--offline", "--plan", "maker", "--json"], ignored)).out);
    expect(platform.platform.issues).toEqual([]);
  });

  it("stay silent outside a git repository", async () => {
    const dir = project({ apiKey: "sk_live_from_file" }, { outsideRepo: true });
    vi.stubEnv("GIT_CEILING_DIRECTORIES", dirname(dir));
    const res = await runCli(["check", "--json"], dir);
    expect(JSON.parse(res.out)).toMatchObject({ ok: true, diagnostics: [], warnings: 0 });
    const platform = JSON.parse((await runCli(["check", "--platform", "--offline", "--plan", "maker", "--json"], dir)).out);
    expect(platform.platform.issues).toEqual([]);
  });
});
