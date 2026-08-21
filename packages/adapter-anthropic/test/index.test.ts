import type { AdapterContext, ModelEvent, ModelRequest } from "@harnest/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAnthropicAdapter } from "../src/index.js";

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Anthropic adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps Messages SSE and top-level system messages", async () => {
    let receivedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedInit = init;
      return new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":4}}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const request: ModelRequest = {
      model: "claude-test",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "Hello" },
      ],
      maxTokens: 64,
    };
    const context: AdapterContext = {
      signal: new AbortController().signal,
      resolveSecret: (reference) => (reference === "env:ANTHROPIC_API_KEY" ? "secret" : undefined),
    };

    const events = await collect(createAnthropicAdapter().run(request, context));

    expect(events).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      { type: "finish", reason: "stop", model: "claude-test" },
    ]);
    expect(new Headers(receivedInit?.headers).get("x-api-key")).toBe("secret");
    expect(JSON.parse(String(receivedInit?.body))).toMatchObject({
      system: "Be concise",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 64,
      stream: true,
    });
  });

  it("normalizes Tool use and encodes Tool results", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":3}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"sum","input":{}}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":2}"}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
        "",
      ].join("\n\n"));
    }));
    const events = await collect(createAnthropicAdapter().run({
      model: "claude-test",
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "old", name: "sum", input: { a: 1 } }] },
        { role: "tool", content: "1", toolCallId: "old", name: "sum" },
      ],
      tools: [{ name: "sum", description: "Add", inputSchema: { type: "object" } }],
    }, { signal: new AbortController().signal, resolveSecret: () => "secret" }));

    expect(events).toEqual([
      { type: "usage", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
      { type: "tool-call", call: { id: "toolu_1", name: "sum", input: { a: 2 } } },
      { type: "finish", reason: "tool", model: "claude-test" },
    ]);
    expect(body).toMatchObject({
      tools: [{ name: "sum", input_schema: { type: "object" } }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "old", name: "sum", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "1" }] },
      ],
    });
  });

  it("rejects oversized streamed Tool arguments", async () => {
    const partial = JSON.stringify({ value: "x".repeat(1_048_576) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_large", name: "sum", input: {} },
      })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partial },
      })}`,
      "",
    ].join("\n\n"))));

    await expect(collect(createAnthropicAdapter().run({
      model: "claude-test",
      messages: [{ role: "user", content: "use a tool" }],
    }, { signal: new AbortController().signal, resolveSecret: () => "secret" }))).rejects.toMatchObject({
      adapterId: "anthropic",
      code: "provider_response_limit",
    });
  });
});
