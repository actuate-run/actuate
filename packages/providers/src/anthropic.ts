// Docs: https://platform.claude.com/docs/en/api/messages (API version: https://platform.claude.com/docs/en/api/versioning)
import { z } from "zod";
import type { ProviderDefinition } from "./contract.js";
import type { LlmProvider } from "@actuate/sdk";
import { llmMessages, optionalString, parseWith, requestJson } from "./util.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5-5";
export const ANTHROPIC_API_VERSION = "2026-10-21";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;

const schema = z.object({
  apiKey: z.string({ error: "apiKey is required" }).trim().startsWith("sk-ant-", 'apiKey must start with "sk-ant-"'),
  model: optionalString(),
});
export type AnthropicCredentials = z.output<typeof schema>;

interface MessagesResponse {
  model: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: { input_tokens: number; output_tokens: number };
}

export const anthropic: ProviderDefinition<AnthropicCredentials, "llm"> = {
  kind: "anthropic",
  capability: "llm",
  label: "Anthropic (Claude)",
  credentialFields: [
    { key: "apiKey", label: "API key", secret: true, help: "From console.anthropic.com." },
    { key: "model", label: "Default model", secret: false, optional: true, help: `Defaults to ${ANTHROPIC_DEFAULT_MODEL}.` },
  ],
  parseCredentials: (input) => parseWith("Anthropic", schema, input),
  create(credentials, ctx): LlmProvider {
    return {
      async complete(request) {
        // API version 2026-10-21 rejects temperature/top_p/top_k on every model, so
        // request.temperature is deliberately not forwarded.
        const body = await requestJson<MessagesResponse>("Anthropic", ctx.fetch, "https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": credentials.apiKey,
            "anthropic-version": ANTHROPIC_API_VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: request.model ?? credentials.model ?? ANTHROPIC_DEFAULT_MODEL,
            max_tokens: request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
            ...(request.system ? { system: request.system } : {}),
            messages: llmMessages(request),
          }),
        });
        if (body.stop_reason === "refusal") {
          const why = body.stop_details?.explanation ?? body.stop_details?.category ?? "no reason given";
          throw new Error(`Anthropic declined the request (${why})`);
        }
        const text = body.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
        return {
          text,
          model: body.model,
          ...(body.usage ? { usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } } : {}),
        };
      },
    };
  },
};
