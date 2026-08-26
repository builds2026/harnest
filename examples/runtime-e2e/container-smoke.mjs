import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectionManager,
  NodeRuntimeServices,
  detectContainerEngine,
} from "@harnestai/core/node";

const image = process.env.HARNEST_SMOKE_IMAGE
  ?? "python:3.12-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf";
process.env.HARNEST_CREDENTIAL_KEY ??= randomBytes(32).toString("base64");
const root = await mkdtemp(join(tmpdir(), "harnest-container-smoke-"));
const project = join(root, "project");
const userData = join(root, "user");
const inputDirectory = join(project, ".harnest", "input");
const outputDirectory = join(project, ".harnest", "output");
let services;

try {
  await Promise.all([
    mkdir(inputDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  await chmod(outputDirectory, 0o777);
  const manager = new ConnectionManager(project, { userDataDirectory: userData });
  const connection = await manager.create({
    id: "container-smoke",
    scope: "project",
    kind: "local-runtime",
    name: "Real Docker smoke",
    config: {
      sandbox: "container",
      engine: await detectContainerEngine(),
      image,
      runtime: "python",
      network: "none",
      memoryMb: 128,
      cpus: 0.5,
      pids: 32,
    },
  });
  await manager.approveProcess(connection.id, { pullImage: true });
  await manager.test(connection.id);
  services = new NodeRuntimeServices(project, {
    connectionManager: manager,
    sandboxWorkspace: { inputDirectory, outputDirectory },
  });
  const runId = "container-smoke";
  const result = await services.executeTool({
    id: "builtin.code-runner",
    source: "builtin",
    connectionId: connection.id,
  }, {
    runtime: "python",
    code: "from pathlib import Path\nimport json\nvalue = sum(range(1, 101))\nPath('/mnt/output/result.json').write_text(json.dumps({'sum': value}))\nprint(value)",
  }, {
    signal: AbortSignal.timeout(30_000),
    runId,
    nodeId: "code-runner",
    iteration: 0,
    resolveSecret: () => undefined,
  });
  const artifacts = await services.listArtifacts(runId);
  if (result.value?.stdout !== "5050\n" || artifacts.length !== 1 || artifacts[0]?.name !== "result.json") {
    throw new Error(`Unexpected container result: ${JSON.stringify({ result: result.value, artifacts })}`);
  }
  console.log(JSON.stringify({ ok: true, stdout: result.value.stdout.trim(), artifact: artifacts[0] }));
} finally {
  await services?.close();
  await rm(root, { recursive: true, force: true });
}
