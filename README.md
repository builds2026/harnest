# Harnest

Harnest is an open-source Visual Graph Engineering Platform for AI agent harnesses. Design typed components, branches, parallel joins, reusable subgraphs, bounded loops, tools, and evaluators in the Web Studio, then run the same `harnest.yaml` through the CLI or TypeScript API.

## Quick start

Requirements: Node.js 22 or newer and npm 10 or newer.

```bash
npm install
npm run build
npm test
npm run harnest -- validate harnest.yaml -- --allow-modules
npm run harnest -- run harnest.yaml -- --input "hello" --allow-modules
npm run harnest -- studio harnest.yaml -- --allow-modules
```

The root spec uses a deterministic local Echo Adapter, so it runs without a secret or network connection. Provider credentials use `env:NAME` references; resolved values are never written to trace files.

## Executable v0.2 examples

The repository includes three end-to-end examples:

```bash
# Project-bounded lexical RAG over Markdown files
npm run harnest -- run examples/rag/harnest.yaml -- \
  --input "How are Context paths protected?" \
  --allow-files --context-root knowledge --allow-modules

# Real MCP stdio discovery and tool call, followed by an Agent response
npm run harnest -- run examples/mcp-tool-agent/harnest.yaml -- \
  --input "Which country contains the configured city?" \
  --allow-process node --allow-modules

# Generate → evaluate → improve until /evaluation/passed is true
npm run harnest -- run examples/evaluation-loop/harnest.yaml -- \
  --input "Draft answer" --allow-modules
```

Their declared tests use the same graphs:

```bash
npm run harnest -- test examples/rag/harnest.yaml -- --allow-files --context-root knowledge --allow-modules
npm run harnest -- test examples/mcp-tool-agent/harnest.yaml -- --allow-process node --allow-modules
npm run harnest -- test examples/evaluation-loop/harnest.yaml -- --allow-modules
```

## Capabilities and safety

Runtime capabilities are denied by default. Grant only what a reviewed spec needs:

- `--allow-modules` enables adapter, component, and tool modules after review. Even `validate` and `inspect` refuse to execute a listed module without this flag.
- `--allow-files` enables file or directory Context inside the project. `--context-root <path>` can further restrict it and is repeatable. Hidden metadata, `.harnest`, private-key files, and common credential files remain blocked.
- `--allow-process <command>` allows one exact MCP stdio executable and is repeatable. Child processes receive the MCP SDK's minimal safe environment, not the full parent environment.
- `--allow-network <host[:port]>` allows one exact MCP Streamable HTTP host and is repeatable. Redirects, URL credentials, and non-HTTP schemes are rejected. Header values must be `env:NAME` references.

File paths and executable modules are checked with their canonical real paths, including symlinks and Windows junctions. Adapter and runtime modules must be npm package specifiers or project-relative paths. SDK callers must pass `{ allowModuleExecution: true }`; the CLI does this only after a user has explicitly invoked it on a project. Review third-party Harness projects before validating or running them.

## Runs and traces

CLI runs and tests append privacy-bounded NDJSON events under the spec project's `.harnest/runs/`. Project memory is stored atomically in `.harnest/memory.json`.

```bash
npm run harnest -- runs examples/rag/harnest.yaml
npm run harnest -- trace <run-id> examples/rag/harnest.yaml
npm run harnest -- trace <run-id> examples/rag/harnest.yaml -- --json
```

Trace storage preserves bounded node inputs, outputs, state changes, iterations, tool calls, evaluations, usage, and cost. Secret-shaped keys are redacted and large strings/collections are truncated.

## HarnessSpec v0.2

`0.2` keeps the declarative component/connection model and adds conditions, JSON Pointer selection, state writes, named subgraphs, runtime modules, retry, and budgets. Use the complete, executable [evaluation Loop example](./examples/evaluation-loop/harnest.yaml) as the schema reference instead of a non-runnable fragment.

Built-ins include Model, Prompt, Agent, Output, Context, Memory, Local Tool, MCP Tool, Router, Evaluator, Join, Subgraph, and Loop. Component manifests supply typed ports, JSON Schema configuration, Inspector fields, validation, safe trace projection, and execution.

## Custom adapters, components, and tools

A legacy adapter module can export a default `ModelAdapter`; see [examples/custom-adapter/echo-adapter.mjs](./examples/custom-adapter/echo-adapter.mjs).

One module listed in `runtime.modules` can register any combination without modifying Core:

```ts
import type { RuntimeModuleRegistries } from "@harnest/core/node";

export function register({ components, tools }: RuntimeModuleRegistries) {
  tools.register({
    id: "project.search",
    label: "Project search",
    description: "Search reviewed project data",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async (input, context) => ({ input, runId: context.runId }),
  });

  components.register(myComponentDefinition);
}
```

## Workspace

```text
packages/core               HarnessSpec, registries, compiler, runtime, services, trace SDK
packages/adapter-openai     OpenAI-compatible streaming adapter
packages/adapter-anthropic  Anthropic Messages streaming adapter
packages/adapter-gemini     Gemini streaming adapter
packages/adapter-local      Ollama local streaming adapter
packages/cli                validate, inspect, run, test, runs, trace, studio
frontend                    Next.js Web Studio
examples                    RAG, MCP Tool Agent, Loop, provider, and extension specs
docs/v1/v1.1                v1.1 research, decisions, and verification notes
```

## Development checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

See the [v1.1 implementation and verification report](./docs/v1/v1.1/implementation.md) and [research notes](./docs/v1/v1.1/research.md).
