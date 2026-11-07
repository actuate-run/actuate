import { describe, expect, it } from "vitest";
import { defineActuator, secret, z } from "@actuate/sdk";
import { describeActuator } from "../src/load.js";
import { httpAllowProblems, idempotencyKeyProblems, platformChecks, regexProblems } from "../src/platform-checks.js";
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
  it("warns about secret defaults that redaction can't hide", () => {
    const config = z.object({
      flag: secret(z.boolean().default(false)),
      pin: secret(z.string().default("12345")),
      shortNumber: secret(z.number().default(42)),
      longKey: secret(z.string().default("sk_test_123456")),
      longNumber: secret(z.number().default(123456)),
      plain: z.string().default("no"),
      nested: z.object({ token: secret(z.string()) }).default({ token: "abc" }),
      unset: secret(z.string().optional()),
      // A secret object with a default: its short field is reported once, at the field.
      hook: secret(z.object({ id: z.string(), token: z.string() })).default({ id: "h", token: "sk_test_123456" }),
    });
    const issues = check({ ...base, config } as never).filter((i) => i.includes(":secret-default-not-redacted:"));
    const paths = issues.map((i) => /Secret field "([^"]+)"/.exec(i)![1]).sort();
    expect(paths).toEqual(["flag", "hook.id", "nested.token", "pin", "shortNumber"]);
    expect(issues[0]).toMatch(/^warning:secret-default-not-redacted:Secret field ".+" has a default that is never redacted \(booleans and values shorter than 6 characters are not\)\. Remove the default, or set the value in the dashboard instead\.$/);
    expect(check({ ...base, config: z.object({ key: secret(z.string()), on: z.boolean().default(true) }) } as never)).toEqual([]);
  });

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

  it("refuses an idempotencyKey field that isn't a required scalar of the input", () => {
    const input = z.object({ orderId: z.string(), n: z.int(), kind: z.enum(["a", "b"]), maybe: z.string().optional(), dflt: z.string().default("x") });
    expect(check({ ...base, input, idempotencyKey: ["orderId", "n", "kind"] } as never)).toEqual([]);
    expect(check({ ...base, input, idempotencyKey: ["maybe", "dflt"] } as never)).toEqual([
      'error:idempotency-key:idempotencyKey field "maybe" must be required in the input schema (not optional, no default): the run key is computed from the input as sent.',
      'error:idempotency-key:idempotencyKey field "dflt" must be required in the input schema (not optional, no default): the run key is computed from the input as sent.',
    ]);
    // What defineActuator already refuses is refused here too: the platform can't trust an old SDK's bundle to have checked.
    const actuator = defineActuator({ ...base, input: z.object({ id: z.string(), items: z.array(z.string()) }) } as never);
    const keyed = (idempotencyKey: string[]) =>
      platformChecks({ metadata: { ...describeActuator(actuator), idempotencyKey }, actuator, plan: PLANS.sandbox }).map((i) => `${i.rule}:${i.message}`);
    expect(keyed(["items", "nope", "id", "id"])).toEqual([
      'idempotency-key:idempotencyKey field "items" must be a string, number, integer or boolean.',
      'idempotency-key:idempotencyKey field "nope" is not a top-level field of the input schema.',
      'idempotency-key:idempotencyKey lists "id" twice.',
    ]);
    expect(keyed([])).toEqual(["idempotency-key:idempotencyKey lists no fields. List the input fields that identify a request, or leave it out."]);
    expect(idempotencyKeyProblems({ type: "object", properties: { v: { type: "number", const: 3 } }, required: ["v"] }, ["v"])).toEqual([]);
    expect(idempotencyKeyProblems(undefined, undefined)).toEqual([]);
    // A field with a registered id is a $ref into $defs: followed before the type check.
    const OrderId = z.string().meta({ id: "OrderId" });
    const reffed = describeActuator(defineActuator({ ...base, input: z.object({ orderId: OrderId, other: OrderId, items: z.array(z.string()).meta({ id: "Items" }) }), idempotencyKey: ["orderId", "other"] } as never));
    expect(JSON.stringify(reffed.inputSchema)).toContain('"$ref":"#/$defs/OrderId"');
    expect(idempotencyKeyProblems(reffed.inputSchema, ["orderId", "other"])).toEqual([]);
    expect(idempotencyKeyProblems(reffed.inputSchema, ["items"])).toEqual(['idempotencyKey field "items" must be a string, number, integer or boolean.']);
    expect(idempotencyKeyProblems({ properties: { k: { $ref: "#/definitions/K" } }, definitions: { K: { type: "integer" } }, required: ["k"] }, ["k"])).toEqual([]);
    expect(idempotencyKeyProblems({ properties: { k: { $ref: "#/$defs/Missing" } }, required: ["k"] }, ["k"])).toHaveLength(1);
    expect(idempotencyKeyProblems({ properties: { k: { $ref: "https://example.com/k" } }, required: ["k"] }, ["k"])).toHaveLength(1);
    // The input object itself may be a $ref (.meta({ id }) on the object).
    const order = describeActuator(defineActuator({ ...base, input: z.object({ orderId: z.string(), n: z.number().optional() }).meta({ id: "Order" }), idempotencyKey: ["orderId"] } as never));
    expect((order.inputSchema as { $ref?: string }).$ref).toBe("#/$defs/Order");
    expect(idempotencyKeyProblems(order.inputSchema, ["orderId"])).toEqual([]);
    expect(idempotencyKeyProblems(order.inputSchema, ["n"])).toEqual([expect.stringContaining('"n" must be required')]);
    expect(idempotencyKeyProblems(order.inputSchema, ["nope"])).toEqual(['idempotencyKey field "nope" is not a top-level field of the input schema.']);
    // zod writes ids raw: looked up raw first, then percent-decoded. A segment that can't be decoded never throws.
    const raw = describeActuator(defineActuator({ ...base, input: z.object({ k: z.string().meta({ id: "50%" }), s: z.string().meta({ id: "a b" }) }), idempotencyKey: ["k", "s"] } as never));
    expect(JSON.stringify(raw.inputSchema)).toContain('"$ref":"#/$defs/50%"');
    expect(idempotencyKeyProblems(raw.inputSchema, ["k", "s"])).toEqual([]);
    const defs = { $defs: { "a b": { type: "string" }, "%E0": { type: "string" }, "x/y": { type: "number" } } };
    const one = (ref: string) => idempotencyKeyProblems({ properties: { k: { $ref: ref } }, required: ["k"], ...defs }, ["k"]);
    expect(one("#/$defs/a%20b")).toEqual([]);
    expect(one("#/$defs/%E0")).toEqual([]);
    expect(one("#/$defs/x~1y")).toEqual([]);
    expect(one("#/$defs/%E1")).toEqual(['idempotencyKey field "k" must be a string, number, integer or boolean.']);
    expect(idempotencyKeyProblems({ $ref: "#/$defs/%E1", $defs: {} }, ["k"])).toEqual(['idempotencyKey field "k" is not a top-level field of the input schema.']);
    // Without a declaration, the metadata has no idempotencyKey at all (deploys of older actuators are unchanged).
    expect("idempotencyKey" in describeActuator(actuator)).toBe(false);
    expect(describeActuator(defineActuator({ ...base, input, idempotencyKey: ["orderId"] } as never)).idempotencyKey).toEqual(["orderId"]);
  });

  it("extends the cron-input warning when the actuator also declares idempotencyKey", () => {
    const def = { ...base, input: z.object({ id: z.string() }), cron: ["0 9 * * *"], idempotencyKey: ["id"] };
    expect(check(def as never, { plan: PLANS.maker })).toEqual([
      "warning:cron-input:Every cron run starts with the input {}, which the input schema rejects (the idempotencyKey fields are required), so every firing fails. Cron runs never use idempotencyKey: move the schedule to an actuator of its own.",
    ]);
    // A cron run's input can only parse when a key field isn't required, which is refused on its own.
    const lenient = check({ ...def, input: z.object({ id: z.string().default("daily") }) } as never, { plan: PLANS.maker });
    expect(lenient).toEqual([
      'error:idempotency-key:idempotencyKey field "id" must be required in the input schema (not optional, no default): the run key is computed from the input as sent.',
    ]);
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
