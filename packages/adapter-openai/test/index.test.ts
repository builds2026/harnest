import type { AdapterContext, ModelEvent, ModelRequest } from "@harnest/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleAdapter } from "../src/index.js";

const request: ModelRequest = {
  model: "gpt-test",
  messages: [{ role: "user", content: "Hello" }],
  apiKey: "env:TEST_OPENAI_KEY",
  maxTokens: 32,
};

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("OpenAI-compatible adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps chat completion SSE, usage, request settings, and cancellation", async () => {
    const controller = new AbortController();
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      receivedUrl = String(input);
      receivedInit = init;
      return new Response(
        [
          'data: {"model":"gpt-test","choices":[{"delta":{"content":"Hi"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const context: AdapterContext = {
      signal: controller.signal,
      resolveSecret: (reference) => (reference === "env:TEST_OPENAI_KEY" ? "secret" : undefined),
    };

    const events = await collect(createOpenAICompatibleAdapter().run(request, context));

    expect(events).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
      { type: "finish", reason: "stop", model: "gpt-test" },
    ]);
    expect(receivedUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(receivedInit?.signal).toBe(controller.signal);
    expect(new Headers(receivedInit?.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(receivedInit?.body))).toMatchObject({
      model: "gpt-test",
      stream: true,
      max_tokens: 32,
      stream_options: { include_usage: true },
    });
  });

  it("normalizes non-success responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response('{"error":{"message":"bad key"}}', {
          status: 401,
          headers: { "x-request-id": "req_1" },
        }),
      ),
    );
    const context: AdapterContext = {
      signal: new AbortController().signal,
      resolveSecret: () => "secret",
    };

    await expect(collect(createOpenAICompatibleAdapter().run(request, context))).rejects.toThrow(
      "bad key",
    );

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(collect(createOpenAICompatibleAdapter().run(request, context))).rejects.toMatchObject({
      adapterId: "openai",
      code: "network_error",
      retryable: true,
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n',
    )));
    await expect(collect(createOpenAICompatibleAdapter().run(request, context))).rejects.toMatchObject({
      adapterId: "openai",
      code: "invalid_stream",
    });
  });
});
