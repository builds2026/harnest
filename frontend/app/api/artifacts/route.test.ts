import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRuntimeServices } from "@harnestai/core/node";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../lib/api-server"));
vi.mock("@/lib/server", async () => import("../../../lib/server"));

import { GET } from "./route";

const roots: string[] = [];
const originalFile = process.env.HARNEST_FILE;

afterEach(async () => {
  if (originalFile === undefined) delete process.env.HARNEST_FILE;
  else process.env.HARNEST_FILE = originalFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact download API", () => {
  it("returns a managed artifact with safe preview and download headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-artifact-route-"));
    roots.push(root);
    process.env.HARNEST_FILE = join(root, "harnest.yaml");
    await writeFile(process.env.HARNEST_FILE, "version: '0.2'\ncomponents: []\nconnections: []\nentrypoint: ''\n", "utf8");
    const output = join(root, ".harnest", "artifacts", "run_route_fixture");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "report.txt"), "verified artifact", "utf8");
    const services = new NodeRuntimeServices(dirname(process.env.HARNEST_FILE));
    const artifact = (await services.listArtifacts("run_route_fixture"))[0];
    await services.close();
    expect(artifact).toBeTruthy();

    const response = await GET(new Request(`http://127.0.0.1:3000/api/artifacts?runId=run_route_fixture&artifactId=${artifact!.id}&download=1`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    await expect(response.text()).resolves.toBe("verified artifact");

    const missing = await GET(new Request("http://127.0.0.1:3000/api/artifacts?runId=run_route_fixture&artifactId=artifact_aaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(missing.status).toBe(404);
  });
});
