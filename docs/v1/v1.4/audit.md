# v1.4 baseline audit and resolution

The gap inventory below is the pre-implementation snapshot used to scope v1.4. It is retained for traceability; the final resolution matrix at the end is authoritative for the current tree.

## Runtime and data flow

Current execution path:

```text
harnest.yaml
  -> loadSpecFile / parseSpec
  -> adapter + component + tool registries
  -> NodeRuntimeServices (connections, credentials, tools, skills, sandbox)
  -> HarnessRuntime
  -> RunEvent stream + FileRunStore
  -> Studio / CLI / SDK / HTTP / MCP presenter
```

The common Core and Node runtime are already a strong base. Studio, CLI, SDK, HTTP, and MCP all reach `HarnessRuntime`; NodeRuntimeServices already owns exact persisted Tool grants and container process execution. The missing layer is a first-class project source model and typed workspace/artifact/context events.

## What already works and must be preserved

- Strict v0.1/v0.2 parsing, graph compilation, subgraphs, Router, Join, Evaluator, and bounded Loop.
- Provider-independent Agent tool calling with input/output schema validation, fallback connection, tool timeout, token/cost limits, and trace events.
- Built-in web search/scrape, HTTP, file, shell, and code-runner manifests; container-only process execution for approved Local Runtime connections.
- Project and user connections, credential indirection, MCP HTTP/stdio, OAuth flow, Tool and Skill stores.
- `once | always | deny` approval, persisted exact Harness + Tool + Connection grants, and Settings revocation.
- Playground session history, selected file persistence, per-run input/output workspaces, artifact collection, version history, recipe-reset warning, semantic/layout revisions, aborted superseded saves, and ko-KR/en-US dictionaries.

## Baseline gaps

### Project model

- `harnest.yaml` is the only loadable source. `.harnest` is a collection of independent runtime stores, not an indexed project.
- Prompt and output schema are inline-only. Context and local Skill installation still expose manual paths.
- CLI bundle includes only `harnest.yaml` and `assets/`; it does not have a declared portable project manifest or secret template.
- Studio cannot select/switch a project directory or browse project Prompt/Context/Schema/Test assets.

### Studio schema coverage

The built-in manifest registry has 15 component types. The generic Inspector renders declared inspector fields, but nine schema properties are not declared in manifests:

| Component | Missing Inspector properties |
|---|---|
| Model | `fallbackConnectionId` is handled by a special connection selector; `baseUrl` is not exposed |
| Context | `maxBytes` |
| Tool | `label`, `description`, `source` |
| Evaluator | `minCalls`, `maxCalls` |

Root/runtime/test/policy fields and subgraph management are available primarily through raw YAML rather than structured controls. There is no automated manifest-to-Inspector coverage gate.

### Studio architecture and UX

- `frontend/components/studio.tsx` remains 2,247 lines and owns boot, routes, graph, selection, catalog, connections, save, validation, run, test, experiments, dialogs, and all surface composition.
- Legacy CSS is still 5,287 lines; the newer system CSS is 1,529 lines. Base UI exists, but most Studio fields and buttons still consume legacy class contracts.
- Tool selection happens through the global palette. A Tool node's own inspector exposes its raw identifier only in Advanced, so web/shell/code intent is not obvious.
- Local Skill installation requires a typed host path. There is no direct SKILL.md text/file creation flow.
- Navigation is URL-based, but a single client component still renders every route and owns all state.

### Agent context and artifacts

- Conversation replay is bounded to 20 messages/64 KiB in Playground. Older messages are dropped rather than compacted into a typed objective/decision/evidence/remaining-work checkpoint.
- Loop `carry: merge` can preserve structured fields only when every subgraph result returns them; there is no runtime-owned immutable original objective or checkpoint merge policy.
- Attachments reach agents as metadata and sandbox paths. Generated files are discovered by Playground polling/final scan, not emitted as first-class runtime artifact events.
- Adapters expose text/tool events only; multimodal model input and output capability negotiation are absent.

### Permission and workspace scope

- Risky Tool approval is centralized, but `allowFileSystem`, Context roots, module execution, and legacy process/network capabilities are still host startup options rather than the same scoped decision model.
- Code Runner receives only Playground upload/output mounts. It cannot explore an explicitly approved project workspace through a consistent read/write scope.
- Non-interactive HTTP/MCP can use persisted grants or host-preapproved IDs, but there is no protocol-level `approval-required` pause/resume token for a remote operator.

### Tests

- Unit/integration coverage is broad, but current Playwright Studio tests intercept API routes and are presentation tests, not proof of a real runtime.
- There is no manifest/Inspector exhaustiveness test, project round-trip/bundle test, context-compaction test, typed artifact E2E, or save-request performance assertion.
- Live Provider/Firecrawl/SearXNG results documented in v1.3 were collected in a different host environment and cannot be treated as current Ubuntu proof.

## Final resolution audit — 2026-08-25

| Baseline area | Current result | Evidence |
|---|---|---|
| Project model | Resolved | `node-project.ts`, root `.harnest/project.json`, project APIs, portable bundle/init tests |
| Studio schema coverage | Resolved | All built-in schema paths are covered by manifest/domain controls; an exhaustive test fails on omissions |
| Tool/Skill setup | Resolved | Tool quick choices clear stale configuration; project Skill text/file creation and reviewed install paths share existing stores |
| Agent context | Resolved | Runtime-owned structured Loop checkpoint plus private bounded conversation checkpoint preserve objective, plan, decisions, evidence, current result, validation, and remaining work |
| Permission scope | Resolved | Capability/resource-aware exact grants cover Tool, file, process, network, and module execution and are used by Studio, CLI, SDK, HTTP, and MCP |
| Attachments/artifacts | Resolved | Session file references survive later turns/reload; media reaches capable adapters; live/final typed Artifact events use managed references and safe download routes |
| Versioning/reset/save | Resolved | Version list/diff/preview/restore, pre-restore snapshot, recipe warning, transient drag state, debounce, abort, and server supersession are implemented |
| Real runtime proof | Resolved locally | Actual MCP HTTP E2E and Docker Code Runner smoke passed; live hosted Providers are not claimed without credentials |

The large `studio.tsx` and legacy global CSS remain maintainability debt, but they no longer block the requested v1.4 behavior. They are deliberately not rewritten wholesale because the existing reducer, React Flow integration, and visual contracts are still active and tested.
