import { describe, expect, it } from "vitest";
import { configuredFromEnv, envName, envVarsFor, providersFromEnv } from "../src/index.js";

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
