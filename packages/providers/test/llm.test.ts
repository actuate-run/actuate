import { describe, expect, it } from "vitest";
import { anthropic, google, openai } from "../src/index.js";
import { context, json, mockFetch } from "./helpers.js";

describe("anthropic", () => {
  const creds = anthropic.parseCredentials({ apiKey: "sk-ant-api03-abc" });
  const reply = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hello" }, { type: "text", text: " there" }],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 12, output_tokens: 3 },
  };

  it("calls the Messages API with the default model", async () => {
    const { fetch, calls } = mockFetch(json(reply));
    const res = await anthropic.create(creds, context(fetch)).complete({
      system: "Be brief",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yes?" }],
      prompt: "say hello",
      temperature: 0.2,
    });
    expect(res).toEqual({ text: "Hello there", model: "claude-sonnet-5-5", usage: { inputTokens: 12, outputTokens: 3 } });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.method).toBe("POST");
    expect(call.headers["x-api-key"]).toBe("sk-ant-api03-abc");
    expect(call.headers["anthropic-version"]).toBe("2026-10-21");
    expect(JSON.parse(call.body)).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system: "Be brief",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yes?" },
        { role: "user", content: "say hello" },
      ],
    });
  });

  it("lets credentials and requests override the model", async () => {
    const { fetch, calls } = mockFetch(json(reply));
    const withModel = anthropic.parseCredentials({ apiKey: "sk-ant-1", model: "claude-opus-5-5" });
    await anthropic.create(withModel, context(fetch)).complete({ prompt: "x" });
    expect(JSON.parse(calls[0]!.body).model).toBe("claude-opus-5-5");
    await anthropic.create(withModel, context(fetch)).complete({ prompt: "x", model: "claude-haiku-5-5", maxTokens: 100 });
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 100 });
  });

  it("validates credentials and requests", async () => {
    expect(() => anthropic.parseCredentials({ apiKey: "sk-123" })).toThrow(/apiKey must start with "sk-ant-"/);
    const { fetch } = mockFetch(json(reply));
    await expect(anthropic.create(creds, context(fetch)).complete({})).rejects.toThrow(/prompt or at least one message/);
  });

  it("surfaces API errors and refusals", async () => {
    const err = mockFetch(json({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: Field required" } }, 400));
    await expect(anthropic.create(creds, context(err.fetch)).complete({ prompt: "x" })).rejects.toThrow(
      "Anthropic API error (HTTP 400): max_tokens: Field required",
    );
    const refusal = mockFetch(json({ ...reply, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }));
    await expect(anthropic.create(creds, context(refusal.fetch)).complete({ prompt: "x" })).rejects.toThrow("Anthropic declined the request (cyber)");
  });
});

describe("openai", () => {
  const creds = openai.parseCredentials({ apiKey: "sk-proj-abc", project: "proj_1" });
  const reply = {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-6.1-sol-2026-09-01",
    output: [
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi!", annotations: [] }] },
    ],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  };

  it("calls the Responses API", async () => {
    const { fetch, calls } = mockFetch(json(reply));
    const res = await openai.create(creds, context(fetch)).complete({ system: "Be brief", prompt: "hello", maxTokens: 50, temperature: 0.5 });
    expect(res).toEqual({ text: "Hi!", model: "gpt-6.1-sol-2026-09-01", usage: { inputTokens: 5, outputTokens: 2 } });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.headers.authorization).toBe("Bearer sk-proj-abc");
    expect(call.headers["openai-project"]).toBe("proj_1");
    expect(JSON.parse(call.body)).toEqual({
      model: "gpt-6.1-sol",
      instructions: "Be brief",
      input: [{ role: "user", content: "hello" }],
      max_output_tokens: 50,
      temperature: 0.5,
      store: false,
    });
  });

  it("validates credentials", () => {
    expect(() => openai.parseCredentials({})).toThrow(/apiKey is required/);
  });

  it("surfaces API errors and refusals", async () => {
    const err = mockFetch(json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }, 401));
    await expect(openai.create(creds, context(err.fetch)).complete({ prompt: "x" })).rejects.toThrow("OpenAI API error (HTTP 401): Incorrect API key provided.");
    const refusal = mockFetch(json({ ...reply, output: [{ type: "message", content: [{ type: "refusal", refusal: "Can't help" }] }] }));
    await expect(openai.create(creds, context(refusal.fetch)).complete({ prompt: "x" })).rejects.toThrow(/declined the request: Can't help/);
  });
});

describe("google", () => {
  const creds = google.parseCredentials({ apiKey: "AIza-key" });
  const reply = {
    candidates: [{ content: { role: "model", parts: [{ text: "thinking...", thought: true }, { text: "Hai" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
    modelVersion: "gemini-3.8-flash",
  };

  it("calls generateContent", async () => {
    const { fetch, calls } = mockFetch(json(reply));
    const res = await google.create(creds, context(fetch)).complete({
      system: "Malay only",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hai" }],
      prompt: "again",
      maxTokens: 20,
      temperature: 0,
    });
    expect(res).toEqual({ text: "Hai", model: "gemini-3.8-flash", usage: { inputTokens: 4, outputTokens: 1 } });
    const call = calls[0]!;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(call.headers["x-goog-api-key"]).toBe("AIza-key");
    expect(JSON.parse(call.body)).toEqual({
      systemInstruction: { parts: [{ text: "Malay only" }] },
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "hai" }] },
        { role: "user", parts: [{ text: "again" }] },
      ],
      generationConfig: { maxOutputTokens: 20, temperature: 0 },
    });
  });

  it("accepts a models/ prefixed model and validates credentials", async () => {
    const { fetch, calls } = mockFetch(json(reply));
    await google.create(creds, context(fetch)).complete({ prompt: "x", model: "models/gemini-4-argon" });
    expect(calls[0]!.url).toContain("/models/gemini-4-argon:generateContent");
    expect(() => google.parseCredentials({ apiKey: "  " })).toThrow(/apiKey is required/);
  });

  it("surfaces API errors and blocks", async () => {
    const err = mockFetch(json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, 400));
    await expect(google.create(creds, context(err.fetch)).complete({ prompt: "x" })).rejects.toThrow(
      "Google API error (HTTP 400): API key not valid. Please pass a valid API key.",
    );
    const blocked = mockFetch(json({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(google.create(creds, context(blocked.fetch)).complete({ prompt: "x" })).rejects.toThrow("Google blocked the prompt (SAFETY)");
  });
});
