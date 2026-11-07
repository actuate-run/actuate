import { describe, expect, it } from "vitest";
import { configuredFromEnv, envName, envVarsFor, parseProviderWebhookFromEnv, providersFromEnv } from "../src/index.js";

describe("providers from environment variables", () => {
  it("derives variable names from credential fields", () => {
    expect(envName("telegram", "botToken")).toBe("TELEGRAM_BOT_TOKEN");
    expect(envName("billplz", "xSignatureKey")).toBe("BILLPLZ_X_SIGNATURE_KEY");
    expect(envVarsFor("billplz").map((v) => v.name)).toContain("BILLPLZ_COLLECTION_ID");
  });

  it("builds only the capabilities selected with ACTUATE_<CAPABILITY>", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      return Response.json({ ok: true, result: { message_id: 7, chat: { id: 1 } } });
    }) as typeof fetch;
    const providers = providersFromEnv(
      { ACTUATE_MESSAGING: "telegram", TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", UNRELATED: "x" },
      "http://localhost:8787",
      fakeFetch,
    );
    expect(Object.keys(providers)).toEqual(["messaging"]);
    await providers.messaging!.send("42", "hi");
    expect(calls[0]).toContain("api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage");
  });

  it("explains wrong kinds and missing credentials", () => {
    expect(() => configuredFromEnv({ ACTUATE_MESSAGING: "stripe" })).toThrow(/not a messaging provider.*telegram/);
    expect(() => configuredFromEnv({ ACTUATE_PAYMENT: "billplz" })).toThrow(/apiKey/);
  });
});

describe("parseProviderWebhookFromEnv", () => {
  const env = {
    ACTUATE_MESSAGING: "slack,discord",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXXX",
    SLACK_SIGNING_SECRET: "8f742231b10e8888abcd99yyyzzz85a5",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc-DEF",
  };
  const post = () => new Request("https://bot.example.com/hook", { method: "POST", body: "payload=%7B%7D" });

  it("ignores requests for a configured provider that takes no webhooks of its own (button clicks are handled before)", async () => {
    expect(await parseProviderWebhookFromEnv(env, "slack", post())).toBeNull();
    expect(await parseProviderWebhookFromEnv(env, "discord", post())).toBeNull();
  });

  it("refuses a provider that isn't configured, or isn't one", async () => {
    await expect(parseProviderWebhookFromEnv(env, "telegram", post())).rejects.toMatchObject({ name: "WebhookVerificationError", message: "No telegram provider is configured." });
    await expect(parseProviderWebhookFromEnv(env, "nope", post())).rejects.toMatchObject({ name: "WebhookVerificationError", message: "No nope provider is configured." });
    await expect(parseProviderWebhookFromEnv({}, "slack", post())).rejects.toMatchObject({ name: "WebhookVerificationError" });
  });
});

describe("several messaging channels", () => {
  it("routes send() by channel, defaulting to the first listed", async () => {
    const { providersFromEnv } = await import("../src/env.js");
    const calls: string[] = [];
    const fetch = (async (url: string) => {
      calls.push(new URL(url).host);
      return url.includes("telegram") ? Response.json({ ok: true, result: { message_id: 1 } }) : new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    const env = {
      ACTUATE_MESSAGING: "telegram, slack",
      TELEGRAM_BOT_TOKEN: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
    };
    const p = providersFromEnv(env, "http://localhost:8787", fetch);
    expect(await p.messaging!.send("1", "hi")).toMatchObject({ channel: "telegram" });
    expect(await p.messaging!.send("", "team", { channel: "slack" })).toMatchObject({ channel: "slack" });
    await expect(p.messaging!.send("a@b.co", "x", { channel: "email" })).rejects.toThrow(/No "email" messaging channel.*telegram, slack/);
    expect(calls).toEqual(["api.telegram.org", "hooks.slack.com"]);
  });

  it("allows a list only for messaging", async () => {
    const { configuredFromEnv } = await import("../src/env.js");
    expect(() => configuredFromEnv({ ACTUATE_LLM: "openai,anthropic" })).toThrow(/only messaging/);
    expect(() => configuredFromEnv({ ACTUATE_MESSAGING: "slack,slack", SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" })).toThrow(/twice/);
  });
});
