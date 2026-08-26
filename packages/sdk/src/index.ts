import {
  CreateRunResponseSchema,
  CreateRunRequestSchema,
  IdempotencyKeySchema,
  InteractionResponseSchema,
  RunCommandSchema,
  RunEventSchema,
  SnapshotResponseSchema,
  WireEnvelopeSchema,
  toWireEvent,
  type CreateRunResponse,
  type CreateRunContext,
  type InteractionResponse,
  type RunCommand,
  type RunEvent,
  type SnapshotResponse,
  type WireEnvelope,
} from "@harnestai/protocol";

export type {
  CreateRunResponse,
  CreateRunContext,
  CreateRunRequest,
  ExternalAttachment,
  IdempotencyKey,
  InteractionRequest,
  InteractionResolved,
  InteractionResponse,
  Permission,
  RunCommand,
  RunEvent,
  SnapshotResponse,
  WireEnvelope,
} from "@harnestai/protocol";

export interface SSEMessage {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<SSEMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let first = true;

  const consume = (line: string): SSEMessage | undefined => {
    if (first) {
      first = false;
      if (line.startsWith("\uFEFF")) line = line.slice(1);
    }
    if (!line) {
      if (!data.length) { event = undefined; return undefined; }
      const message: SSEMessage = {
        data: data.join("\n"),
        ...(id === undefined ? {} : { id }),
        ...(event === undefined ? {} : { event }),
      };
      data = [];
      event = undefined;
      return message;
    }
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    return undefined;
  };

  try {
    while (true) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      let match: RegExpExecArray | null;
      const lines = /^(.*?)(?:\r\n|\r|\n)/u;
      while ((match = lines.exec(buffer))) {
        if (!next.done && match[0].endsWith("\r") && match[0].length === buffer.length) break;
        buffer = buffer.slice(match[0].length);
        const message = consume(match[1] ?? "");
        if (message) yield message;
      }
      if (next.done) break;
    }
    if (buffer) {
      const message = consume(buffer);
      if (message) yield message;
    }
    const final = consume("");
    if (final) yield final;
  } finally {
    reader.releaseLock();
  }
}

export interface HarnestClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof globalThis.fetch;
}

export interface CreateRunOptions {
  readonly resumeRunId?: string;
  readonly context?: CreateRunContext;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface EventOptions {
  readonly after?: number;
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
}

export class HarnestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(message: string, status = 0, code?: string, details?: unknown) {
    super(message);
    this.name = "HarnestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class HarnestClient {
  readonly #baseUrl: URL;
  readonly #headers: Headers;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HarnestClientOptions | string) {
    const resolved = typeof options === "string" ? { baseUrl: options } : options;
    this.#baseUrl = new URL(`${resolved.baseUrl.replace(/\/+$/u, "")}/`);
    this.#headers = new Headers(resolved.headers);
    if (resolved.token) this.#headers.set("authorization", `Bearer ${resolved.token}`);
    this.#fetch = resolved.fetch ?? globalThis.fetch;
    if (!this.#fetch) throw new Error("A Fetch API implementation is required");
  }

  async create(input: unknown, options: CreateRunOptions = {}): Promise<CreateRunResponse> {
    const body = CreateRunRequestSchema.parse({
      input,
      ...(options.resumeRunId ? { resumeRunId: options.resumeRunId } : {}),
      ...(options.context ? { context: options.context } : {}),
    });
    const value = await this.#json("v1/runs", {
      method: "POST",
      body: JSON.stringify(body),
      ...(options.idempotencyKey === undefined
        ? {} : { headers: { "idempotency-key": IdempotencyKeySchema.parse(options.idempotencyKey) } }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return CreateRunResponseSchema.parse({
      runId: record.runId,
      ...(typeof record.events === "string" ? { events: record.events } : {}),
      ...(typeof record.snapshot === "string" ? { snapshot: record.snapshot } : {}),
    });
  }

  async *events(runId: string, options: EventOptions = {}): AsyncIterable<WireEnvelope> {
    const url = this.#url(`v1/runs/${encodeURIComponent(runId)}/events`);
    if (options.after !== undefined) url.searchParams.set("after", String(options.after));
    const headers = this.#requestHeaders({ accept: "text/event-stream" });
    const lastEventId = options.lastEventId ?? (options.after === undefined ? undefined : String(options.after));
    if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
    const response = await this.#fetch(url, { headers, ...(options.signal ? { signal: options.signal } : {}) });
    if (!response.ok) throw await this.#error(response);
    if (!response.body) throw new HarnestError("Event response has no body", response.status);
    for await (const message of parseSSE(response.body)) {
      let value: unknown;
      try { value = JSON.parse(message.data) as unknown; }
      catch (cause) { throw new HarnestError("Event data is not valid JSON", response.status, "INVALID_EVENT", cause); }
      const envelope = WireEnvelopeSchema.safeParse(value);
      if (envelope.success) { yield envelope.data; continue; }
      const raw = RunEventSchema.parse(value);
      const sequence = raw.sequence ?? Number(message.id);
      if (!Number.isInteger(sequence) || sequence < 0) {
        throw new HarnestError("Event is missing a non-negative sequence", response.status, "INVALID_EVENT");
      }
      yield toWireEvent({ ...raw, runId, sequence, ...(message.id ? { eventId: message.id } : {}) });
    }
  }

  async snapshot(runId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const value = await this.#json(`v1/runs/${encodeURIComponent(runId)}/snapshot`, signal ? { signal } : {});
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return SnapshotResponseSchema.shape.snapshot.parse(record.snapshot);
  }

  async snapshotState(runId: string, signal?: AbortSignal): Promise<SnapshotResponse> {
    const value = await this.#json(`v1/runs/${encodeURIComponent(runId)}/snapshot`, signal ? { signal } : {});
    return SnapshotResponseSchema.parse(value);
  }

  async command(runId: string, command: RunCommand, signal?: AbortSignal): Promise<void> {
    await this.#json(`v1/runs/${encodeURIComponent(runId)}/commands`, {
      method: "POST", body: JSON.stringify(RunCommandSchema.parse(command)), ...(signal ? { signal } : {}),
    });
  }

  async respond(runId: string, response: InteractionResponse, signal?: AbortSignal): Promise<void> {
    await this.command(runId, { type: "interaction.response", response: InteractionResponseSchema.parse(response) }, signal);
  }

  async cancel(runId: string, signal?: AbortSignal): Promise<void> {
    await this.#json(`v1/runs/${encodeURIComponent(runId)}`, { method: "DELETE", ...(signal ? { signal } : {}) });
  }

  async wait(runId: string, options: EventOptions = {}): Promise<RunEvent> {
    for await (const envelope of this.events(runId, options)) {
      const data = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : {};
      if (envelope.type === "run.failed" || envelope.type === "run.cancelled") {
        throw new HarnestError(
          typeof data.message === "string" ? data.message : envelope.type === "run.cancelled" ? "Run cancelled" : "Run failed",
          0,
          typeof data.code === "string" ? data.code : envelope.type === "run.cancelled" ? "RUN_CANCELLED" : undefined,
          data,
        );
      }
      if (envelope.type === "run.completed") return RunEventSchema.parse(data);
    }
    throw new HarnestError("Event stream ended before the run completed", 0, "RUN_INCOMPLETE");
  }

  #url(path: string): URL {
    return new URL(path, this.#baseUrl);
  }

  #requestHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(this.#headers);
    for (const [key, value] of new Headers(extra)) headers.set(key, value);
    return headers;
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = this.#requestHeaders(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(this.#url(path), { ...init, headers });
    if (!response.ok) throw await this.#error(response);
    if (response.status === 204) return { ok: true };
    const text = await response.text();
    return text ? JSON.parse(text) as unknown : { ok: true };
  }

  async #error(response: Response): Promise<HarnestError> {
    let details: unknown;
    try { details = await response.json(); } catch { details = undefined; }
    const record = details && typeof details === "object" ? details as Record<string, unknown> : {};
    const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
    const message = typeof record.error === "string" ? record.error
      : typeof nested.message === "string" ? nested.message
      : typeof record.message === "string" ? record.message
      : `${response.status} ${response.statusText}`;
    const code = typeof nested.code === "string" ? nested.code : typeof record.code === "string" ? record.code : undefined;
    return new HarnestError(message, response.status, code, details);
  }
}

export default HarnestClient;
