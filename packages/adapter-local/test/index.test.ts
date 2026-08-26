import type { AdapterContext, ModelEvent, ModelRequest } from "@harnestai/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOllamaAdapter } from "../src/index.js";

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Ollama adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps image input to Ollama images", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{"model":"vision","message":{"role":"assistant","content":"ok"},"done":true,"done_reason":"stop"}\n');
    }));
    await collect(createOllamaAdapter().run({
      model: "vision",
      messages: [{ role: "user", content: [
        { type: "text", text: "Describe" },
        { type: "media", mimeType: "image/png", data: "aW1hZ2U=" },
      ] }],
    }, { signal: new AbortController().signal, resolveSecret: () => undefined }));
    expect(body).toMatchObject({ messages: [{ content: "Describe", images: ["aW1hZ2U="] }] });
  });

  it("maps native chat NDJSON, usage, options, and cancellation", async () => {
    const controller = new AbortController();
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      receivedUrl = String(input);
      receivedInit = init;
      return new Response(
        [
          '{"model":"llama-test","message":{"role":"assistant","content":"Hi"},"done":false}',
          '{"model":"llama-test","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":5,"eval_count":2}',
          "",
        ].join("\n"),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    });
    const request: ModelRequest = {
      model: "llama-test",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.2,
      maxTokens: 16,
    };
    const context: AdapterContext = {
      signal: controller.signal,
      resolveSecret: () => undefined,
    };

    const events = await collect(createOllamaAdapter().run(request, context));

    expect(events).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { type: "finish", reason: "stop", model: "llama-test" },
    ]);
    expect(receivedUrl).toBe("http://localhost:11434/api/chat");
    expect(receivedInit?.signal).toBe(controller.signal);
    expect(new Headers(receivedInit?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(receivedInit?.body))).toMatchObject({
      model: "llama-test",
      stream: true,
      options: { temperature: 0.2, num_predict: 16 },
    });
  });

  it("normalizes native Tool calls and sends Tool definitions", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        '{"model":"llama-test","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"sum","arguments":{"a":2}}}]},"done":false}',
        '{"model":"llama-test","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}',
        "",
      ].join("\n"));
    }));
    const events = await collect(createOllamaAdapter().run({
      model: "llama-test",
      messages: [{ role: "user", content: "add" }],
      tools: [{ name: "sum", description: "Add", inputSchema: { type: "object" } }],
    }, { signal: new AbortController().signal, resolveSecret: () => undefined }));

    expect(events).toEqual([
      { type: "tool-call", call: { id: "ollama-1-1", name: "sum", input: { a: 2 } } },
      { type: "finish", reason: "stop", model: "llama-test" },
    ]);
    expect(body).toMatchObject({
      tools: [{ type: "function", function: { name: "sum", parameters: { type: "object" } } }],
    });
  });

  it("keeps fallback Tool-call IDs unique across requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${JSON.stringify({
      model: "llama-test",
      message: { tool_calls: [{ function: { name: "sum", arguments: {} } }] },
      done: true,
      done_reason: "stop",
    })}\n`)));
    const adapter = createOllamaAdapter();
    const request: ModelRequest = { model: "llama-test", messages: [{ role: "user", content: "add" }] };
    const context: AdapterContext = { signal: new AbortController().signal, resolveSecret: () => undefined };

    const first = await collect(adapter.run(request, context));
    const second = await collect(adapter.run(request, context));

    expect([first[0], second[0]]).toEqual([
      { type: "tool-call", call: { id: "ollama-1-1", name: "sum", input: {} } },
      { type: "tool-call", call: { id: "ollama-2-1", name: "sum", input: {} } },
    ]);
  });

  it("ignores records after the done marker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      '{"model":"llama-test","message":{"content":"done"},"done":true,"done_reason":"stop"}',
      '{"model":"llama-test","message":{"tool_calls":[{"function":{"name":"late","arguments":{}}}]},"done":false}',
      "",
    ].join("\n"))));

    const events = await collect(createOllamaAdapter().run({
      model: "llama-test",
      messages: [{ role: "user", content: "run" }],
    }, { signal: new AbortController().signal, resolveSecret: () => undefined }));

    expect(events).toEqual([
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", model: "llama-test" },
    ]);
  });

  it("rejects oversized native Tool arguments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${JSON.stringify({
      model: "llama-test",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "sum", arguments: { value: "x".repeat(1_048_576) } } }],
      },
      done: false,
    })}\n`)));

    await expect(collect(createOllamaAdapter().run({
      model: "llama-test",
      messages: [{ role: "user", content: "use a tool" }],
    }, { signal: new AbortController().signal, resolveSecret: () => undefined }))).rejects.toMatchObject({
      adapterId: "ollama",
      code: "provider_response_limit",
    });
  });
});
