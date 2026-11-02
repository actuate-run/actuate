import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "e2e_booking",
  description: "End-to-end fixture: saves a booking, waits for payment or an approval, sleeps briefly.",
  config: z.object({ greeting: z.string().default("Hi") }),
  input: z.object({ name: z.string(), mode: z.enum(["payment", "approval", "sleep"]) }),
  capabilities: ["messaging"],
  async run(ctx, input, config) {
    await ctx.db.migrate(["CREATE TABLE bookings (id TEXT PRIMARY KEY, name TEXT, status TEXT)"]);
    await ctx.step.do("save", () => ctx.db.sql`INSERT INTO bookings VALUES (${ctx.runId}, ${input.name}, 'PENDING')`);
    await ctx.step.do("greet", () => ctx.messaging.send("chat-1", `${config.greeting} ${input.name}`));
    if (input.mode === "sleep") {
      await ctx.step.sleep("1 second");
      return { status: "WOKE" };
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
