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

  it("normalizes streamed Tool calls and encodes Tool results", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"sum","arguments":"{\\"a\\":"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"2}"}}]},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
    }));
    const events = await collect(createOpenAICompatibleAdapter().run({
      ...request,
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "previous", name: "sum", input: { a: 1 } }] },
        { role: "tool", content: "1", toolCallId: "previous", name: "sum" },
      ],
      tools: [{ name: "sum", description: "Add", inputSchema: { type: "object" } }],
    }, { signal: new AbortController().signal, resolveSecret: () => "secret" }));

    expect(events).toEqual([
      { type: "tool-call", call: { id: "call_1", name: "sum", input: { a: 2 } } },
      { type: "finish", reason: "tool", model: "gpt-test" },
    ]);
    expect(body).toMatchObject({
      tools: [{ type: "function", function: { name: "sum", parameters: { type: "object" } } }],
      messages: [
        { role: "assistant", tool_calls: [{ id: "previous", function: { name: "sum", arguments: '{"a":1}' } }] },
        { role: "tool", tool_call_id: "previous", content: "1" },
      ],
    });
  });

  it("rejects a Provider response that buffers too many Tool calls", async () => {
    const calls = Array.from({ length: 129 }, (_, index) => ({
      index,
      id: `call_${index}`,
      function: { name: "sum", arguments: "{}" },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls } }] })}\n\n`,
    )));

    await expect(collect(createOpenAICompatibleAdapter().run(request, {
      signal: new AbortController().signal,
      resolveSecret: () => "secret",
    }))).rejects.toMatchObject({
      adapterId: "openai",
      code: "provider_response_limit",
    });
  });
});
