#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AdapterRegistry,
  compileSpec,
  createBuiltinComponentRegistry,
  HarnessRuntime,
  runHarnessTests,
  ToolRegistry,
  validateSpec,
  type Diagnostic,
  type RunEndEvent,
  type TokenUsage,
} from "@harnest/core";
import {
  FileRunStore,
  loadAdapterModules,
  loadRuntimeModules,
  loadSpecFile,
  NodeRuntimeServices,
  type NodeRuntimeServiceOptions,
} from "@harnest/core/node";

const HELP = `Harnest Visual AI Agent Harness

Usage:
  harnest validate <file>
  harnest inspect <file>
  harnest run <file> --input <value> [capabilities]
  harnest test <file> [capabilities]
  harnest runs [file] [--limit <number>]
  harnest trace <run-id> [file] [--json]
  harnest studio [file] [--port <number>]

Runtime capabilities (denied by default):
  --allow-modules               Execute reviewed adapter/component/tool modules
  --allow-files                 Read non-secret Context files inside the project
  --context-root <path>         Restrict Context reads to a project-relative root (repeatable)
  --allow-process <command>     Allow one exact MCP stdio command (repeatable)
  --allow-network <host>        Allow one exact MCP HTTP host[:port] (repeatable)
`;

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const component = diagnostic.componentId ? ` [${diagnostic.componentId}]` : "";
    console.error(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}${component}: ${diagnostic.message}`);
    if (diagnostic.hint) console.error(`  ${diagnostic.hint}`);
  }
}

async function load(file: string, options: {
  checkEnvironment?: boolean;
  loadModules?: boolean;
  allowModules?: boolean;
} = {}) {
  const { checkEnvironment = false, loadModules = true, allowModules = false } = options;
  const absolute = resolve(file);
  const parsed = await loadSpecFile(absolute);
  if (!parsed.ok) {
    printDiagnostics(parsed.diagnostics);
    throw new Error("Spec could not be loaded");
  }

  const adapters = new AdapterRegistry();
  const components = createBuiltinComponentRegistry();
  const tools = new ToolRegistry();
  if (loadModules) {
    const adapterResult = await loadAdapterModules(
      parsed.spec,
      adapters,
      dirname(absolute),
      ...(allowModules ? [{ allowModuleExecution: true as const }] : []),
    );
    const runtimeResult = await loadRuntimeModules(
      parsed.spec,
      { adapters, components, tools },
      dirname(absolute),
      ...(allowModules ? [{ allowModuleExecution: true as const }] : []),
    );
    const diagnostics = [...adapterResult.diagnostics, ...runtimeResult.diagnostics];
    if (diagnostics.length > 0) {
      printDiagnostics(diagnostics);
      throw new Error("Runtime modules could not be loaded");
    }
  }

  const validation = validateSpec(parsed.spec, {
    ...(loadModules ? { registry: adapters, components, tools } : {}),
    ...(checkEnvironment ? { env: process.env } : {}),
  });
  if (!validation.ok) {
    printDiagnostics(validation.diagnostics);
    throw new Error("Spec is invalid");
  }
  printDiagnostics(validation.diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
  return { spec: parsed.spec, adapters, components, tools, absolute };
}

async function validate(file: string, allowModules: boolean): Promise<void> {
  await load(file, { checkEnvironment: true, allowModules });
  console.log(`Valid: ${resolve(file)}`);
}

async function inspect(file: string, allowModules: boolean): Promise<void> {
  const { spec, adapters, components, tools } = await load(file, { allowModules });
  const compiled = compileSpec(spec, { registry: adapters, components, tools });
  if (!compiled.ok) {
    printDiagnostics(compiled.diagnostics);
    throw new Error("Spec could not be compiled");
  }
  console.log(JSON.stringify(compiled.plan, null, 2));
}

function inputValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function usageText(usage: TokenUsage): string {
  return `${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out / ${usage.totalTokens ?? 0} total`;
}

interface CapabilityValues {
  "allow-modules"?: boolean;
  "allow-files"?: boolean;
  "context-root"?: string[];
  "allow-process"?: string[];
  "allow-network"?: string[];
}

const capabilityOptions = {
  "allow-modules": { type: "boolean" as const },
  "allow-files": { type: "boolean" as const },
  "context-root": { type: "string" as const, multiple: true },
  "allow-process": { type: "string" as const, multiple: true },
  "allow-network": { type: "string" as const, multiple: true },
};

function serviceOptions(values: CapabilityValues): NodeRuntimeServiceOptions {
  return {
    ...(values["allow-files"] ? { allowFileSystem: true as const } : {}),
    ...(values["context-root"]?.length ? { allowedContextRoots: values["context-root"] } : {}),
    ...(values["allow-process"]?.length ? { allowProcessCommands: values["allow-process"] } : {}),
    ...(values["allow-network"]?.length ? { allowNetworkHosts: values["allow-network"] } : {}),
  };
}

async function run(file: string, rawInput: string, capabilities: CapabilityValues): Promise<void> {
  const { spec, adapters, components, tools, absolute } = await load(file, {
    checkEnvironment: true,
    allowModules: capabilities["allow-modules"] ?? false,
  });
  const project = dirname(absolute);
  const services = new NodeRuntimeServices(project, serviceOptions(capabilities));
  const store = new FileRunStore(project);
  const runtime = new HarnessRuntime(spec, adapters, {
    env: process.env,
    components,
    tools,
    services,
    eventSink: store,
  });
  let end: RunEndEvent | undefined;
  let streamedText = "";
  try {
    for await (const event of runtime.stream(inputValue(rawInput))) {
      if (event.type === "text-delta") {
        streamedText += event.text;
        process.stdout.write(event.text);
      }
      if (event.type === "run-end") end = event;
    }
  } finally {
    await services.close();
  }

  if (!end) throw new Error("Runtime ended without a result");
  if (streamedText) process.stdout.write("\n");
  const finalOutput = typeof end.output === "string" ? end.output : JSON.stringify(end.output, null, 2);
  if (!streamedText) console.log(finalOutput);
  else if (streamedText !== end.output) console.log(`output ${finalOutput}`);
  console.log(`runId ${end.runId}`);
  console.log(`duration ${Math.round(end.durationMs)}ms`);
  console.log(`iterations ${end.iterations}`);
  console.log(`tokens ${usageText(end.usage)}`);
  console.log(`cost $${end.costUsd.toFixed(6)}`);
}

async function test(file: string, capabilities: CapabilityValues): Promise<void> {
  const { spec, adapters, components, tools, absolute } = await load(file, {
    checkEnvironment: true,
    allowModules: capabilities["allow-modules"] ?? false,
  });
  const project = dirname(absolute);
  const services = new NodeRuntimeServices(project, serviceOptions(capabilities));
  const store = new FileRunStore(project);
  try {
    const report = await runHarnessTests(spec, adapters, {
      env: process.env,
      components,
      tools,
      services,
      eventSink: store,
    });
    for (const testCase of report.cases) {
      console.log(`${testCase.ok ? "PASS" : "FAIL"} ${testCase.id} ${Math.round(testCase.durationMs)}ms`);
      if (testCase.error) console.error(`  ${testCase.error}`);
    }
    console.log(`${report.passed} passed, ${report.failed} failed`);
    if (!report.ok) throw new Error(`${report.failed} harness test(s) failed`);
  } finally {
    await services.close();
  }
}

async function runs(file: string, limit: string): Promise<void> {
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
    throw new Error("runs --limit must be an integer from 1 to 500");
  }
  const store = new FileRunStore(dirname(resolve(file)));
  const summaries = await store.list(parsedLimit);
  if (summaries.length === 0) {
    console.log("No stored runs.");
    return;
  }
  for (const summary of summaries) {
    const duration = summary.durationMs === undefined ? "-" : `${Math.round(summary.durationMs)}ms`;
    console.log(`${summary.runId}\t${summary.status}\t${summary.startedAt}\t${duration}\t${summary.eventCount} events`);
  }
}

async function trace(file: string, runId: string, json: boolean): Promise<void> {
  const events = await new FileRunStore(dirname(resolve(file))).read(runId);
  if (json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  for (const event of events) {
    const node = typeof event.nodeId === "string" ? ` ${event.nodeId}` : "";
    const details = Object.fromEntries(
      Object.entries(event).filter(([key]) => !["timestamp", "type", "runId", "nodeId"].includes(key)),
    );
    const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    console.log(`${event.timestamp} ${event.type}${node}${suffix}`);
  }
}

async function studio(file: string, port: string, capabilities: CapabilityValues): Promise<void> {
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
    throw new Error("studio --port must be an integer from 1 to 65535");
  }
  const studioPackage = createRequire(import.meta.url).resolve("@harnest/studio/package.json");
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(
    command,
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(portNumber)],
    {
      cwd: dirname(studioPackage),
      env: {
        ...process.env,
        HARNEST_FILE: resolve(file),
        ...(capabilities["allow-modules"] ? { HARNEST_ALLOW_MODULES: "1" } : {}),
        ...(capabilities["allow-files"] ? { HARNEST_ALLOW_FILES: "1" } : {}),
        ...(capabilities["context-root"]?.length
          ? { HARNEST_CONTEXT_ROOTS: capabilities["context-root"].join(",") }
          : {}),
        ...(capabilities["allow-process"]?.length
          ? { HARNEST_ALLOW_PROCESS: capabilities["allow-process"].join(",") }
          : {}),
        ...(capabilities["allow-network"]?.length
          ? { HARNEST_ALLOW_NETWORK: capabilities["allow-network"].join(",") }
          : {}),
      },
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal === "SIGINT" || code === 0) resolvePromise();
      else reject(new Error(`Studio exited with code ${code ?? signal}`));
    });
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  if (command === "validate" || command === "inspect") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { "allow-modules": capabilityOptions["allow-modules"] },
    });
    const file = positionals[0];
    if (!file) throw new Error(`${command} requires a file`);
    if (command === "validate") await validate(file, values["allow-modules"] ?? false);
    else await inspect(file, values["allow-modules"] ?? false);
    return;
  }

  if (command === "run" || command === "test") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        ...(command === "run" ? { input: { type: "string" as const, short: "i" } } : {}),
        ...capabilityOptions,
      },
    });
    const file = positionals[0];
    if (!file) throw new Error(`${command} requires a file`);
    if (command === "run") {
      if (values.input === undefined) throw new Error("run requires --input <value>");
      await run(file, values.input as string, values as CapabilityValues);
    } else {
      await test(file, values as CapabilityValues);
    }
    return;
  }

  if (command === "runs") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { limit: { type: "string", short: "n", default: "50" } },
    });
    await runs(positionals[0] ?? "harnest.yaml", values.limit);
    return;
  }

  if (command === "trace") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean" } },
    });
    const runId = positionals[0];
    if (!runId) throw new Error("trace requires <run-id>");
    await trace(positionals[1] ?? "harnest.yaml", runId, values.json ?? false);
    return;
  }

  if (command === "studio") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { port: { type: "string", short: "p", default: "3000" }, ...capabilityOptions },
    });
    await studio(positionals[0] ?? "harnest.yaml", values.port, values as CapabilityValues);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith("Spec ") && !message.startsWith("Runtime module")) {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
});
