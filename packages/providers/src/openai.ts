// Docs: https://developers.openai.com/api/reference/resources/responses/methods/create
import { z } from "zod";
import type { ProviderDefinition } from "./contract.js";
import type { LlmProvider } from "@actuate/sdk";
import { llmMessages, optionalString, parseWith, requestJson } from "./util.js";

export const OPENAI_DEFAULT_MODEL = "gpt-6.1-sol";

const schema = z.object({
  apiKey: z.string({ error: "apiKey is required" }).trim().startsWith("sk-", 'apiKey must start with "sk-"'),
  model: optionalString(),
  organization: optionalString(),
  project: optionalString(),
});
export type OpenAiCredentials = z.output<typeof schema>;

interface ResponsesResponse {
  model: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens: number; output_tokens: number };
}

export const openai: ProviderDefinition<OpenAiCredentials, "llm"> = {
  kind: "openai",
  capability: "llm",
  label: "OpenAI",
  credentialFields: [
    { key: "apiKey", label: "API key", secret: true },
    { key: "model", label: "Default model", secret: false, optional: true, help: `Defaults to ${OPENAI_DEFAULT_MODEL}.` },
    { key: "organization", label: "Organization ID", secret: false, optional: true },
    { key: "project", label: "Project ID", secret: false, optional: true },
  ],
  parseCredentials: (input) => parseWith("OpenAI", schema, input),
  create(credentials, ctx): LlmProvider {
    const headers: Record<string, string> = { authorization: `Bearer ${credentials.apiKey}`, "content-type": "application/json" };
    if (credentials.organization) headers["openai-organization"] = credentials.organization;
    if (credentials.project) headers["openai-project"] = credentials.project;
    return {
      async complete(request) {
        const body = await requestJson<ResponsesResponse>("OpenAI", ctx.fetch, "https://api.openai.com/v1/responses", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: request.model ?? credentials.model ?? OPENAI_DEFAULT_MODEL,
            ...(request.system ? { instructions: request.system } : {}),
            input: llmMessages(request).map((m) => ({ role: m.role, content: m.content })),
            ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            store: false,
          }),
        });
        const parts = (body.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
        const refusal = parts.find((p) => p.type === "refusal");
        const text = parts.filter((p) => p.type === "output_text").map((p) => p.text ?? "").join("");
        if (!text && refusal) throw new Error(`OpenAI declined the request: ${refusal.refusal ?? "no reason given"}`);
        return {
          text,
          model: body.model,
          ...(body.usage ? { usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } } : {}),
        };
      },
    };
  },
};
