import type { AdapterContext, ModelEvent, ModelRequest } from "@harnest/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGeminiAdapter } from "../src/index.js";

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Gemini adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps streamGenerateContent SSE and supports URL/version overrides", async () => {
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      receivedUrl = String(input);
      receivedInit = init;
      return new Response(
        [
          'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}',
          'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}',
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const request: ModelRequest = {
      model: "gemini-test",
      baseUrl: "https://gemini.example/api",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Previous" },
      ],
      responseSchema: { type: "object" },
    };
    const context: AdapterContext = {
      signal: new AbortController().signal,
      resolveSecret: () => "secret",
    };

    const events = await collect(createGeminiAdapter({ apiVersion: "v1" }).run(request, context));

    expect(events).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
      { type: "finish", reason: "stop", model: "gemini-test" },
    ]);
    expect(receivedUrl).toBe(
      "https://gemini.example/api/v1/models/gemini-test:streamGenerateContent?alt=sse",
    );
    expect(new Headers(receivedInit?.headers).get("x-goog-api-key")).toBe("secret");
    expect(JSON.parse(String(receivedInit?.body))).toMatchObject({
      systemInstruction: { parts: [{ text: "Be concise" }] },
      contents: [
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "model", parts: [{ text: "Previous" }] },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: { type: "object" },
      },
    });
  });

  it("normalizes function calls and encodes function responses", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"gem-1","name":"sum","args":{"a":2}},"thoughtSignature":"sig-new"}]},"finishReason":"STOP"}]}',
        "",
      ].join("\n\n"));
    }));
    const events = await collect(createGeminiAdapter().run({
      model: "gemini-test",
      messages: [
        { role: "assistant", content: "", toolCalls: [{
          id: "old", name: "sum", input: { a: 1 }, providerMetadata: { thoughtSignature: "sig-old" },
        }] },
        { role: "tool", content: "1", toolCallId: "old", name: "sum" },
      ],
      tools: [{
        name: "sum",
        description: "Add",
        inputSchema: {
          type: "object",
          properties: {
            additionalProperties: { type: "string" },
            nested: { type: "object", additionalProperties: false },
          },
          examples: [{ additionalProperties: "literal data" }],
          additionalProperties: false,
        },
      }],
    }, { signal: new AbortController().signal, resolveSecret: () => "secret" }));

    expect(events).toEqual([
      { type: "tool-call", call: {
        id: "gem-1", name: "sum", input: { a: 2 }, providerMetadata: { thoughtSignature: "sig-new" },
      } },
      { type: "finish", reason: "stop", model: "gemini-test" },
    ]);
    expect(body).toMatchObject({
      tools: [{ functionDeclarations: [{
        name: "sum",
        parametersJsonSchema: {
          type: "object",
          properties: {
            additionalProperties: { type: "string" },
            nested: { type: "object" },
          },
          examples: [{ additionalProperties: "literal data" }],
        },
      }] }],
      contents: [
        { role: "model", parts: [{
          functionCall: { id: "old", name: "sum", args: { a: 1 } }, thoughtSignature: "sig-old",
        }] },
        { role: "user", parts: [{ functionResponse: { id: "old", name: "sum", response: { output: "1" } } }] },
      ],
    });
  });

  it("keeps fallback function-call IDs unique across requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"sum","args":{}}}]},"finishReason":"STOP"}]}\n\n',
    )));
    const adapter = createGeminiAdapter();
    const request: ModelRequest = { model: "gemini-test", messages: [{ role: "user", content: "add" }] };
    const context: AdapterContext = { signal: new AbortController().signal, resolveSecret: () => "secret" };

    const first = await collect(adapter.run(request, context));
    const second = await collect(adapter.run(request, context));

    expect([first[0], second[0]]).toEqual([
      { type: "tool-call", call: { id: "gemini-1-0:0:sum", name: "sum", input: {} } },
      { type: "tool-call", call: { id: "gemini-2-0:0:sum", name: "sum", input: {} } },
    ]);
  });

  it("rejects oversized function-call arguments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `data: ${JSON.stringify({
        candidates: [{
          content: { parts: [{ functionCall: {
            id: "gem-large",
            name: "sum",
            args: { value: "x".repeat(1_048_576) },
          } }] },
          finishReason: "STOP",
        }],
      })}\n\n`,
    )));

    await expect(collect(createGeminiAdapter().run({
      model: "gemini-test",
      messages: [{ role: "user", content: "use a tool" }],
    }, { signal: new AbortController().signal, resolveSecret: () => "secret" }))).rejects.toMatchObject({
      adapterId: "gemini",
      code: "provider_response_limit",
    });
  });
});
