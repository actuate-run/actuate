// Docs: https://ai.google.dev/api/generate-content
import { z } from "zod";
import type { ProviderDefinition } from "./contract.js";
import type { LlmProvider } from "@actuate/sdk";
import { llmMessages, optionalString, parseWith, requestJson, requiredString } from "./util.js";

export const GOOGLE_DEFAULT_MODEL = "gemini-3.8-flash";

const schema = z.object({
  apiKey: requiredString("apiKey"),
  model: optionalString(),
});
export type GoogleCredentials = z.output<typeof schema>;

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

export const google: ProviderDefinition<GoogleCredentials, "llm"> = {
  kind: "google",
  capability: "llm",
  label: "Google Gemini",
  credentialFields: [
    { key: "apiKey", label: "Gemini API key", secret: true, help: "From Google AI Studio." },
    { key: "model", label: "Default model", secret: false, optional: true, help: `Defaults to ${GOOGLE_DEFAULT_MODEL}.` },
  ],
  parseCredentials: (input) => parseWith("Google", schema, input),
  create(credentials, ctx): LlmProvider {
    return {
      async complete(request) {
        const model = (request.model ?? credentials.model ?? GOOGLE_DEFAULT_MODEL).replace(/^models\//, "");
        const generationConfig: Record<string, number> = {};
        if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
        if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
        const body = await requestJson<GenerateContentResponse>(
          "Google",
          ctx.fetch,
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": credentials.apiKey, "content-type": "application/json" },
            body: JSON.stringify({
              ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
              contents: llmMessages(request).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
              ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
            }),
          },
        );
        if (body.promptFeedback?.blockReason) throw new Error(`Google blocked the prompt (${body.promptFeedback.blockReason})`);
        const candidate = body.candidates?.[0];
        const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
        if (!text && candidate?.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
          throw new Error(`Google returned no text (finishReason ${candidate.finishReason})`);
        }
        const usage = body.usageMetadata;
        return {
          text,
          model: body.modelVersion ?? model,
          ...(usage ? { usage: { inputTokens: usage.promptTokenCount ?? 0, outputTokens: usage.candidatesTokenCount ?? 0 } } : {}),
        };
      },
    };
  },
};
