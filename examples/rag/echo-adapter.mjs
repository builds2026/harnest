/** @type {import('@harnestai/core').ModelAdapter} */
const adapter = {
  id: "rag-echo",
  capabilities: { streaming: true, json: false, cancellation: true },
  async *run(request, context) {
    context.signal.throwIfAborted();
    const text = request.messages.map(({ content }) => typeof content === "string" ? content : content
      .filter(({ type }) => type === "text").map(({ text }) => text).join("\n")).join("\n\n");
    yield { type: "text-delta", text };
    yield {
      type: "usage",
      usage: { inputTokens: text.length, outputTokens: text.length, totalTokens: text.length * 2 },
    };
    yield { type: "finish", reason: "stop" };
  },
};

export default adapter;
