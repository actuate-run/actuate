import { describe, expect, it } from "vitest";
import { defineActuator, z } from "@actuate/sdk";
import { describeActuator } from "../src/load.js";
import { httpAllowProblems, platformChecks, regexProblems } from "../src/platform-checks.js";
import { PLANS, planFromAccount } from "../src/plans.js";

const base = {
  name: "t",
  description: "t",
  input: z.object({}),
  run: () => null,
};
const check = (def: Parameters<typeof defineActuator>[0], extra: Partial<Parameters<typeof platformChecks>[0]> = {}) => {
  const actuator = defineActuator(def as never);
  return platformChecks({ metadata: describeActuator(actuator), actuator, plan: PLANS.sandbox, ...extra }).map((i) => `${i.severity}:${i.rule}:${i.message}`);
};

describe("platform deploy checks", () => {
  it("passes a plain actuator on every plan", () => {
    for (const plan of Object.values(PLANS)) expect(check(base, { plan })).toEqual([]);
  });

  it("checks capabilities against the plan", () => {
    const def = { ...base, capabilities: ["messaging", "http"], http: { allow: ["api.example.com"] }, optionalCapabilities: ["llm"] };
    expect(check(def as never)).toEqual([
      "error:plan-capability:The Sandbox plan cannot use messaging. Upgrade to Maker to use providers.",
      "warning:plan-capability:The Sandbox plan has no llm providers, so ctx.llm will be undefined.",
    ]);
    expect(check(def as never, { plan: PLANS.maker })).toEqual([]);
  });

  it("only warns about the plan's own rules when the plan is just the default", () => {
    const def = { ...base, capabilities: ["messaging"], cron: ["*/10 * * * *"] };
    const issues = check(def as never, { planDefaulted: true });
    expect(issues).toHaveLength(2);
    for (const i of issues) {
      expect(i).toMatch(/^warning:(cron|plan-capability):/);
      expect(i).toContain("That is only the default plan here: log in or pass --plan to check against yours.");
    }
  });

  it("refuses a malformed cron expression even when the plan is only the default", () => {
    const actuator = defineActuator(base as never);
    const metadata = { ...describeActuator(actuator), cron: ["not a cron"] };
    const issues = platformChecks({ metadata, actuator, plan: PLANS.sandbox, planDefaulted: true });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", rule: "cron" });
    expect(issues[0]!.message).not.toContain("only the default plan");
    // The other schedules are still checked against the plan.
    const mixed = platformChecks({ metadata: { ...metadata, cron: ["not a cron", "* * * * *"] }, actuator, plan: PLANS.sandbox });
    expect(mixed.map((i) => `${i.severity}:${i.rule}`)).toEqual(["error:cron", "error:cron"]);
    expect(mixed[1]!.message).toContain('Cron "* * * * *" fires more often than every 60 min.');
    const many = platformChecks({ metadata: { ...metadata, cron: ["bad", "0 * * * *", "0 * * * *", "0 * * * *"] }, actuator, plan: PLANS.sandbox });
    expect(many.some((i) => i.message.startsWith("An actuator may have at most 3 cron schedules"))).toBe(true);
  });

  it("checks cron schedules per plan, and warns when cron runs can't start", () => {
    const def = { ...base, input: z.object({ id: z.string() }), cron: ["*/10 * * * *"] };
    expect(check(def)).toEqual([
      'error:cron:Cron "*/10 * * * *" fires more often than every 60 min. The Sandbox plan allows 3 schedules, at least 60 min apart.',
      "warning:cron-input:Every cron run starts with the input {}, which the input schema rejects, so every firing fails. Make the fields optional or give them defaults.",
    ]);
    expect(check({ ...def, input: z.object({ id: z.string().optional() }) }, { plan: PLANS.maker })).toEqual([]);
  });

  it("checks http.allow like the platform", () => {
    expect(httpAllowProblems(["api.example.com", "*.example.com"])).toEqual([]);
    expect(httpAllowProblems(["*.github.io", "10.0.0.1", "localhost", "api.actuate.run", "bad_host.com"])).toEqual([
      'http.allow entry "*.github.io" is too broad: a wildcard must sit under a domain you control (e.g. *.example.com).',
      'http.allow entry "10.0.0.1": IP addresses are not allowed.',
      'http.allow entry "localhost" must be a hostname like api.example.com or *.example.com.',
      'http.allow entry "api.actuate.run": an actuator cannot call the platform.',
      'http.allow entry "bad_host.com" must be a hostname like api.example.com or *.example.com.',
    ]);
    expect(httpAllowProblems(Array.from({ length: 21 }, (_, i) => `a${i}.example.com`))).toEqual(["http.allow may list at most 20 domains."]);
  });

  it("flags input regexes that backtrack, but not zod's own formats", () => {
    expect(regexProblems(z.toJSONSchema(z.object({ e: z.email(), u: z.url(), d: z.iso.datetime(), s: z.string().regex(/^[a-z]+$/) })))).toEqual([]);
    expect(regexProblems(z.toJSONSchema(z.object({ s: z.string().regex(/^(\w+\s?)*$/) })))).toEqual([
      "The regex /^(\\w+\\s?)*$/ can backtrack catastrophically (a repeated group containing a repeat). Simplify it.",
    ]);
  });

  it("validates actuate.config.json against the config schema", () => {
    const def = { ...base, config: z.object({ greeting: z.string().default("hi") }) };
    expect(check(def, { config: { value: { greeting: "yo" } } })).toEqual([]);
    expect(check(def, { config: { value: { greeting: 3 } } })).toEqual([
      "error:config:Invalid config in actuate.config.json:\n  greeting: Invalid input: expected string, received number",
    ]);
    expect(check(def, { config: { error: "actuate.config.json is not valid JSON: x" } })).toEqual(["error:config:actuate.config.json is not valid JSON: x"]);
  });

  it("names every source of a merged config that fails validation", () => {
    const def = { ...base, config: z.object({ greeting: z.string() }) };
    expect(check(def, { config: { value: { greeting: 3 } }, configSource: "actuate.config.json with ACTUATE_CONFIG in .dev.vars" })).toEqual([
      "error:config:Invalid config in actuate.config.json with ACTUATE_CONFIG in .dev.vars:\n  greeting: Invalid input: expected string, received number",
    ]);
  });

  it("refuses names starting with actuate_, which the platform keeps for its own tools", () => {
    expect(check({ ...base, name: "actuate_helper" })).toEqual([
      'error:name:Actuator names starting with "actuate_" are reserved for Actuate\'s built-in tools (actuate_get_run, actuate_list_runs, actuate_cancel_run). Rename it.',
    ]);
    expect(check({ ...base, name: "actuated_helper" })).toEqual([]);
  });

  it("checks the account: providers, actuator count, deploys left", () => {
    const def = { ...base, capabilities: ["messaging", "payment"] };
    const maker = { plan: PLANS.maker };
    expect(check(def as never, { ...maker, account: { configuredCapabilities: ["messaging"] } })).toEqual([
      "error:provider-missing:No provider configured for: payment. Add one in the dashboard (Settings → Providers) first.",
    ]);
    expect(check(base, { account: { exists: false, actuatorCount: 2 } })).toEqual(["error:actuator-limit:The Sandbox plan allows 2 actuators."]);
    expect(check(base, { account: { exists: true, actuatorCount: 2 } })).toEqual([]);
    expect(check(base, { account: { deploysThisMonth: 280 } })).toEqual(["warning:deploy-budget:280 of 300 deploys used this month."]);
    expect(check(base, { account: { deploysThisMonth: 300 } })[0]).toMatch(/^error:deploy-budget:The Sandbox plan allows 300 deploys a month/);
  });

  it("refuses bundles over 5 MB", () => {
    expect(check(base, { bundleBytes: 6 * 1024 * 1024 })).toEqual(["error:bundle-size:Bundle is larger than 5 MB (6.0 MB)."]);
  });

  it("prefers the account's own plan numbers over the local mirror", () => {
    const plan = planFromAccount({ plan: "sandbox", planDetails: { name: "Sandbox", maxSleepMs: null, limits: { cronsPerActuator: 9 } } })!;
    expect(plan).toMatchObject({ id: "sandbox", maxSleepMs: null, limits: { cronsPerActuator: 9, minCronIntervalMinutes: 60 } });
    expect(planFromAccount({ plan: "enterprise" })).toBeNull();
    expect(planFromAccount({ plan: "maker" })).toEqual(PLANS.maker);
  });
});
