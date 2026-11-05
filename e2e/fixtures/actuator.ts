import { defineActuator, secret, z } from "@actuate/sdk";

export default defineActuator({
  name: "e2e_booking",
  description: "End-to-end fixture: saves a booking, waits for payment or an approval, sleeps briefly.",
  config: z.object({ greeting: z.string().default("Hi"), apiKey: secret(z.string()).optional() }),
  input: z.object({ name: z.string(), mode: z.enum(["payment", "approval", "sleep", "ask", "leak", "notify"]) }),
  capabilities: ["messaging"],
  async run(ctx, input, config) {
    await ctx.db.migrate(["CREATE TABLE bookings (id TEXT PRIMARY KEY, name TEXT, status TEXT)"]);
    await ctx.step.do("save", () => ctx.db.sql`INSERT INTO bookings VALUES (${ctx.runId}, ${input.name}, 'PENDING')`);
    await ctx.step.do("greet", () => ctx.messaging.send("chat-1", `${config.greeting} ${input.name}`));
    if (input.mode === "leak") {
      // Shows the secret everywhere it could leak: a log line, a step output, the run's error.
      ctx.log.info(`key is ${config.apiKey}`);
      const key = await ctx.step.do("read-key", () => config.apiKey ?? null);
      if (input.name === "fail") throw new Error(`refused ${key}`);
      return { key, same: key === config.apiKey };
    }
    if (input.mode === "notify") {
      return ctx.step.do("tell", () => ctx.notifyOwner(`${input.name} used ${config.apiKey}`, { subject: "Heads up" }));
    }
    if (input.mode === "sleep") {
      await ctx.step.sleep("1 second");
      return { status: "WOKE" };
    }
    if (input.mode === "ask") {
      const answer = await ctx.step.waitForInput("why", { prompt: "Why?" });
      return { status: answer?.text ?? "NO_ANSWER" };
    }
    if (input.mode === "approval") {
      const decision = await ctx.step.waitForApproval("ok", { message: "Approve?" });
      return { status: decision?.approved ? "APPROVED" : "REJECTED" };
    }
    const paid = await ctx.step.waitForEvent("payment", { event: `payment.${ctx.runId}`, timeout: "1 hour" });
    await ctx.step.do("mark", () => ctx.db.query("UPDATE bookings SET status = ? WHERE id = ?", [paid ? "PAID" : "UNPAID", ctx.runId]));
    return { status: paid ? "PAID" : "UNPAID" };
  },
});
