import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../lib/api-server"));
vi.mock("@/lib/run-registry", async () => import("../../../lib/run-registry"));
vi.mock("@/lib/server", async () => import("../../../lib/server"));

import type { RunEvent } from "@harnestai/core";
import { runRegistry } from "../../../lib/run-registry";
import { POST } from "./route";

const roots: string[] = [];
const originalFile = process.env.HARNEST_FILE;

afterEach(async () => {
  if (originalFile === undefined) delete process.env.HARNEST_FILE;
  else process.env.HARNEST_FILE = originalFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Legacy Run API", () => {
  it("keeps NDJSON while registering the canonical RunHandle", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-legacy-run-"));
    roots.push(project);
    const file = join(project, "harnest.yaml");
    process.env.HARNEST_FILE = file;
    await writeFile(file, `
version: "0.2"
components:
  - { id: prompt, type: prompt, config: { template: "ok" } }
  - { id: output, type: output, config: { format: text } }
connections:
  - { from: { component: prompt, port: prompt }, to: { component: output, port: value } }
entrypoint: output
`, "utf8");

    const response = await POST(new Request("http://127.0.0.1:3000/api/run", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ input: "ignored" }),
    }));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as RunEvent);
    const runId = events.find(({ type }) => type === "run-start")?.runId;

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(events.map(({ type }) => type)).toEqual(expect.arrayContaining(["run-start", "run-end"]));
    expect(events.find(({ type }) => type === "run-end")).toMatchObject({ output: "ok" });
    expect(runId && runRegistry.has(runId)).toBe(true);
  });
});
