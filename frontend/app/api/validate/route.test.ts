import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST } from "./route";

describe("Studio validation API", () => {
  it("does not report a graph with a missing saved Connection as valid", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-studio-validate-"));
    const previous = process.env.HARNEST_FILE;
    process.env.HARNEST_FILE = join(project, "harnest.yaml");
    try {
      const yaml = `
version: "0.2"
components:
  - { id: model, type: model, config: { connectionId: missing_provider } }
  - { id: prompt, type: prompt, config: { template: "{{input}}" } }
  - { id: agent, type: agent, config: {} }
  - { id: output, type: output, config: {} }
connections:
  - { from: { component: model, port: model }, to: { component: agent, port: model } }
  - { from: { component: prompt, port: prompt }, to: { component: agent, port: prompt } }
  - { from: { component: agent, port: response }, to: { component: output, port: value } }
entrypoint: output
`;
      const response = await POST(new Request("http://127.0.0.1:3000/api/validate", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ yaml }),
      }));
      const payload = await response.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
      expect(response.status).toBe(200);
      expect(payload.ok).toBe(false);
      expect(payload.diagnostics.map(({ code }) => code)).toContain("CONNECTION_NOT_FOUND");
    } finally {
      if (previous === undefined) delete process.env.HARNEST_FILE;
      else process.env.HARNEST_FILE = previous;
      await rm(project, { recursive: true, force: true });
    }
  });
});
