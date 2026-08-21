export interface SseEvent {
  event?: string;
  data: string;
}

export interface StreamParserLimits {
  readonly maxTotalBytes?: number;
  readonly maxLineBytes?: number;
  readonly maxEventBytes?: number;
}

const DEFAULT_MAX_TOTAL_BYTES = 16 * 1_048_576;
const DEFAULT_MAX_LINE_BYTES = 8 * 1_048_576;
const DEFAULT_MAX_EVENT_BYTES = 8 * 1_048_576;
const DEFAULT_MAX_ERROR_BODY_BYTES = 65_536;

function boundedLimit(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return selected;
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

async function* decodedChunks(
  body: ReadableStream<Uint8Array>,
  maximum: number,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let completed = false;
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      total += result.value.byteLength;
      if (total > maximum) throw new RangeError(`Provider stream exceeds the ${maximum}-byte total limit`);
      const decoded = decoder.decode(result.value, { stream: true });
      if (decoded) yield decoded;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface DecodedLine {
  readonly value: string;
  readonly bytes: number;
}

async function* decodedLines(
  body: ReadableStream<Uint8Array>,
  limits: StreamParserLimits,
): AsyncIterable<DecodedLine> {
  const maximumTotal = boundedLimit(limits.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes");
  const maximumLine = boundedLimit(limits.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
  let parts: string[] = [];
  let lineBytes = 0;
  let swallowLeadingLf = false;

  const append = (value: string): void => {
    if (!value) return;
    lineBytes += utf8Bytes(value);
    if (lineBytes > maximumLine) throw new RangeError(`Provider stream line exceeds the ${maximumLine}-byte limit`);
    parts.push(value);
  };
  const take = (): DecodedLine => {
    const line = { value: parts.join(""), bytes: lineBytes };
    parts = [];
    lineBytes = 0;
    return line;
  };

  for await (let chunk of decodedChunks(body, maximumTotal)) {
    if (swallowLeadingLf) {
      swallowLeadingLf = false;
      if (chunk.startsWith("\n")) chunk = chunk.slice(1);
    }
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];
      if (character !== "\n" && character !== "\r") continue;
      append(chunk.slice(start, index));
      yield take();
      if (character === "\r") {
        if (chunk[index + 1] === "\n") index += 1;
        else if (index + 1 === chunk.length) swallowLeadingLf = true;
      }
      start = index + 1;
    }
    append(chunk.slice(start));
  }
  if (parts.length > 0) yield take();
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = DEFAULT_MAX_ERROR_BODY_BYTES,
): Promise<string> {
  const maximum = boundedLimit(maxBytes, DEFAULT_MAX_ERROR_BODY_BYTES, "maxBytes");
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new RangeError(`Response body exceeds the ${maximum}-byte limit`);
  }
  if (!response.body) return "";
  const chunks: string[] = [];
  for await (const chunk of decodedChunks(response.body, maximum)) chunks.push(chunk);
  return chunks.join("");
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  limits: StreamParserLimits = {},
): AsyncIterable<SseEvent> {
  const maximumEvent = boundedLimit(limits.maxEventBytes, DEFAULT_MAX_EVENT_BYTES, "maxEventBytes");
  let event: string | undefined;
  let data: string[] = [];
  let eventBytes = 0;

  for await (const line of decodedLines(body, limits)) {
    if (line.value === "") {
      if (data.length > 0) {
        yield { data: data.join("\n"), ...(event === undefined ? {} : { event }) };
      }
      event = undefined;
      data = [];
      eventBytes = 0;
      continue;
    }
    eventBytes += line.bytes + 1;
    if (eventBytes > maximumEvent) throw new RangeError(`SSE event exceeds the ${maximumEvent}-byte limit`);
    if (line.value.startsWith(":")) continue;
    const separator = line.value.indexOf(":");
    const field = separator < 0 ? line.value : line.value.slice(0, separator);
    const value = separator < 0 ? "" : line.value.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
}

export async function* parseNdjson<T = unknown>(
  body: ReadableStream<Uint8Array>,
  limits: StreamParserLimits = {},
): AsyncIterable<T> {
  let lineNumber = 0;
  for await (const line of decodedLines(body, limits)) {
    lineNumber += 1;
    const value = line.value.trim();
    if (!value) continue;
    try {
      yield JSON.parse(value) as T;
    } catch (error) {
      throw new SyntaxError(`Invalid NDJSON on line ${lineNumber}`, { cause: error });
    }
  }
}
