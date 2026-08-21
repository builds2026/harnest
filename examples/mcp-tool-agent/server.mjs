import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(() => {
  const server = new McpServer({ name: "harnest-example", version: "1.0.0" });
  server.registerTool(
    "lookup-city",
    {
      description: "Return the country for a known city",
      inputSchema: z.object({ city: z.string().min(1) }),
      outputSchema: z.object({ city: z.string(), country: z.string() }),
    },
    async ({ city }) => {
      const countries = { Seoul: "South Korea", Tokyo: "Japan", Paris: "France" };
      const country = countries[city] ?? "Unknown";
      const result = { city, country };
      return {
        content: [{ type: "text", text: `${city}: ${country}` }],
        structuredContent: result,
      };
    },
  );
  server.registerTool(
    "fail-city",
    {
      description: "Return a deliberate tool-level error for integration tests",
      inputSchema: z.object({}),
    },
    async () => ({
      isError: true,
      content: [{ type: "text", text: "deliberate fixture failure" }],
    }),
  );
  return server;
});
