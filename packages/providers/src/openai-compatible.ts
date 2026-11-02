// Chat Completions, the de facto shared API: https://platform.openai.com/docs/api-reference/chat/create
// Works with OpenRouter, Groq, Together, DeepSeek, Mistral, Fireworks, Cloudflare Workers AI, vLLM, Ollama and others.
import { z } from "zod";
import type { ProviderDefinition } from "./contract.js";
import type { LlmProvider } from "@actuate/sdk";
import { llmMessages, optionalString, parseWith, requestJson, requiredString } from "./util.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https only (plain http for localhost, for local models under `actuate dev`); no other IP literals. */
export function checkBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "baseUrl must be a URL, e.g. https://openrouter.ai/api/v1";
  }
  const host = url.hostname.toLowerCase();
  const local = LOCAL_HOSTS.has(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "baseUrl must use https://";
  if (!local && (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("["))) return "baseUrl must use a hostname, not an IP address";
  if (url.username || url.password) return "baseUrl must not contain credentials; use apiKey";
  if (url.search || url.hash) return "baseUrl must not have a query string or fragment";
  return null;
}

const schema = z.object({
  baseUrl: z
    .string({ error: "baseUrl is required" })
    .trim()
    .superRefine((v, ctx) => {
      const problem = checkBaseUrl(v);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    })
    .transform((v) => v.replace(/\/+$/, "")),
  apiKey: optionalString(),
  model: requiredString("model"),
  headers: optionalString(),
});
export type OpenAiCompatibleCredentials = z.output<typeof schema>;

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Optional extra headers as JSON, e.g. OpenRouter's {"HTTP-Referer": "...", "X-Title": "..."}. */
function extraHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid OpenAI-compatible credentials: headers must be a JSON object, e.g. {"X-Title": "My app"}');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid OpenAI-compatible credentials: headers must be a JSON object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (/^(authorization|host|content-length|content-type)$/i.test(k)) continue;
    out[k] = String(v);
  }
  return out;
}

export const openaiCompatible: ProviderDefinition<OpenAiCompatibleCredentials, "llm"> = {
  kind: "openai-compatible",
  capability: "llm",
  label: "OpenAI-compatible API",
  credentialFields: [
    {
      key: "baseUrl",
      label: "Base URL",
      secret: false,
      help: "The API root that ends before /chat/completions, e.g. https://openrouter.ai/api/v1 or https://api.groq.com/openai/v1.",
    },
    { key: "apiKey", label: "API key", secret: true, optional: true, help: "Sent as a Bearer token. Leave empty for local servers without auth." },
    { key: "model", label: "Default model", secret: false, help: "As the service names it, e.g. meta-llama/llama-4-maverick." },
    { key: "headers", label: "Extra headers (JSON)", secret: false, optional: true, help: 'Some services want them, e.g. {"X-Title": "My app"}.' },
  ],
  parseCredentials(input) {
    const creds = parseWith("OpenAI-compatible", schema, input);
    extraHeaders(creds.headers); // validate now, not at the first call
    return creds;
  },
  create(credentials, ctx): LlmProvider {
    const headers: Record<string, string> = { ...extraHeaders(credentials.headers), "content-type": "application/json" };
    if (credentials.apiKey) headers.authorization = `Bearer ${credentials.apiKey}`;
    return {
      async complete(request) {
        const messages = [...(request.system ? [{ role: "system", content: request.system }] : []), ...llmMessages(request)];
        const body = await requestJson<ChatResponse>("OpenAI-compatible API", ctx.fetch, `${credentials.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: request.model ?? credentials.model,
            messages,
            ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          }),
        });
        const message = body.choices?.[0]?.message;
        const text = message?.content ?? "";
        if (!text && message?.refusal) throw new Error(`The model declined the request: ${message.refusal}`);
        if (!body.choices?.length) throw new Error("OpenAI-compatible API returned no choices");
        return {
          text,
          model: body.model ?? request.model ?? credentials.model,
          ...(body.usage?.prompt_tokens !== undefined
            ? { usage: { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens ?? 0 } }
            : {}),
        };
      },
    };
  },
};
