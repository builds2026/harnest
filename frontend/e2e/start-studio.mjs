import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeMode = process.argv[2] === "runtime";
const port = runtimeMode
  ? process.env.HARNEST_RUNTIME_E2E_PORT ?? "3200"
  : process.env.HARNEST_E2E_PORT ?? "3100";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const trackedConfiguration = [resolve(project, "frontend/next-env.d.ts"), resolve(project, "frontend/tsconfig.json")];
const originalConfiguration = new Map(await Promise.all(trackedConfiguration.map(async (path) => [path, await readFile(path, "utf8")])));

let mcp;
if (runtimeMode) {
  mcp = spawn(process.execPath, [resolve(project, "examples/mcp-tool-agent/http-server.mjs")], {
    cwd: project,
    env: { ...process.env, PORT: "3299" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolveStarted, reject) => {
    let output = "";
    mcp.once("error", reject);
    mcp.once("exit", (code) => reject(new Error(`Runtime E2E MCP server exited with ${code}`)));
    mcp.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      output += text;
      if (/PORT 3299\b/u.test(output)) resolveStarted();
    });
  });
}

const child = spawn(npm, [
  "run", "harnest", "--", "studio",
  runtimeMode ? "examples/runtime-e2e/harnest.yaml" : "harnest.yaml",
  "--port", port,
  ...(runtimeMode ? ["--allow-modules", "--allow-network", "127.0.0.1:3299"] : []),
], {
  cwd: project,
  env: { ...process.env, HARNEST_STUDIO_DIST_DIR: runtimeMode ? ".next-runtime-e2e" : ".next-studio-e2e" },
  stdio: ["inherit", "pipe", "inherit"],
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));

// Next rewrites these generated TypeScript references for a custom distDir.
// Capture that exact state, then restore only if nobody edits it while the test runs.
let generatedConfiguration;
let captureBusy = false;
const capture = globalThis.setInterval(() => {
  if (captureBusy || generatedConfiguration) return;
  captureBusy = true;
  void Promise.all(trackedConfiguration.map(async (path) => [path, await readFile(path, "utf8")]))
    .then((entries) => {
      const candidate = new Map(entries);
      if (trackedConfiguration.every((path) => candidate.get(path) !== originalConfiguration.get(path))) {
        generatedConfiguration = candidate;
        globalThis.clearInterval(capture);
      }
    })
    .finally(() => { captureBusy = false; });
}, 100);

const restoreConfiguration = () => {
  globalThis.clearInterval(capture);
  if (!generatedConfiguration) return;
  for (const path of trackedConfiguration) {
    const current = readFileSync(path, "utf8");
    const original = originalConfiguration.get(path);
    if (original !== undefined && current === generatedConfiguration.get(path)) writeFileSync(path, original, "utf8");
  }
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { child.kill(signal); mcp?.kill(signal); });
}
process.on("exit", restoreConfiguration);
child.on("error", (error) => { throw error; });
child.on("exit", (code, signal) => {
  mcp?.kill("SIGTERM");
  restoreConfiguration();
  process.exit(code ?? (signal ? 1 : 0));
});
