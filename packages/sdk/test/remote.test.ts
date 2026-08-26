import { describe, expect, it } from "vitest";
import { HarnestClient, parseSSE } from "../src/index";

const stream = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
});

describe("remote Harnest SDK", () => {
  it("parses chunked SSE fields, comments, CRLF, and multiline data", async () => {
    const messages = [];
    for await (const message of parseSSE(stream(
      ": keepalive\r", "\nid: 7\r\nev",
      "ent: event\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n",
    ))) messages.push(message);
    expect(messages).toEqual([{ id: "7", event: "event", data: "{\"a\":\n1}" }]);
  });

  it("uses run routes, resume cursors, commands, responses, and cancellation", async () => {
    const requests: Request[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/v1/runs") && request.method === "POST") {
        return Response.json({ ok: true, runId: "run-1" }, { status: 202 });
      }
      if (request.url.includes("/events")) return new Response(stream(
        "id: 2\nevent: run.completed\ndata: {\"protocolVersion\":\"1.0\",\"eventId\":\"event-2\",\"time\":\"2026-08-25T00:00:00.000Z\",\"type\":\"run.completed\",\"runId\":\"run-1\",\"sequence\":2,\"data\":{\"type\":\"run-end\",\"runId\":\"run-1\",\"timestamp\":\"2026-08-25T00:00:00.000Z\",\"sequence\":2,\"output\":\"done\"}}\n\n",
      ), { headers: { "content-type": "text/event-stream" } });
      if (request.url.endsWith("/snapshot")) return Response.json({ snapshot: { status: "paused" }, active: true });
      return Response.json({ ok: true });
    };
    const client = new HarnestClient({ baseUrl: "https://example.test/api", token: "secret", fetch: fetchMock });
    await expect(client.create("hello", { context: {
      contextRef: "ctx_opaque",
      revisions: { conversation: "r2" },
      attachments: [{
        ref: "file_1", name: "brief.pdf", mimeType: "application/pdf", size: 4, sha256: "a".repeat(64),
      }],
    }, idempotencyKey: "retry/client:request-1" })).resolves.toEqual({ runId: "run-1" });
    await expect(requests[0]!.json()).resolves.toEqual({
      input: "hello",
      context: {
        contextRef: "ctx_opaque",
        revisions: { conversation: "r2" },
        attachments: [{
          ref: "file_1", name: "brief.pdf", mimeType: "application/pdf", size: 4, sha256: "a".repeat(64),
        }],
      },
    });
    await expect(client.wait("run-1", { after: 1 })).resolves.toMatchObject({ type: "run-end", output: "done" });
    await expect(client.snapshotState("run-1")).resolves.toEqual({ snapshot: { status: "paused" }, active: true });
    await client.command("run-1", { type: "message", target: { kind: "run" }, content: "continue" });
    await client.respond("run-1", {
      interactionId: "approval-1", checkpointDigest: "c29tZS1jaGVja3BvaW50", action: "submit", permission: "allow_once",
    });
    await client.cancel("run-1");
    expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["POST", "/api/v1/runs"],
      ["GET", "/api/v1/runs/run-1/events"],
      ["GET", "/api/v1/runs/run-1/snapshot"],
      ["POST", "/api/v1/runs/run-1/commands"],
      ["POST", "/api/v1/runs/run-1/commands"],
      ["DELETE", "/api/v1/runs/run-1"],
    ]);
    expect(requests[1]?.headers.get("last-event-id")).toBe("1");
    expect(requests[0]?.headers.get("idempotency-key")).toBe("retry/client:request-1");
    expect(new URL(requests[1]!.url).searchParams.get("after")).toBe("1");
    await expect(client.create("hello", { idempotencyKey: "" })).rejects.toThrow();
  });
});
