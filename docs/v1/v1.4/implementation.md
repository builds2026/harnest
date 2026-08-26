# v1.4 implementation

## Portable project and Studio IDE

- `packages/core/src/node-project.ts` defines the strict `.harnest/project.json` contract, resolves a directory to its Harness, safely materializes Prompt/Context/Schema/Test bindings, lists portable files, writes project assets with revision checks, and excludes symlinks, escapes, oversized data, secrets, runtime stores, and credentials.
- CLI `init`, `bundle`, `validate`, `inspect`, `run`, `test`, `serve`, `studio`, and MCP resolution share the same project loader. `.env.example` contains names only; credential values remain in the OS vault or an explicit headless credential backend.
- `frontend/app/api/project` and `project/import` expose same-origin, bounded CRUD/import operations without returning an unrestricted host path. `ProjectFiles` supplies folder import, source creation, conflict-safe editing, discard, and confirmed delete.
- The repository root now demonstrates the format with `.harnest/project.json`, Prompt, Context, Schema, Test, Skill, and Studio assets. The duplicate `.agents` Skill was removed so one project definition is authoritative.

## Structured Loop and durable context

- `Loop.config.checkpoint: structured` replaces `[FINAL]` string detection. Core keeps `originalRequest`/`objective`/`plan` immutable, merges the current result and verified evidence, and accepts `complete` only with passed validation, an empty `remainingWork`, and a non-empty `finalAnswer`.
- Agent conversation compaction creates a bounded private checkpoint containing the original request, plan, decisions, evidence/tool outcomes, current result, validation, and remaining work. Evicted chat messages no longer erase working state.
- The public final result maps only `/finalAnswer`; internal checkpoints stay out of Playground, CLI, SDK, HTTP, and MCP output unless a Harness explicitly maps them.

## Permissions and sandbox workspace

- `NodeRuntimeServices` persists exact grants by Harness, Tool, Connection, capability, and normalized resource. Capability types are `tool-execution`, `workspace-read`, `workspace-write`, `process`, `network`, and `module-execution`.
- Decisions remain `once | always | deny`. Studio uses a pending approval broker; CLI prompts in a TTY or accepts exact preapproval; HTTP exposes bounded pending approval/decision routes; SDK uses the same callback contract; MCP/HTTP execution goes through the same runtime service. Settings and CLI can list and revoke exact grants.
- File, Shell, Code Runner, HTTP/web, MCP, and module calls are denied without policy approval. Container execution uses a pinned reviewed image, no network, read-only root, dropped capabilities, bounded CPU/memory/PIDs, secret-filtered project snapshots, read-only inputs, and a writable run output.

## Attachments, multimodal input, and Artifacts

- Playground stores file ownership and selected references with the chat session instead of clearing them after one message. The next turn and a reloaded session can resolve the same safe file reference.
- Image/audio/video/PDF file parts are passed directly to adapters that declare compatible media; Gemini, OpenAI, Anthropic, and local adapter request builders now emit native typed media instead of metadata-only text.
- Core collects generated output under `.harnest/artifacts/<runId>`, validates reads, applies retention, and emits `artifact-created`/`artifact-updated` before the final compatibility event. Studio previews or downloads only through `/api/artifacts`, with no-store, CSP sandbox, `nosniff`, and safe disposition headers.

## Studio behavior

- Inspector now exposes every built-in schema setting through generic or domain controls, including runtime/policy/test fields, structured Loop completion, project sources, and quick Tool choices for Web Search, Code Runner, and Shell. Switching a Tool removes stale connection/action/schema fields.
- Recipe selection opens a Base UI confirmation dialog before replacing the current Harness and distinguishes saved from unsaved changes and reset scope.
- Version history stores valid YAML snapshots with timestamps, summaries, hashes, component/edge/runtime/test comparisons, preview, and one-click restore. Restore force-records the current state first.
- React Flow position changes stay transient during drag and commit once on drag stop. Semantic edits use debounce; the client aborts superseded requests; the server serializes saves, drops stale revisions, hashes unchanged YAML, and records only meaningful versions.
- Development and production Next outputs are separated as `.next` and `.next-build`. The build wrapper restores generated TypeScript references, so running `npm run build` cannot overwrite a live Studio's dev chunks or dirty `next-env.d.ts`.
- Project, permissions, versions, Tool/Skill setup, Artifact state, and all new recovery paths have ko-KR/en-US strings.

## Primary implementation files

- Core: `packages/core/src/component.ts`, `runtime.ts`, `node.ts`, `node-project.ts`, `node-tools.ts`, `node-connections.ts`, `safe-files.ts`
- Surfaces: `packages/cli/src/index.ts`, `packages/sdk/src/index.ts`, `frontend/app/api/*`
- Studio: `frontend/components/studio.tsx`, `inspector.tsx`, `playground.tsx`, `project-files.tsx`, `version-history.tsx`, `studio-settings.tsx`
- State: `frontend/lib/playground-store.ts`, `studio-state.ts`, `harness-version-store.ts`, `approval-broker.ts`
- Real fixtures: `examples/runtime-e2e/harnest.yaml`, `runtime-adapter.mjs`, `container-smoke.mjs`, `frontend/e2e/runtime.spec.ts`
