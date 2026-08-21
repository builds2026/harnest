/** @type {import('@harnest/core').ModelAdapter} */
const adapter = {
  id: "rag-echo",
  capabilities: { streaming: true, json: false, cancellation: true },
  async *run(request, context) {
    context.signal.throwIfAborted();
    const text = String(request.messages.at(-1)?.content ?? "");
    yield { type: "text-delta", text };
    yield {
      type: "usage",
      usage: { inputTokens: text.length, outputTokens: text.length, totalTokens: text.length * 2 },
    };
    yield { type: "finish", reason: "stop" };
  },
};

export default adapter;
