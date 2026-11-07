import { describe, expect, it } from "vitest";
import { combineMessaging } from "../src/index.js";

describe("combineMessaging", () => {
  const sent: string[] = [];
  const provider = (kind: string) => ({ kind, provider: { send: async (to: string) => (sent.push(`${kind}:${to}`), { id: "1", channel: kind }) } });

  it("refuses a channel that isn't configured, even with one provider", async () => {
    const one = combineMessaging([provider("telegram")]);
    await expect(one.send("C1", "hi", { channel: "slack" })).rejects.toThrow('No "slack" messaging channel is configured. Configured: telegram.');
    expect(sent).toEqual([]);
    await one.send("42", "hi");
    await one.send("43", "hi", { channel: "Telegram " });
    const email = combineMessaging([provider("resend")]);
    await email.send("a@b.test", "hi", { channel: "email" });
    await email.send("a@b.test", "hi", { channel: "resend" });
    expect(sent).toEqual(["telegram:42", "telegram:43", "resend:a@b.test", "resend:a@b.test"]);
  });

  it("picks by channel among several, the first by default", async () => {
    sent.length = 0;
    const both = combineMessaging([provider("telegram"), provider("slack")]);
    await both.send("1", "a");
    await both.send("2", "b", { channel: "slack" });
    await expect(both.send("3", "c", { channel: "discord" })).rejects.toThrow('No "discord" messaging channel is configured. Configured: telegram, slack.');
    expect(sent).toEqual(["telegram:1", "slack:2"]);
  });
});
