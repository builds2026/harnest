# Harnest

Harnest is an open-source Visual Graph Engineering Platform for AI agent harnesses. Design typed components, branches, parallel joins, reusable subgraphs, bounded loops, tools, and evaluators in the Web Studio, then run the same `harnest.yaml` through the CLI or TypeScript API.

## Quick start

Requirements: Node.js 22.15 or newer and npm 10 or newer.

```bash
npm install
npm run build
npm test
npm run harnest -- validate harnest.yaml -- --allow-modules
npm run harnest -- run harnest.yaml -- --input "hello" --allow-modules
npm run harnest -- studio harnest.yaml -- --allow-modules
```

Open `http://127.0.0.1:3000`. The root spec uses a deterministic local Echo Adapter, so it runs without a secret or network connection. For a real Gemini + Web Search + Code Runner graph, open [the full-stack example](./examples/gemini-full-stack/README.md); Studio detects its missing Connections and presents them one at a time.

For a new project, start with no YAML editing:

```bash
npm run harnest -- init my-agent
npm run harnest -- studio my-agent/harnest.yaml
```

Studio starts with outcome-based Recipes. Choose one and add only the requested Services; YAML saving and runtime validation happen automatically. **Setup** explains blockers, **Tests** creates repeatable cases, **Compare** runs two component-setting variants, and **Activity** keeps the technical trace. The top-level **Harnest Playground** provides the service-like chat surface: conversation history, observable execution timelines, per-run model/tool/skill controls, file uploads, and live sandbox output without changing `harnest.yaml`.

When the harness declares an enabled Code Runner, Playground uploads can be selected for a run. Only the selected files are copied into the isolated container at `/mnt/data` (read-only); user-facing outputs written to `/mnt/output` return to the Sandbox explorer. See [the Playground guide](./docs/v1/v1.2/playground.md).

## Executable v0.2 examples

The repository includes end-to-end examples:

```bash
# Project-bounded lexical RAG over Markdown files
npm run harnest -- run examples/rag/harnest.yaml -- \
  --input "How are Context paths protected?" \
  --allow-files --context-root knowledge --allow-modules

# Generate → evaluate → improve until /evaluation/passed is true
npm run harnest -- run examples/evaluation-loop/harnest.yaml -- \
  --input "Draft answer" --allow-modules

# Gemini + Firecrawl Search/Scrape + isolated Code Runner (Studio guides setup)
npm run harnest -- studio examples/gemini-full-stack/harnest.yaml
```

Their declared tests use the same graphs:

```bash
npm run harnest -- test examples/rag/harnest.yaml -- --allow-files --context-root knowledge --allow-modules
npm run harnest -- test examples/evaluation-loop/harnest.yaml -- --allow-modules
```

Raw MCP stdio is fail-closed because it cannot provide OS isolation. Use a saved MCP Connection: Streamable HTTP supports OAuth discovery, and stdio runs in an approved no-network container. Studio discovers server Tools and equips the selected Agent.

## Connections from the CLI

The same lifecycle used by Studio is available without hand-editing metadata:

```bash
npm run harnest -- connections [file] -- --json
npm run harnest -- connect gemini [file] -- --id gemini-main --secret-env GEMINI_API_KEY
npm run harnest -- connect firecrawl [file] -- --id web-main --secret-env FIRECRAWL_API_KEY
npm run harnest -- connect searxng [file] -- --id web-main --url https://search.example/search
npm run harnest -- connect sandbox [file] -- --id sandbox-main --runtime node
npm run harnest -- connection test|login|disconnect|revoke|delete <id> [file]
```

The second `--` before Harnest options is required when invoking the CLI through `npm run`. `connect` saves, authenticates or approves, and tests in one command. Secrets come from a hidden prompt or one named environment variable and are stored in the OS-protected local vault, never in YAML or command arguments.

MCP Streamable HTTP defaults to browser OAuth. Paste the MCP URL; Harnest discovers Protected Resource Metadata, the authorization server, scopes, PKCE and dynamic registration endpoints. A bearer-token mode remains available for servers that require it.

Model components can select a second saved Provider as a fallback. Harnest switches once only after a retryable primary-provider failure, includes both attempts in usage/cost, and records the transition in Activity.

## Use a harness without Studio

The same runtime can be embedded, served over loopback HTTP, or exposed as an MCP tool:

```bash
# GET /health, POST /invoke, POST /stream (NDJSON)
npm run harnest -- serve harnest.yaml -- --port 8787 --allow-modules

# stdio MCP server with invoke_harness
npm run harnest -- mcp serve harnest.yaml -- --allow-modules
```

```ts
import { Harnest } from "@harnest/sdk";

const harness = await Harnest.load("./harnest.yaml", { allowModuleExecution: true });
try {
  const result = await harness.invoke("hello");
  console.log(result.output);
} finally {
  await harness.close();
}
```

`Harnest.stream()` exposes runtime events and `Harnest.test()` runs the spec's declared cases. Module execution remains opt-in; omit it for specs made only from shipped adapters and built-ins.

Create one deployment artifact containing only the validated spec and project `assets/`:

```bash
npm run harnest -- bundle harnest.yaml -- --output support-agent.harnest
```

The `.harnest` file is a deterministic standard ZIP container. It deliberately excludes `.env`, local Connections, credentials, traces, and other `.harnest/` state, and refuses to overwrite an existing artifact.

## Capabilities and safety

Runtime capabilities are denied by default. Grant only what a reviewed spec needs:

- `--allow-modules` enables adapter, component, and tool modules after review. Even `validate` and `inspect` refuse to execute a listed module without this flag.
- `--allow-files` enables file or directory Context inside the project. `--context-root <path>` can further restrict it and is repeatable. Hidden metadata, `.harnest`, private-key files, and common credential files remain blocked.
- `--allow-process <command>` remains for reviewed legacy local Tools. Raw MCP stdio is disabled; saved MCP stdio, Shell, Code Runner, and TypeScript Tools require an approved Docker/Podman container with networking disabled, a read-only root, dropped capabilities, non-root execution, and resource bounds.
- `--allow-network <host[:port]>` allows one exact MCP Streamable HTTP or HTTP Tool host and is repeatable. Remote endpoints require HTTPS; plain HTTP is limited to literal `127.0.0.1` or `[::1]`. Redirects and URL credentials are rejected, and raw MCP header values must be `env:NAME` references.

File paths and executable modules are checked through verified handles and canonical real paths, including symlinks and Windows junctions. Outbound provider/MCP/HTTP requests resolve and pin permitted public IPs before connecting. Adapter and runtime modules must be npm package specifiers or project-relative paths. SDK callers must pass `{ allowModuleExecution: true }`; the CLI does this only after a user has explicitly invoked it on a project. Review third-party Harness projects before validating or running them.

## Runs and traces

CLI runs and tests append privacy-bounded NDJSON events under the spec project's `.harnest/runs/`. Project memory is stored atomically in `.harnest/memory.json`.

```bash
npm run harnest -- runs examples/rag/harnest.yaml
npm run harnest -- trace <run-id> examples/rag/harnest.yaml
npm run harnest -- trace <run-id> examples/rag/harnest.yaml -- --json
```

Trace storage preserves bounded node inputs, outputs, state changes, iterations, tool calls, evaluations, usage, and cost. Secret-shaped keys are redacted and large strings/collections are truncated.

Provider ingress is bounded before accumulation: the shared SSE/NDJSON parser limits total, line, and event bytes; adapters bound error bodies, Tool-call count, and Tool arguments; the Agent separately enforces configured turn/Tool/token/cost limits and an 8 MiB text limit per provider turn.

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
packages/sdk                high-level load, invoke, stream, test API
packages/adapter-openai     OpenAI-compatible streaming adapter
packages/adapter-anthropic  Anthropic Messages streaming adapter
packages/adapter-gemini     Gemini streaming adapter
packages/adapter-local      Ollama local streaming adapter
packages/cli                init, bundle, validate, run, test, serve, MCP serve, studio, Services, Skills
frontend                    Next.js Web Studio
examples                    RAG, MCP Tool Agent, Loop, provider, and extension specs
docs/v1/v1.1                v1.1 research, decisions, and verification notes
docs/v1/v1.2                v1.2 implementation, security, run, and verification notes
```

## Development checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

See the [v1.2 implementation report](./docs/v1/v1.2/implementation.md), [security boundary](./docs/v1/v1.2/security.md), and [verification report](./docs/v1/v1.2/tests.md).
