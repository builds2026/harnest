/** @type {import('@harnestai/core').ModelAdapter} */
const adapter = {
  id: "runtime-e2e",
  capabilities: {
    streaming: true,
    json: false,
    cancellation: true,
    inputMedia: ["image"],
  },
  async *run(request, context) {
    context.signal.throwIfAborted();
    const parts = request.messages.flatMap(({ content }) => Array.isArray(content)
      ? content
      : [{ type: "text", text: String(content ?? "") }]);
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const media = parts.filter((part) => part.type === "media");
    const answer = [
      "runtime-ok",
      `tool=${text.includes("South Korea") ? "South Korea" : "missing"}`,
      `media=${media.length}${media.length ? `:${media.map((part) => part.mimeType).join(",")}` : ""}`,
    ].join(" ");
    yield { type: "text-delta", text: answer };
    yield {
      type: "usage",
      usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: Math.ceil(answer.length / 4), totalTokens: Math.ceil((text.length + answer.length) / 4) },
    };
    yield { type: "finish", reason: "stop" };
  },
};

export default adapter;
