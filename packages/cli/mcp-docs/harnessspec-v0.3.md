# HarnessSpec v0.3

`harnest.yaml` is the canonical, strict specification. Unknown keys, duplicate YAML keys, malformed IDs, and invalid values fail validation. Quote the version as `"0.3"`.

## Top-level shape

```yaml
version: "0.3"
components: []
connections: []
entrypoint: component_id
subgraphs: {}       # optional reusable graph bodies
agentTemplates: {}  # optional dynamic-agent templates
teams: {}           # optional orchestration definitions
runtime: {}         # optional limits and context behavior
tests: []           # optional executable assertions
studio: {}          # optional visual layout only
```

`components`, `connections`, and `entrypoint` form the root graph. Every subgraph has those same three fields. Component IDs begin with a letter, contain only letters, digits, `_` or `-`, and are unique within their graph.

## Components

Every v0.3 component has:

```yaml
- id: concise_unique_id
  type: installed-component-type
  config: {}
  policy:                 # optional
    timeoutMs: 30000
    retry:
      maxAttempts: 2
      backoffMs: 250
      maxBackoffMs: 2000
```

Component configuration and ports depend on the installed runtime. Read the MCP server's generated component catalog rather than guessing. Prefer a built-in component over a local module, and a saved Connection over embedding transport or credential details.

The authoring validator does not execute `runtime.modules`, so it cannot load schemas or component definitions contributed only by custom executable code. A custom component type may therefore be reported as unknown during authoring validation. Authoring-compatible projects must use built-in/otherwise known component types, or provide the custom contract through a declarative schema mechanism known to the validating host.

## Connections

```yaml
- id: optional_edge_id
  from: { component: source, port: output }
  to: { component: destination, port: input }
  select: /result/text       # optional JSON Pointer projection
  condition:                 # optional conditional delivery
    source: value            # value, state, or input
    path: /status
    op: equals
    value: ready
  state:                     # optional durable graph state write
    key: workflow.result
    merge: replace           # replace or append
```

Predicate operations are `equals`, `notEquals`, `contains`, `matches`, `exists`, `truthy`, `gt`, `gte`, `lt`, and `lte`. Validate connectivity and port compatibility; visual proximity in Studio has no execution meaning.

## Subgraphs, dynamic agents, and teams

Subgraphs isolate reusable flows. An agent template has a human-readable `description`, optional capability labels, and exactly one runner: a local `subgraph` or an external A2A `connection`.

```yaml
agentTemplates:
  coordinator:
    description: "Plan work and synthesize the final result."
    capabilities: []
    runner: { subgraph: coordination_flow }
  researcher:
    description: "Collect relevant evidence and preserve sources."
    capabilities: [research, citations]
    runner: { subgraph: research_flow }
  reviewer:
    description: "Review evidence and flag unsupported claims."
    capabilities: [citations]
    runner: { subgraph: review_flow }
teams:
  review_team:
    orchestrator: coordinator
    members: [researcher, reviewer]
    limits:
      maxInstances: 4
      maxDepth: 3
      maxParallel: 2
      maxMessages: 40
      maxPlanRevisions: 8
```

Team members and the orchestrator must name keys in the top-level `agentTemplates` map (`coordinator`, `researcher`, and `reviewer` above), not component IDs in the owning graph. Each template's runner then names its subgraph or external A2A Connection. Set finite limits; validation should reject missing references and unsafe or impossible topology.

## Runtime

```yaml
runtime:
  timeoutMs: 120000
  adapters: ["@harnestai/adapter-openai"]
  modules: ["./tools/project-tool.mjs"]
  retry: { maxAttempts: 2, backoffMs: 500 }
  budget: { maxTokens: 12000, maxCostUsd: 1.50 }
  context: { cacheMode: automatic, overflow: compact }
```

Modules are executable code and require explicit host approval. The authoring validator records them in `setupRequired.modules` but never imports or executes them, so module-defined schemas and component types are unavailable unless the validating host already knows their declarative contracts. Runtime options constrain execution; they do not grant filesystem, process, network, or workspace-write permission.

## Tests and Studio data

Tests accept one `assertion` or a non-empty `assertions` list. Studio positions, pinned nodes, viewport, direction, and subgraph layouts are editor metadata and must not alter runtime semantics. See [Tests and evaluation](harnest://docs/tests-evaluation) and [Graph and runtime](harnest://docs/graphs-runtime).
