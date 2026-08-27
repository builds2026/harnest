import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { StudioConnectionService } from "./connections-server";

describe("StudioConnectionService", () => {
  it("treats deletion of an already absent Connection as success", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-connections-"));
    try {
      await expect(new StudioConnectionService(project).delete("connection_missing")).resolves.toBeUndefined();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("stores MCP HTTP none as genuinely unauthenticated and clears a previous token", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-connections-auth-"));
    try {
      const service = new StudioConnectionService(project);
      const created = await service.create({
        id: "mcp_fixture", name: "MCP fixture", kind: "mcp-http", scope: "project",
        config: { url: "https://mcp.example.com", oauth: false, authentication: "token" },
        secrets: { token: "fixture-token" },
      });
      expect(created.config.authentication).toBe("token");
      expect(created.credentialPresence.token).toBe(true);

      const updated = await service.update({
        id: created.id, name: created.name, kind: "mcp-http", scope: "project",
        config: { url: "https://mcp.example.com", oauth: false, authentication: "none" },
      });
      expect(updated.config.authentication).toBe("none");
      expect(updated.credentialPresence.token).toBeUndefined();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
