import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FilePlaygroundStore } from "../../../lib/playground-store";
import { DELETE, GET, POST } from "./files/route";

const roots: string[] = [];
const previousFile = process.env.HARNEST_FILE;

afterEach(async () => {
  if (previousFile === undefined) delete process.env.HARNEST_FILE;
  else process.env.HARNEST_FILE = previousFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const requestHeaders = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" };

describe("Playground file API", () => {
  it("requires a bounded body, uploads one file, serves ranges, and removes it", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-playground-route-"));
    roots.push(project);
    process.env.HARNEST_FILE = join(project, "harnest.yaml");
    await writeFile(process.env.HARNEST_FILE, "version: '0.1'\ncomponents: []\nconnections: []\nentrypoint: model\n");
    const session = await new FilePlaygroundStore(project).create();
    const form = () => {
      const value = new FormData();
      value.set("sessionId", session.id);
      value.set("file", new File(["hello playground"], "note.txt", { type: "text/plain" }));
      return value;
    };

    const unbounded = await POST(new Request("http://127.0.0.1:3000/api/playground/files", {
      method: "POST", headers: requestHeaders, body: form(),
    }));
    expect(unbounded.status).toBe(411);

    const uploaded = await POST(new Request("http://127.0.0.1:3000/api/playground/files", {
      method: "POST", headers: { ...requestHeaders, "content-length": "1024" }, body: form(),
    }));
    expect(uploaded.status).toBe(201);
    const payload = await uploaded.json() as { file: { id: string; name: string } };
    expect(payload.file.name).toBe("note.txt");

    const content = await GET(new Request(
      `http://127.0.0.1:3000/api/playground/files?sessionId=${session.id}&fileId=${payload.file.id}`,
      { headers: { range: "bytes=0-4" } },
    ));
    expect(content.status).toBe(206);
    expect(await content.text()).toBe("hello");
    expect(content.headers.get("content-security-policy")).toContain("sandbox");

    const removed = await DELETE(new Request("http://127.0.0.1:3000/api/playground/files", {
      method: "DELETE",
      headers: { ...requestHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, fileId: payload.file.id }),
    }));
    expect(removed.status).toBe(204);
  });
});
