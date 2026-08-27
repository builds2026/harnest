import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST } from "./route";

describe("Studio experiments API", () => {
  it("rejects a comparison with fewer than two variants", async () => {
    const response = await POST(new Request("http://127.0.0.1:3000/api/experiments", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spec: { version: "0.2", components: [{ id: "output", type: "output", config: {} }], connections: [], entrypoint: "output" },
        input: "hello",
        variants: [{ id: "a", label: "A", componentId: "model", config: {} }],
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "EXPERIMENT_INPUT_INVALID" },
    });
  });

  it("carries the requested subgraph identity into every variant", async () => {
    const response = await POST(new Request("http://127.0.0.1:3000/api/experiments", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spec: { version: "0.2", components: [{ id: "output", type: "output", config: {} }], connections: [], entrypoint: "output" },
        input: "hello",
        variants: [
          { id: "a", label: "A", graph: "missing", componentId: "output", config: {} },
          { id: "b", label: "B", graph: "missing", componentId: "output", config: {} },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      results: [
        { id: "a", ok: false, error: "Graph 'missing' does not exist" },
        { id: "b", ok: false, error: "Graph 'missing' does not exist" },
      ],
    });
  });
});
