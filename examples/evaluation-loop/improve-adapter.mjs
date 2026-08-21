/** @type {import('@harnest/core').ModelAdapter} */
const adapter = {
  id: "improver",
  capabilities: { streaming: true, json: false, cancellation: true },
  async *run(request, context) {
    context.signal.throwIfAborted();
    const input = String(request.messages.at(-1)?.content ?? "");
    const text = input.includes("[REVISED]")
      ? "[PASS] The answer now meets the evaluation criterion."
      : `[REVISED] ${input}`;
    yield { type: "text-delta", text };
    yield { type: "usage", usage: { inputTokens: input.length, outputTokens: text.length } };
    yield { type: "finish", reason: "stop" };
  },
};

export default adapter;
