/** @type {import('@harnest/core').ModelAdapter} */
const adapter = {
  id: "mcp-agent-echo",
  capabilities: { streaming: true, json: false, cancellation: true },
  async *run(request, context) {
    context.signal.throwIfAborted();
    const text = String(request.messages.at(-1)?.content ?? "");
    const answer = `Tool-grounded answer: ${text}`;
    yield { type: "text-delta", text: answer };
    yield {
      type: "usage",
      usage: { inputTokens: text.length, outputTokens: answer.length, totalTokens: text.length + answer.length },
    };
    yield { type: "finish", reason: "stop" };
  },
};

export default adapter;
