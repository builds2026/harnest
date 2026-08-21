export interface SseEvent {
  event?: string;
  data: string;
}

async function* decodedChunks(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      yield decoder.decode(result.value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function takeLine(buffer: string, eof = false): { line: string; rest: string } | undefined {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character === "\n") return { line: buffer.slice(0, index), rest: buffer.slice(index + 1) };
    if (character === "\r") {
      if (index + 1 === buffer.length && !eof) return undefined;
      const length = buffer[index + 1] === "\n" ? 2 : 1;
      return { line: buffer.slice(0, index), rest: buffer.slice(index + length) };
    }
  }
  return eof && buffer.length > 0 ? { line: buffer, rest: "" } : undefined;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const consume = (line: string): SseEvent | undefined => {
    if (line === "") {
      if (data.length === 0) {
        event = undefined;
        return undefined;
      }
      const result: SseEvent = { data: data.join("\n"), ...(event === undefined ? {} : { event }) };
      event = undefined;
      data = [];
      return result;
    }
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
    return undefined;
  };

  for await (const chunk of decodedChunks(body)) {
    buffer += chunk;
    while (true) {
      const next = takeLine(buffer);
      if (!next) break;
      buffer = next.rest;
      const parsed = consume(next.line);
      if (parsed) yield parsed;
    }
  }
  const finalLine = takeLine(buffer, true);
  if (finalLine) {
    const parsed = consume(finalLine.line);
    if (parsed) yield parsed;
  }
}

export async function* parseNdjson<T = unknown>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  let buffer = "";
  let lineNumber = 0;

  const parseLine = (line: string): T | undefined => {
    lineNumber += 1;
    const value = line.trim();
    if (!value) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      throw new SyntaxError(`Invalid NDJSON on line ${lineNumber}`, { cause: error });
    }
  };

  for await (const chunk of decodedChunks(body)) {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const parsed = parseLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
      if (parsed !== undefined) yield parsed;
    }
  }
  if (buffer.length > 0) {
    const parsed = parseLine(buffer.replace(/\r$/, ""));
    if (parsed !== undefined) yield parsed;
  }
}
