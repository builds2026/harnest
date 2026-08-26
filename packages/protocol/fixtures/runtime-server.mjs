import { Buffer } from "node:buffer";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 48765);
const runId = "run-release-fixture";
const timestamp = "2026-08-25T00:00:00.000Z";
let resolved = false;
let cancelled = false;
let commands = [];
let cursors = [];

const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

const envelope = (sequence, type, data) => ({
  protocolVersion: "1.0",
  eventId: `event-${sequence}`,
  runId,
  sequence,
  time: timestamp,
  type,
  data,
});

const requested = envelope(1, "interaction.requested", {
  id: "approval-1",
  runId,
  nodeId: "agent",
  kind: "permission",
  requester: { kind: "tool", id: "builtin.shell" },
  title: "Allow shell?",
  message: "Allow this command?",
  blocking: "run",
  data: { previewLimited: false, resourceResolved: true },
  checkpoint: { revision: 1, sequence: 1, digest: "c29tZS1jaGVja3BvaW50" },
  createdAt: timestamp,
});
const paused = envelope(2, "run.paused", {
  type: "run-paused", runId, timestamp, sequence: 2, paused: true,
});
const interactionResolved = envelope(3, "interaction.resolved", {
  interactionId: "approval-1", action: "submit", permission: "allow_once",
});
const completed = envelope(4, "run.completed", {
  type: "run-end", runId, timestamp, sequence: 4, output: "release fixture complete",
  state: {}, usage: {}, costUsd: 0, iterations: 1, durationMs: 1, finishReason: "stop", artifacts: [],
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "POST" && url.pathname === "/reset") {
    resolved = false; cancelled = false; commands = []; cursors = [];
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/state") {
    json(response, 200, { resolved, cancelled, commands, cursors });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/runs") {
    await body(request);
    json(response, 202, { runId, events: `/v1/runs/${runId}/events`, snapshot: `/v1/runs/${runId}/snapshot` });
    return;
  }
  if (request.method === "GET" && url.pathname === `/v1/runs/${runId}/events`) {
    const after = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
    cursors.push({ after, lastEventId: request.headers["last-event-id"] ?? null });
    const events = (resolved ? [interactionResolved, completed] : [requested, paused]).filter((event) => event.sequence > after);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(": connected\n\n");
    for (const event of events) response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === `/v1/runs/${runId}/snapshot`) {
    json(response, 200, { snapshot: { runId, status: resolved ? "succeeded" : "paused" }, active: !resolved });
    return;
  }
  if (request.method === "POST" && url.pathname === `/v1/runs/${runId}/commands`) {
    commands.push(await body(request));
    resolved = true;
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "DELETE" && url.pathname === `/v1/runs/${runId}`) {
    cancelled = true;
    json(response, 200, { ok: true });
    return;
  }
  json(response, 404, { error: "not found" });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
console.log(`release fixture ready on ${port}`);
await new Promise((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await new Promise((resolve) => server.close(resolve));
