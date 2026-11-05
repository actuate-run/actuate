import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configBannerLine, configSourceName, devConfig, mergeConfig, parseEnvFile, wranglerConfig, wranglerSecrets } from "../src/dev.js";

const dirs: string[] = [];
const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "actuate-devcfg-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("actuate dev configuration", () => {
  it("deep-merges ACTUATE_CONFIG from .dev.vars over actuate.config.json", () => {
    const dir = project({
      "actuate.config.json": JSON.stringify({ greeting: "Hi", slack: { channel: "#ops", botToken: null }, tags: ["a", "b"], region: "eu" }),
      ".dev.vars": `ACTUATE_MESSAGING=console\nACTUATE_CONFIG={"slack":{"botToken":"xoxb-local"},"tags":["c"],"apiKey":"sk_test_local"}\n`,
    });
    const cfg = devConfig(dir);
    const expected = { greeting: "Hi", slack: { channel: "#ops", botToken: "xoxb-local" }, tags: ["c"], region: "eu", apiKey: "sk_test_local" };
    expect(cfg.config).toEqual({ value: expected });
    expect(JSON.parse(cfg.text!)).toEqual(expected);
    expect(cfg.sources).toEqual(["actuate.config.json", "ACTUATE_CONFIG in .dev.vars"]);
    expect(configBannerLine(cfg.sources)).toBe("actuate.config.json, with ACTUATE_CONFIG in .dev.vars merged over it");
  });

  it("uses ACTUATE_CONFIG from .dev.vars alone when there is no actuate.config.json", () => {
    const cfg = devConfig(project({ ".dev.vars": `ACTUATE_CONFIG='{"apiKey":"sk_test_local"}'\n` }));
    expect(cfg).toEqual({ config: { value: { apiKey: "sk_test_local" } }, text: '{"apiKey":"sk_test_local"}', sources: ["ACTUATE_CONFIG in .dev.vars"] });
    expect(configBannerLine(cfg.sources)).toBe("ACTUATE_CONFIG in .dev.vars");
  });

  it("is unchanged without ACTUATE_CONFIG in .dev.vars: the file as written, and no banner line", () => {
    const text = '{ "greeting": "Hi" }\n';
    const cfg = devConfig(project({ "actuate.config.json": text, ".dev.vars": "ACTUATE_MESSAGING=console\n" }));
    expect(cfg).toEqual({ config: { value: { greeting: "Hi" } }, text, sources: ["actuate.config.json"] });
    expect(configBannerLine(cfg.sources)).toBeNull();
    expect(devConfig(project({}))).toEqual({ sources: [] });
    // An invalid file is reported by the deploy checks, as before, not thrown.
    expect(devConfig(project({ "actuate.config.json": "{ nope" })).config).toMatchObject({ error: expect.stringContaining("actuate.config.json is not valid JSON") });
  });

  it("says clearly when ACTUATE_CONFIG in .dev.vars is not a JSON object", () => {
    expect(() => devConfig(project({ ".dev.vars": "ACTUATE_CONFIG={apiKey: sk}\n" }))).toThrow(
      'ACTUATE_CONFIG in .dev.vars is not valid JSON (line 1, column 2). Write the object on one line: ACTUATE_CONFIG={"apiKey":"sk_test_..."}',
    );
    // The parser's own message would quote the text around the error: part of a secret.
    for (const text of ['{"apiKey": sk_live_PARTIAL}', '{"apiKey": "sk_live_PARTIAL"}}']) {
      let message = "";
      try {
        devConfig(project({ ".dev.vars": `ACTUATE_CONFIG=${text}\n` }));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/^ACTUATE_CONFIG in \.dev\.vars is not valid JSON/);
      expect(message).not.toContain("sk_live");
    }
    const file = devConfig(project({ "actuate.config.json": '{"apiKey": sk_live_PARTIAL}' })).config as { error: string };
    expect(file.error).toMatch(/^actuate\.config\.json is not valid JSON/);
    expect(file.error).not.toContain("sk_live");
    expect(() => devConfig(project({ ".dev.vars": 'ACTUATE_CONFIG=["a"]\n' }))).toThrow("ACTUATE_CONFIG in .dev.vars must be a JSON object");
    expect(() => devConfig(project({ "actuate.config.json": "{ nope", ".dev.vars": 'ACTUATE_CONFIG={"a":"b"}\n' }))).toThrow(/actuate\.config\.json is not valid JSON.*merged over it/);
  });

  it("ignores an empty ACTUATE_CONFIG in .dev.vars", () => {
    const text = '{ "greeting": "Hi" }';
    expect(devConfig(project({ "actuate.config.json": text, ".dev.vars": "ACTUATE_CONFIG=\n" }))).toEqual({ config: { value: { greeting: "Hi" } }, text, sources: ["actuate.config.json"] });
  });

  it("names both sources for the deploy checks when .dev.vars contributed", () => {
    expect(configSourceName(devConfig(project({ "actuate.config.json": "{}", ".dev.vars": 'ACTUATE_CONFIG={"a":"b"}\n' })).sources)).toBe("actuate.config.json with ACTUATE_CONFIG in .dev.vars");
    expect(configSourceName(devConfig(project({ ".dev.vars": 'ACTUATE_CONFIG={"a":"b"}\n' })).sources)).toBe("ACTUATE_CONFIG in .dev.vars");
    expect(configSourceName(devConfig(project({ "actuate.config.json": "{}" })).sources)).toBe("actuate.config.json");
  });

  it("hands wrangler every variable as a secret (.dev.vars), never as a printed var", () => {
    const vars = { ACTUATE_CONFIG: JSON.stringify({ apiKey: "sk_live_x", note: "it's `quoted`" }), TOKEN: "abc#def", PLAIN: 'a"b' };
    const text = wranglerSecrets(vars);
    const back = parseEnvFile(text);
    expect({ ...back, ACTUATE_CONFIG: JSON.parse(back.ACTUATE_CONFIG!) }).toEqual({ ...vars, ACTUATE_CONFIG: JSON.parse(vars.ACTUATE_CONFIG) });
    expect(text).not.toContain("it's");
    expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    expect(wranglerConfig({ name: "x", cron: [] }, { ACTUATE_DEV: "1" })).toMatchObject({ vars: { ACTUATE_DEV: "1" } });
    expect(() => wranglerSecrets({ X: "'`\"" })).toThrow(/X in \.env or \.dev\.vars has every kind of quote/);
  });

  it("mergeConfig merges objects and lets everything else win", () => {
    expect(mergeConfig({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2], e: null })).toEqual({ a: { b: 1, c: 3 }, d: [2], e: null });
    expect(mergeConfig("x", { a: 1 })).toEqual({ a: 1 });
    expect(mergeConfig({ a: 1 }, "y")).toBe("y");
  });
});
