import { describe, expect, it } from "vitest";
import { HELLO_ACTUATOR } from "create-actuate";
import { checkSource } from "../src/check.js";

const wrap = (body: string, method = true) => `
import { defineActuator, z } from "@actuate/sdk";
export default defineActuator({
  name: "t", description: "t", input: z.object({}), capabilities: ["payment", "messaging"],
  ${method ? "async run(ctx, input) {" : "run: async (c, input) => {"}
${body}
  },
});`;

const rules = (src: string) => checkSource("a.ts", src).map((d) => `${d.severity}:${d.rule}`);

describe("replay-safety linter", () => {
  it("passes the hello starter", () => {
    expect(checkSource("actuator.ts", HELLO_ACTUATOR)).toEqual([]);
  });

  it("allows side effects inside step.do, including with options", () => {
    expect(
      rules(
        wrap(`
      await ctx.step.do("a", async () => { await fetch("https://x"); return Date.now(); });
      await ctx.step.do("b", { retries: 2 }, () => ctx.payment.createBill({ amount: 1, referenceId: "r" }));
      await ctx.step.do("c", () => ctx.db.query("INSERT INTO t VALUES (1)"));`),
      ),
    ).toEqual([]);
  });

  it("flags fetch, providers, clocks and randomness outside steps", () => {
    expect(
      rules(
        wrap(`
      await fetch("https://x");
      await ctx.messaging.send("a", "b");
      const t = Date.now(); const d = new Date(); const r = Math.random(); const u = crypto.randomUUID();
      const ok = new Date("2026-01-01");`),
      ),
    ).toEqual([
      "error:no-fetch-outside-step",
      "error:no-provider-outside-step",
      "error:no-nondeterminism-outside-step",
      "error:no-nondeterminism-outside-step",
      "error:no-nondeterminism-outside-step",
      "error:no-nondeterminism-outside-step",
    ]);
  });

  it("does not treat the step name or options argument as a step body", () => {
    expect(rules(wrap(`await ctx.step.do(String(Date.now()), () => 1);`))).toEqual(["error:no-nondeterminism-outside-step"]);
  });

  it("warns on literal writes outside steps and follows a renamed ctx parameter", () => {
    expect(
      rules(
        wrap(
          `await c.db.query("UPDATE t SET x = 1"); await c.db.sql\`DELETE FROM t WHERE id = \${1}\`; await c.db.query("SELECT 1");
           await c.payment.createBill({ amount: 1, referenceId: "x" });`,
          false,
        ),
      ),
    ).toEqual(["warning:db-write-outside-step", "warning:db-write-outside-step", "error:no-provider-outside-step"]);
  });

  it("knows ctx.db.batch and commitWithStep", () => {
    expect(
      rules(
        wrap(`
      await ctx.db.batch([ctx.db.statement\`INSERT INTO t VALUES (\${1})\`, { sql: "UPDATE t SET x = 1", params: [] }, ctx.db.statement\`SELECT 1\`]);
      ctx.db.commitWithStep([ctx.db.statement\`DELETE FROM t\`]);
      const later = ctx.db.statement\`INSERT INTO t VALUES (2)\`;
      await ctx.step.do("ok", () => {
        ctx.db.commitWithStep([later]);
        return ctx.db.batch([ctx.db.statement\`INSERT INTO t VALUES (3)\`]);
      });`),
      ),
    ).toEqual(["warning:db-write-outside-step", "warning:db-write-outside-step", "error:no-commit-outside-step"]);
  });

  it("reports line and column", () => {
    const [d] = checkSource("a.ts", wrap(`await fetch("x");`));
    expect(d).toMatchObject({ line: 6, column: 7 });
  });
});
