import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "harnest-http-example", version: "1.0.0" });
  server.registerTool(
    "lookup-city",
    {
      description: "Return the country for a known city",
      inputSchema: z.object({ city: z.string().min(1) }),
      outputSchema: z.object({ city: z.string(), country: z.string() }),
    },
    async ({ city }) => {
      const country = city === "Seoul" ? "South Korea" : "Unknown";
      const result = { city, country };
      return {
        content: [{ type: "text", text: `${city}: ${country}` }],
        structuredContent: result,
      };
    },
  );
  return server;
}, { responseMode: "json" });

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const method = incoming.method ?? "GET";
    const request = new Request(
      new URL(incoming.url ?? "/mcp", `http://${incoming.headers.host ?? "127.0.0.1"}`),
      {
        method,
        headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]),
        ...(["GET", "HEAD"].includes(method)
          ? {}
          : { body: Buffer.concat(chunks), duplex: "half" }),
      },
    );
    const response = await handler.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) outgoing.write(Buffer.from(chunk));
    }
    outgoing.end();
  } catch (error) {
    outgoing.statusCode = 500;
    outgoing.end(error instanceof Error ? error.message : "HTTP fixture failed");
  }
});

const requestedPort = Number(process.env.PORT ?? "0");
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error("PORT must be an integer from 0 to 65535");
}
server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") process.stdout.write(`PORT ${address.port}\n`);
});

const close = () => server.close(() => void handler.close().finally(() => process.exit(0)));
process.once("SIGINT", close);
process.once("SIGTERM", close);
