import { describe, expect, it } from "vitest";
import { discord, envVarsFor, openaiCompatible, slack } from "../src/index.js";
import { htmlToDiscord, htmlToSlack } from "../src/chat-format.js";
import { context, json, mockFetch } from "./helpers.js";

describe("slack", () => {
  it("posts with a bot token to a channel", async () => {
    const creds = slack.parseCredentials({ botToken: "xoxb-1-2-abc" });
    const { fetch, calls } = mockFetch(json({ ok: true, channel: "C01", ts: "1793664000.000100" }));
    const receipt = await slack.create(creds, context(fetch)).send("C01", "Refund <RM 50> & done");
    expect(receipt).toEqual({ id: "C01:1793664000.000100", channel: "slack" });
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]!.headers.authorization).toBe("Bearer xoxb-1-2-abc");
    expect(JSON.parse(calls[0]!.body)).toEqual({ channel: "C01", text: "Refund &lt;RM 50&gt; &amp; done", unfurl_links: false });
  });

  it("surfaces Slack's ok:false errors", async () => {
    const creds = slack.parseCredentials({ botToken: "xoxb-1", defaultChannel: "C09" });
    const { fetch } = mockFetch(json({ ok: false, error: "not_in_channel" }));
    await expect(slack.create(creds, context(fetch)).send("", "x")).rejects.toThrow(/not_in_channel/);
  });

  it("posts to an incoming webhook and converts HTML", async () => {
    const creds = slack.parseCredentials({ webhookUrl: "https://hooks.slack.com/services/T/B/x" });
    const { fetch, calls } = mockFetch(() => new Response("ok"));
    const receipt = await slack.create(creds, context(fetch)).send("", '<b>Approve</b> refund: <a href="https://run.actuate.run/a/x/approve?t=1">open</a>', { format: "html" });
    expect(receipt).toEqual({ id: "webhook", channel: "slack" });
    expect(JSON.parse(calls[0]!.body).text).toBe("*Approve* refund: <https://run.actuate.run/a/x/approve?t=1|open>");
  });

  it("needs a bot token or webhook URL", () => {
    expect(() => slack.parseCredentials({})).toThrow(/botToken .* or webhookUrl/);
    expect(() => slack.parseCredentials({ webhookUrl: "https://evil.example/hook" })).toThrow(/hooks\.slack\.com/);
    expect(() => slack.parseCredentials({ botToken: "xoxp-user" })).toThrow(/xoxb-/);
  });
});

describe("discord", () => {
  it("posts with a bot token and never pings everyone", async () => {
    const creds = discord.parseCredentials({ botToken: "bot.token" });
    const { fetch, calls } = mockFetch(json({ id: "123" }));
    expect(await discord.create(creds, context(fetch)).send("1100000000000000000", "@everyone deploy done")).toEqual({ id: "123", channel: "discord" });
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/1100000000000000000/messages");
    expect(calls[0]!.headers.authorization).toBe("Bot bot.token");
    expect(JSON.parse(calls[0]!.body)).toEqual({ content: "@everyone deploy done", allowed_mentions: { parse: ["users"] } });
  });

  it("posts to a webhook with wait=true and converts HTML", async () => {
    const creds = discord.parseCredentials({ webhookUrl: "https://discord.com/api/webhooks/123/abc-DEF" });
    const { fetch, calls } = mockFetch(json({ id: "456" }));
    await discord.create(creds, context(fetch)).send("", '<b>Paid</b> <a href="https://x.example/r">receipt</a>', { format: "html" });
    expect(calls[0]!.url).toBe("https://discord.com/api/webhooks/123/abc-DEF?wait=true");
    expect(JSON.parse(calls[0]!.body).content).toBe("**Paid** [receipt](https://x.example/r)");
  });

  it("refuses over-long messages and bad webhook URLs", async () => {
    const creds = discord.parseCredentials({ botToken: "t", defaultChannel: "1100000000000000000" });
    const { fetch } = mockFetch(json({ id: "1" }));
    await expect(discord.create(creds, context(fetch)).send("", "x".repeat(2001))).rejects.toThrow(/2000/);
    expect(() => discord.parseCredentials({ webhookUrl: "https://discord.com.evil.example/api/webhooks/1/a" })).toThrow(/Discord webhook URL/);
  });
});

describe("openai-compatible", () => {
  const creds = openaiCompatible.parseCredentials({ baseUrl: "https://openrouter.ai/api/v1/", apiKey: "sk-or-1", model: "meta-llama/llama-4-maverick", headers: '{"X-Title":"Actuate","Authorization":"nope"}' });

  it("calls /chat/completions with system, messages and usage", async () => {
    const { fetch, calls } = mockFetch(json({ model: "meta-llama/llama-4-maverick", choices: [{ message: { content: "Hi Aina" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    const out = await openaiCompatible.create(creds, context(fetch)).complete({ system: "Be brief.", prompt: "Greet Aina", maxTokens: 20 });
    expect(out).toEqual({ text: "Hi Aina", model: "meta-llama/llama-4-maverick", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-or-1");
    expect(calls[0]!.headers["x-title"]).toBe("Actuate");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      model: "meta-llama/llama-4-maverick",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Greet Aina" }],
      max_tokens: 20,
    });
  });

  it("validates the base URL", () => {
    const parse = (baseUrl: string) => () => openaiCompatible.parseCredentials({ baseUrl, model: "m" });
    expect(parse("http://api.example.com/v1")).toThrow(/https/);
    expect(parse("https://10.0.0.1/v1")).toThrow(/hostname/);
    expect(parse("https://user:pw@api.example.com/v1")).toThrow(/credentials/);
    expect(parse("http://localhost:11434/v1")).not.toThrow();
    expect(() => openaiCompatible.parseCredentials({ baseUrl: "https://x.example/v1", model: "m", headers: "nope" })).toThrow(/JSON object/);
  });

  it("reads its environment variables with underscores", () => {
    expect(envVarsFor("openai-compatible").map((v) => v.name)).toEqual([
      "OPENAI_COMPATIBLE_BASE_URL",
      "OPENAI_COMPATIBLE_API_KEY",
      "OPENAI_COMPATIBLE_MODEL",
      "OPENAI_COMPATIBLE_HEADERS",
    ]);
  });
});

describe("chat formatting", () => {
  it("keeps Slack escapes and converts tags", () => {
    expect(htmlToSlack("<i>a</i> &lt;b&gt; <code>x</code><br>y")).toBe("_a_ &lt;b&gt; `x`\ny");
    expect(htmlToDiscord("<pre>z</pre> &amp;")).toBe("```z``` &");
  });
});
