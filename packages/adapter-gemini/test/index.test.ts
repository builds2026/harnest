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
});
