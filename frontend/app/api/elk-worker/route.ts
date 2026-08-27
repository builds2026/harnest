import { readFile } from "node:fs/promises";
import { join } from "node:path";

const workerFile = "elkjs/lib/elk-worker.min.js";
const script = Promise.any([
  join(process.cwd(), "node_modules", workerFile),
  join(process.cwd(), "..", "node_modules", workerFile),
  join(process.cwd(), "node_modules", "@harnestai", "studio", "node_modules", workerFile),
].map((path) => readFile(/* turbopackIgnore: true */ path, "utf8")));

export async function GET(): Promise<Response> {
  return new Response(await script, {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "text/javascript; charset=utf-8",
    },
  });
}
