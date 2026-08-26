# v1.4 implementation plan

Implementation status: all seven phases are complete for the local/runtime boundary. Optional hosted Provider smoke checks are blocked only by absent credentials; see `remaining-issues.md`.

| Phase | Status | Verification |
|---|---|---|
| 0. Baseline/safety net | Complete | lint, typecheck, 243 tests, build |
| 1. Portable project | Complete | loader, traversal/symlink/secret/bundle tests |
| 2. Project IDE | Complete | API create/read/update/delete/import tests and Studio UI |
| 3. Studio controls/graph | Complete | exhaustive manifest test and 7-scenario Playwright suite |
| 4. Permissions | Complete | Core/CLI/SDK/API tests plus real Browser deny/once/always/revoke E2E |
| 5. Context/Loop | Complete | structured Loop and long-conversation compaction tests |
| 6. Media/Artifacts | Complete | all adapters, Artifact route/Core tests, actual upload reuse, real Docker Artifact smoke |
| 7. Validation/docs | Complete | commands and measured results in `tests.md` and `performance.md` |

The order is intentionally dependency-driven. Every phase ends in a buildable, testable repository and appends evidence to `implementation.md` and `tests.md`.

## Phase 0 — Baseline and safety net (P0)

Scope:

- Freeze the current dirty-worktree baseline without reverting user changes.
- Add automated manifest/Inspector coverage reporting and real save-request counting support.
- Record current lint, typecheck, test, build, and interaction/save metrics.

Dependencies: none.

Acceptance:

- Existing gates pass before v1.4 changes or every pre-existing failure is recorded exactly.
- Existing structured Loop completion, approvals, file reuse, recipe warning, version restore, and save batching tests remain green.

## Phase 1 — Project source model and portable loader (P0)

Scope:

- Add a versioned `.harnest/project.json` with safe relative asset bindings and no secrets.
- Canonical asset folders: `prompts/`, `skills/`, `context/`, `schemas/`, `tests/`; Studio preferences live in `.harnest/studio.json`; portable metadata lives in the project manifest.
- Extend the common Node loader to materialize bound Prompt, Context, Schema, and Test assets into the in-memory `HarnessSpec`. A missing manifest is a no-op.
- Add `.env.example` generation from discovered `env:` references without reading or copying secret values.
- Extend `init`, `bundle`, CLI, SDK, Studio, HTTP, and MCP to use the same project resolver. Bundle only declared portable assets; reject links, escapes, oversized files, and secret/runtime stores.

Dependencies: Phase 0.

Acceptance:

- Legacy YAML round-trip is byte-semantically unchanged.
- A project with external assets produces the same materialized spec on all execution surfaces.
- Move/copy/bundle/reopen works without absolute paths.
- Traversal, symlink, oversized asset, stale hash, and secret-leak tests pass.

## Phase 2 — Project APIs and Studio project IDE (P0)

Scope:

- Add server-only project APIs for discovery, safe tree listing, file read/create/update/delete, import, and binding. Operations are rooted under the configured workspace and protected by same-origin, size, extension, revision, and path checks.
- Add a pathless project chooser: clickable directory navigation within the configured workspace plus recent projects. No free-form host path is required.
- Add a Project rail/tree and editors for Prompt, Context, Schema, Test, and portable settings. Reuse existing fields, dialogs, Async/Error/Empty states, and i18n.
- Direct Skill creation supports typed SKILL.md content or uploaded files; executable resources retain the existing review/approval path.

Dependencies: Phase 1 and local Next.js App Router/Route Handler rules.

Acceptance:

- Select project -> edit asset -> save -> reload -> CLI materializes the edit.
- Conflict, cancellation, invalid file, permission denial, missing project, empty project, and recovery states are visible and recoverable.
- Browser responses never reveal unrestricted absolute paths or secret values.

## Phase 3 — Exhaustive Studio controls and graph UX (P0/P1)

Scope:

- Make manifest inspector declarations exhaustive and add domain controls for Model, Tool, Skill, Context, Evaluator, policy, runtime budget/retry, tests, subgraphs, and edge flow settings.
- Tool nodes offer internal cards for Web Search, Web Scrape/HTTP, File, Shell, Code Runner, installed custom tools, and MCP; connection requirements and approval risk update immediately.
- Prompt/Context/Schema/Test fields select project assets instead of requiring paths. Advanced retains raw IDs and JSON where necessary.
- Preserve hover-port `+`, compatible insertion, undo/redo, diagnostic focus, version history, recipe warning, and semantic/layout save batching.
- Split `studio.tsx` along existing domain boundaries without a new state library.

Dependencies: Phases 1–2.

Acceptance:

- Every built-in schema property is intentionally represented by a structured control, a domain control, or a documented raw-YAML-only exception; CI enforces the mapping.
- Every valid v0.2 root, component, connection, subgraph, runtime, test, studio, and policy setting can be created/edited without losing unknown registered-module fields.
- Keyboard, focus, ko/en, light/dark, empty/error/loading/cancel/retry states pass Playwright.

## Phase 4 — Unified workspace permissions (P0)

Scope:

- Generalize the persistent decision store from Tool-only grants to typed capabilities: tool execution, workspace read, workspace write, process, network host, and module execution.
- Keep exact scope keys: Harness + capability + Tool + Connection + normalized resource scope. Support once, always, deny, expiry for one-time requests, revocation, and audit metadata.
- Add approved workspace mounts: project read-only by default, explicit write paths, per-run output read-write, no host root mount. File and process tools use the same request path.
- Add an approval-required event/token and bounded resume endpoint for remote HTTP/MCP operators; CLI remains interactive; SDK accepts the same callback contract; Studio uses its approval sheet.
- Preserve cancel, timeout, disconnect, retry, and Trace behavior across every surface.

Dependencies: Phase 1 project identity.

Acceptance:

- The same request is denied by default on all five surfaces, can be allowed once, can be persisted exactly, and can be revoked in Settings.
- A grant for one Harness/Tool/Connection/path never authorizes a sibling Harness, different connection, broader path, or destructive operation.
- Sandbox breakout, path race, symlink, cancelled approval, expired request, and remote resume replay tests pass.

## Phase 5 — Durable agent context and structured Loop checkpoint (P0)

Scope:

- Introduce a typed checkpoint containing immutable original request, current plan, decisions, evidence references, current result, verification, remaining work, and completion status.
- Runtime owns checkpoint normalization and merge. Loop iteration input always receives the immutable objective plus the latest checkpoint; malformed/missing model fields cannot erase prior state.
- Replace arbitrary history truncation with deterministic compaction at configured byte/token thresholds. Provider-native compaction may be used only behind an adapter capability; the portable fallback is a bounded typed summary.
- Internal checkpoint and prompts remain in Trace-safe structured metadata but final user output selects only the declared final result.

Dependencies: Phase 1 for durable references; Phase 4 for tools used during compaction.

Acceptance:

- Long fixture runs preserve the original request, decisions, evidence IDs, failures, and remaining work across every iteration and conversation compaction.
- No `[FINAL]` sentinel is required; completion is schema-validated.
- Final Studio/CLI/SDK/HTTP/MCP output contains no internal checkpoint unless the Harness explicitly maps it.

## Phase 6 — Multimodal inputs and typed artifacts (P1)

Scope:

- Add media/file input parts and adapter capability negotiation without breaking text-only adapters.
- Add typed `artifact-created`/`artifact-updated` runtime events with stable IDs, MIME type, size, safe preview/download reference, producer, and Trace metadata. Bytes stay in the artifact store.
- Generalize per-run artifact storage outside Playground so CLI/SDK/HTTP/MCP can return references or stream events; Studio provides preview/download for image, video, audio, text, and binary files.
- Retention, limits, cleanup, partial writes, cancellation, and rejected artifact states are explicit.

Dependencies: Phases 1 and 4.

Acceptance:

- A real container tool reads an uploaded file, produces text/image/binary output, emits live and final artifact events, and all surfaces can retrieve it according to policy.
- Unsupported model media is diagnosed before invocation; secrets and host paths do not appear in events or downloads.

## Phase 7 — Validation, performance, and documentation (P0)

Scope:

- Run lint, typecheck, unit/integration tests, production build, and Playwright after every phase.
- Add a non-mocked local E2E fixture using a real deterministic adapter, real runtime, real container/file Tool calls, actual permission transitions, project reload, attachment reuse, version restore, and artifact download.
- Add optional live Gemini AI Studio, Firecrawl/SearXNG, MCP HTTP/stdio, and container smoke scripts. Missing external credentials are reported as blocked evidence, never simulated success.
- Measure drag/input frames and actual `PUT /api/spec` count against the baseline; fail on duplicate or superseded persistence.

Dependencies: all phases.

Acceptance:

- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and Studio E2E pass.
- Playground and CLI real fixtures pass from a clean temp project.
- No interaction produces more than one effective save for an unchanged semantic/layout revision; drag movement performs no network save until drag stop/debounce.
- `implementation.md`, `tests.md`, `performance.md`, and `remaining-issues.md` contain reproducible commands and honest outcomes.

## Completion rule

The v1.4 goal is complete only when all acceptance items above are demonstrated. Missing third-party credentials may leave only the corresponding optional live-provider checks unresolved; they cannot be replaced with mocks or historical evidence.
