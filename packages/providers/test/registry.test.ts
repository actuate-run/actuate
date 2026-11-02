import { describe, expect, it } from "vitest";
import { getProvider, PROVIDERS, providersFor } from "../src/index.js";

describe("registry", () => {
  it("keys every provider by its kind", () => {
    for (const [kind, def] of Object.entries(PROVIDERS)) {
      expect(def.kind).toBe(kind);
      expect(def.label).toBeTruthy();
      expect(def.credentialFields.length).toBeGreaterThan(0);
    }
    expect(Object.keys(PROVIDERS).sort()).toEqual(["anthropic", "billplz", "chip", "discord", "google", "openai", "openai-compatible", "resend", "slack", "stripe", "telegram", "toyyibpay", "whatsapp"]);
  });

  it("looks providers up", () => {
    expect(getProvider("stripe")).toBe(PROVIDERS.stripe);
    expect(getProvider("paypal")).toBeUndefined();
    expect(getProvider("toString")).toBeUndefined();
  });

  it("groups by capability; every payment provider handles webhooks", () => {
    expect(providersFor("messaging").map((p) => p.kind)).toEqual(["telegram", "whatsapp", "slack", "discord", "resend"]);
    expect(providersFor("llm").map((p) => p.kind)).toEqual(["anthropic", "openai", "google", "openai-compatible"]);
    for (const p of providersFor("payment")) expect(typeof p.parseWebhook).toBe("function");
  });

});
