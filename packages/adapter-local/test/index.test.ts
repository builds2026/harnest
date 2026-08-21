import type { AdapterContext, ModelEvent, ModelRequest } from "@harnest/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOllamaAdapter } from "../src/index.js";

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Ollama adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
