/** @type {import('@harnestai/core').ModelAdapter} */
const adapter = {
  id: "echo",
  capabilities: { streaming: true, json: false, cancellation: true },
  async *run(request, context) {
    if (context.signal.aborted) throw context.signal.reason;
    const text = String(request.messages.at(-1)?.content ?? "");
    yield {
      type: "usage",
      usage: { inputTokens: text.length, outputTokens: text.length, totalTokens: text.length * 2 }
    };
    yield { type: "text-delta", text: `Echo: ${text}` };
    yield { type: "finish", reason: "stop" };
  }
};

export default adapter;

