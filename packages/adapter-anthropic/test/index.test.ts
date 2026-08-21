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
});
