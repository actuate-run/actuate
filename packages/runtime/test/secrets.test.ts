import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineActuator, secret, z, type Actuator } from "@actuate/sdk";
import { RunManager, collectSecrets, executePass, mergeSecrets, nodeSqlite, omitSecrets, redactSecrets, secretFields, secretPaths } from "../src/index.js";

const opts = { io: "input", unrepresentable: "any" } as const;

const configSchema = z.object({
  plain: secret(z.string()),
  viaMeta: z.string().meta({ writeOnly: true }),
  optional: secret(z.string()).optional(),
  optionalOuter: secret(z.string().optional()),
  defaulted: secret(z.string()).default("default-secret"),
  nullable: secret(z.string()).nullable(),
  nested: z.object({ token: secret(z.string()), name: z.string() }),
  list: z.array(secret(z.string())),
  listOuter: secret(z.array(z.string())),
  objects: z.array(z.object({ key: secret(z.string()), label: z.string() })),
  record: z.record(z.string(), secret(z.string())),
  normal: z.string(),
});

const config = {
  plain: "plain-secret",
  viaMeta: "meta-secret",
  optional: "optional-secret",
  optionalOuter: "outer-optional-secret",
  defaulted: "defaulted-secret",
  nullable: "nullable-secret",
  nested: { token: "nested-secret", name: "not-a-secret" },
  list: ["list-secret-1", "list-secret-2"],
  listOuter: ["outer-list-secret"],
  objects: [{ key: "object-secret", label: "visible-label" }],
  record: { a: "record-secret" },
  normal: "visible-value",
};

describe("secret config fields in JSON Schema", () => {
  it("writes writeOnly for plain, .optional(), .default(), nullable, nested-object, array and record fields", () => {
    for (const json of [z.toJSONSchema(configSchema, opts), configSchema.toJSONSchema(opts)] as any[]) {
      const p = json.properties;
      expect(p.plain.writeOnly).toBe(true);
      expect(p.viaMeta.writeOnly).toBe(true);
      expect(p.optional.writeOnly).toBe(true);
      expect(p.optionalOuter.writeOnly).toBe(true);
      expect(p.defaulted).toMatchObject({ writeOnly: true });
      expect(p.nullable.anyOf[0].writeOnly).toBe(true);
      expect(p.nested.properties.token.writeOnly).toBe(true);
      expect(p.nested.properties.name.writeOnly).toBeUndefined();
      expect(p.list.items.writeOnly).toBe(true);
      expect(p.listOuter.writeOnly).toBe(true);
      expect(p.objects.items.properties.key.writeOnly).toBe(true);
      expect(p.record.additionalProperties.writeOnly).toBe(true);
      expect(p.normal.writeOnly).toBeUndefined();
    }
  });

  it("secret() leaves validation alone", () => {
    expect(secret(z.string().min(3)).safeParse("ab").success).toBe(false);
    expect(configSchema.parse({ ...config, defaulted: undefined }).defaulted).toBe("default-secret");
  });
});

describe("collectSecrets", () => {
  const json = z.toJSONSchema(configSchema, opts);

  it("finds every secret value, deduplicated and longest first", () => {
    const found = collectSecrets(json, config);
    expect(found.sort()).toEqual(
      [
        "plain-secret",
        "meta-secret",
        "optional-secret",
        "outer-optional-secret",
        "defaulted-secret",
        "nullable-secret",
        "nested-secret",
        "list-secret-1",
        "list-secret-2",
        "outer-list-secret",
        "object-secret",
        "record-secret",
      ].sort(),
    );
    const ordered = collectSecrets(json, config);
    expect(ordered.map((s) => s.length)).toEqual([...ordered.map((s) => s.length)].sort((a, b) => b - a));
    expect(ordered).not.toContain("visible-value");
    expect(ordered).not.toContain("not-a-secret");
    expect(ordered).not.toContain("visible-label");
  });

  it("ignores values shorter than 6 characters, non-strings, nulls and missing fields", () => {
    const schema = z.toJSONSchema(z.object({ a: secret(z.string()), b: secret(z.number()), c: secret(z.string()).nullable(), d: secret(z.string()).optional() }), opts);
    expect(collectSecrets(schema, { a: "abcde", b: 1234567, c: null })).toEqual([]);
    expect(collectSecrets(schema, { a: "abcdef" })).toEqual(["abcdef"]);
    expect(collectSecrets(schema, { a: "same-value", d: "same-value" })).toEqual(["same-value"]);
  });

  it("follows local $refs and tolerates junk", () => {
    const schema = { $defs: { tok: { type: "string", writeOnly: true } }, properties: { a: { $ref: "#/$defs/tok" }, b: { allOf: [{ $ref: "#/$defs/tok" }] } } };
    expect(collectSecrets(schema, { a: "ref-secret", b: "allof-secret" }).sort()).toEqual(["allof-secret", "ref-secret"]);
    expect(collectSecrets(null, { a: "x" })).toEqual([]);
    expect(collectSecrets(schema, "not an object")).toEqual([]);
    expect(collectSecrets({ type: "string", writeOnly: true }, "top-level-secret")).toEqual(["top-level-secret"]);
  });

  it("mergeSecrets combines lists in the same order", () => {
    expect(mergeSecrets(["bbbbbb", "aaaaaaaa"], ["bbbbbb", "cc"])).toEqual(["aaaaaaaa", "bbbbbb"]);
  });
});

describe("secretFields, secretPaths and omitSecrets", () => {
  const json = z.toJSONSchema(configSchema, opts);

  it("lists every secret field the schema declares, set or not", () => {
    const expected = ["plain", "viaMeta", "optional", "optionalOuter", "defaulted", "nullable", "nested.token", "list[]", "listOuter", "objects[].key", "record.*"];
    expect(secretPaths(json)).toEqual(expected);
    expect(secretPaths(configSchema.toJSONSchema(opts))).toEqual(expected);
    expect(secretPaths(z.toJSONSchema(z.object({ a: z.string(), b: z.array(z.number()) }), opts))).toEqual([]);
    expect(secretPaths(z.toJSONSchema(z.object({ pair: z.tuple([z.string(), secret(z.string())]) }), opts))).toEqual(["pair[1]"]);
    expect(secretPaths({ type: "string", writeOnly: true })).toEqual([""]);
    expect(secretPaths(null)).toEqual([]);
  });

  it("follows $refs, once through a recursive one", () => {
    const tree = { $defs: { node: { type: "object", properties: { key: { type: "string", writeOnly: true }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } }, $ref: "#/$defs/node" };
    expect(secretPaths(tree)).toEqual(["key"]);
    const Node: z.ZodType = z.lazy(() => z.object({ key: secret(z.string()), children: z.array(Node) }));
    expect(secretPaths(z.toJSONSchema(z.object({ root: Node }), opts))).toEqual(["root.key"]);
  });

  it("names the secret fields a config sets", () => {
    expect(secretFields(json, config)).toEqual([
      "plain",
      "viaMeta",
      "optional",
      "optionalOuter",
      "defaulted",
      "nullable",
      "nested.token",
      "list[0]",
      "list[1]",
      "listOuter",
      "objects[0].key",
      "record.a",
    ]);
    expect(secretFields(json, { normal: "x", plain: "", nullable: null, nested: { name: "n" } })).toEqual([]);
    expect(secretFields(json, { plain: "abc" })).toEqual(["plain"]);
  });

  it("drops secret fields and keeps the rest", () => {
    expect(omitSecrets(json, config)).toEqual({
      nested: { name: "not-a-secret" },
      list: [],
      objects: [{ label: "visible-label" }],
      normal: "visible-value",
    });
    // An object emptied by the omission goes; one that was empty already stays.
    const wrapped = z.toJSONSchema(z.object({ hook: z.object({ token: secret(z.string()).optional() }).default({}) }), opts);
    expect(omitSecrets(wrapped, { hook: { token: null } })).toEqual({});
    expect(omitSecrets(wrapped, { hook: {} })).toEqual({ hook: {} });
    // A stored config with masked (null) secrets compares equal to a file that sets them.
    expect(omitSecrets(json, { plain: null, nested: { token: null, name: "not-a-secret" }, normal: "visible-value" })).toEqual(
      omitSecrets(json, { plain: "plain-secret", nested: { token: "t0k3n-value", name: "not-a-secret" }, normal: "visible-value" }),
    );
    expect(config.plain).toBe("plain-secret");
  });
});

describe("redactSecrets", () => {
  it("replaces secrets in strings and keys, deeply, without touching the input", () => {
    const input = { message: "key=sk_live_123 sent", nested: [{ "sk_live_123": "x sk_live_123 y" }], n: 5, ok: true, nil: null };
    const before = JSON.stringify(input);
    expect(redactSecrets(input, ["sk_live_123"])).toEqual({ message: "key=[secret] sent", nested: [{ "[secret]": "x [secret] y" }], n: 5, ok: true, nil: null });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("replaces the longer of overlapping secrets whole", () => {
    expect(redactSecrets("token abcdef-ghijkl", ["abcdef", "abcdef-ghijkl"])).toBe("token [secret]");
    expect(redactSecrets("token abcdef-ghijkl", ["abcdef-ghijkl", "abcdef"])).toBe("token [secret]");
  });

  it("catches JSON-escaped and URL-encoded forms", () => {
    expect(redactSecrets('{"key":"pa\\"ss/word"}', ['pa"ss/word'])).toBe('{"key":"[secret]"}');
    expect(redactSecrets("https://x.test/?k=pa%2Fss%20word", ["pa/ss word"])).toBe("https://x.test/?k=[secret]");
  });

  it("returns the value itself when there are no secrets", () => {
    const value = { a: "b" };
    expect(redactSecrets(value, [])).toBe(value);
    expect(redactSecrets(value, [""])).toBe(value);
  });
});

describe("RunManager secrets option", () => {
  const SECRET = "sk_test_51Hsecret";
  const SHORT = "abc12";

  function harness(actuator: Actuator, rawConfig: unknown) {
    let now = Date.parse("2026-11-02T00:00:00Z");
    const json = z.toJSONSchema(actuator.config!, opts);
    const config = actuator.config!.parse(rawConfig);
    const outputs: unknown[] = [];
    const manager = new RunManager({
      sql: nodeSqlite(new DatabaseSync(":memory:")),
      approvalSecret: "test-secret",
      approvalUrl: "https://example.test/approve",
      now: () => now,
      consoleLogs: false,
      secrets: () => collectSecrets(json, config),
      invoke: async (request, journal) => {
        const outcome = await executePass(actuator, request, { journal, config });
        outputs.push(outcome);
        return outcome;
      },
    });
    return {
      manager,
      outputs,
      advance: async (ms: number) => {
        now += ms;
        await manager.alarm();
      },
    };
  }

  const leaky = defineActuator({
    name: "leaky",
    description: "test",
    config: z.object({ apiKey: secret(z.string()), pin: secret(z.string()), region: z.string() }),
    input: z.object({ fail: z.enum(["no", "step", "run"]).default("no") }),
    async run(ctx, input, config) {
      ctx.log.info(`calling with ${config.apiKey}`, { headers: { authorization: `Bearer ${config.apiKey}` }, pin: config.pin, [config.apiKey]: 1 });
      const fetched = await ctx.step.do("fetch", () => ({ key: config.apiKey, region: config.region }));
      await ctx.step.sleep("1 minute");
      // Replay hands back the raw stored value, not "[secret]".
      const replayed = await ctx.step.do("check", () => fetched.key === config.apiKey);
      if (input.fail === "step") await ctx.step.do("boom", () => { throw new Error(`upstream refused ${config.apiKey}`); });
      if (input.fail === "run") throw new Error(`bad key ${config.apiKey}`);
      return { replayed, echoed: fetched.key, pin: config.pin };
    },
  });

  it("redacts logs and every read, while replay gets the raw step value", async () => {
    const h = harness(leaky, { apiKey: SECRET, pin: SHORT, region: "eu" });
    const { run } = await h.manager.start({ input: {}, trigger: { kind: "api" } });
    expect(run.status).toBe("WAITING");
    await h.advance(60_000);

    const done = h.manager.getRun(run.runId)!;
    expect(done.status).toBe("COMPLETED");
    // The raw pass output had the real key, and the replayed step compared equal to it.
    expect(h.outputs.at(-1)).toMatchObject({ status: "completed", output: { replayed: true, echoed: SECRET } });
    expect(done.output).toEqual({ replayed: true, echoed: "[secret]", pin: SHORT });
    expect(h.manager.listRuns()[0]!.output).toEqual(done.output);

    const steps = h.manager.getSteps(run.runId);
    expect(steps.find((s) => s.name === "fetch")!.output).toEqual({ key: "[secret]", region: "eu" });
    // The journal a pass reads still has the raw value.
    const raw = await h.manager.journal(run.runId).loadSteps();
    expect(raw.find((s) => s.step_name === "fetch")!.output_json).toContain(SECRET);

    const logs = h.manager.getLogs(run.runId);
    expect(logs[0]).toMatchObject({ message: "calling with [secret]", data: { headers: { authorization: "Bearer [secret]" }, pin: SHORT, "[secret]": 1 } });
    expect(JSON.stringify([done, steps, logs, h.manager.listRuns()])).not.toContain(SECRET);
  });

  it("redacts run errors and step errors when written", async () => {
    const h = harness(leaky, { apiKey: SECRET, pin: SHORT, region: "eu" });
    const stepFail = (await h.manager.start({ input: { fail: "step" }, trigger: { kind: "api" } })).run;
    const runFail = (await h.manager.start({ input: { fail: "run" }, trigger: { kind: "api" } })).run;
    await h.advance(60_000);

    const a = h.manager.getRun(stepFail.runId)!;
    expect(a.status).toBe("FAILED");
    expect(a.error!.message).toBe("upstream refused [secret]");
    expect(h.manager.getSteps(stepFail.runId).find((s) => s.name === "boom")!.error).toBe("upstream refused [secret]");
    const b = h.manager.getRun(runFail.runId)!;
    expect(b.error!.message).toBe("bad key [secret]");

    // Stored that way, not only read that way.
    const rows = JSON.stringify(h.manager["sql"].exec(`SELECT error_json FROM _actuate_runs`)) + JSON.stringify(h.manager["sql"].exec(`SELECT error FROM _actuate_steps`)) + JSON.stringify(h.manager["sql"].exec(`SELECT lines_json FROM _actuate_logs`));
    expect(rows).not.toContain(SECRET);
    expect(rows).toContain("[secret]");
  });

  it("redacts approval messages and the approval queue", async () => {
    const act = defineActuator({
      name: "ask",
      description: "test",
      config: z.object({ apiKey: secret(z.string()) }),
      input: z.object({}),
      async run(ctx, _input, config) {
        return ctx.step.waitForApproval("ok", { message: `Use ${config.apiKey}?` });
      },
    });
    const approvals: string[] = [];
    const config = { apiKey: SECRET };
    const manager = new RunManager({
      sql: nodeSqlite(new DatabaseSync(":memory:")),
      approvalSecret: "s",
      approvalUrl: "https://example.test/approve",
      consoleLogs: false,
      secrets: () => collectSecrets(z.toJSONSchema(act.config!, opts), config),
      notifyApproval: async (r) => void approvals.push(r.message!),
      invoke: (request, journal) => executePass(act, request, { journal, config }),
    });
    await manager.start({ input: {}, trigger: { kind: "api" } });
    expect(approvals).toEqual(["Use [secret]?"]);
    expect(manager.pendingApprovals()[0]!.message).toBe("Use [secret]?");
  });

  it("changes nothing without the option", async () => {
    const act = defineActuator({
      name: "plain",
      description: "test",
      config: z.object({ apiKey: secret(z.string()) }),
      input: z.object({}),
      run: (_ctx, _input, config) => config.apiKey,
    });
    const manager = new RunManager({
      sql: nodeSqlite(new DatabaseSync(":memory:")),
      approvalSecret: "s",
      approvalUrl: "https://example.test/approve",
      consoleLogs: false,
      invoke: (request, journal) => executePass(act, request, { journal, config: { apiKey: SECRET } }),
    });
    const { run } = await manager.start({ input: {}, trigger: { kind: "api" } });
    expect(run.output).toBe(SECRET);
  });
});
