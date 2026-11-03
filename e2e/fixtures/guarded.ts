import { defineActuator, z } from "@actuate/sdk";

/** Exercises the platform guards `actuate dev` applies. */
export default defineActuator({
  name: "e2e_guarded",
  description: "Does one thing the platform allows or refuses, by mode.",
  input: z.object({ mode: z.enum(["ok", "pragma", "big", "sleep", "send"]) }),
  capabilities: ["messaging"],
  async run(ctx, input) {
    await ctx.db.migrate(["CREATE TABLE notes (run_id TEXT PRIMARY KEY, mode TEXT NOT NULL)"]);
    await ctx.step.do("note", () => ctx.db.sql`INSERT INTO notes VALUES (${ctx.runId}, ${input.mode})`);
    if (input.mode === "pragma") return (await ctx.db.query("PRAGMA table_info(notes)")).length;
    if (input.mode === "big") return (await ctx.step.do("big", () => "x".repeat(1_100_000))).length;
    if (input.mode === "sleep") await ctx.step.sleep("long", "30 days");
    if (input.mode === "send") return (await ctx.step.do("send", () => ctx.messaging.send("someone", "hi"))).channel;
    return "ok";
  },
});
