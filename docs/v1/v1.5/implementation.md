# v1.5 implementation map

## Shared protocol and SDKs

- `packages/protocol` is the browser-safe source of the v1 HTTP, SSE, Interaction, permission, create-run, command, event, and snapshot schemas. Its build publishes JavaScript declarations, Draft 2020-12 JSON schemas, and a language-neutral golden fixture.
- `packages/sdk` is the remote TypeScript client. The embedded Node runtime remains available through `@harnestai/sdk/node`.
- `python` contains sync and async remote clients. It does not embed or reimplement the Harnest runtime.
- `packages/cli` and Studio expose the same `/v1` resource paths and wire envelopes. Existing NDJSON and embedded APIs remain compatibility surfaces.
- `packages/cli` also exposes `harnest mcp serve [workspace]` as an authoring-only MCP server. It serves documentation, generated catalogs, schema, an authoring prompt, and secret-free static validation; the former runtime-serving `describe_harness`/`invoke_harness` MCP surface is not part of v1.5. Runtime execution remains on the embedded SDK, CLI, Studio, and HTTP APIs.

## Runtime

- `packages/core/src/orchestration.ts` owns durable Interaction requests, checkpoint digests, processed response IDs, run grants, paused state, commands, and public snapshot redaction.
- `packages/core/src/runtime.ts` routes Tool permission requests and agent interactions through one `RunControl`, applies the four permission lifetimes, resumes checkpoints, and converts internal events to redacted public events.
- `packages/core/src/provider.ts` defines host-owned Conversation, Memory, Cache, File, Connection, Permission, and RunStore contracts. Provider credentials are resolved within the requesting run rather than shared across tenants.
- `packages/core/src/component.ts` reuses existing Context, Memory, Agent, Team, and Tool execution paths. External records are budgeted and normalized as attributable sources before model invocation.
- `packages/core/src/node.ts` provides the local Studio host adapters and durable file RunStore. These are development adapters, not a product database.

## Studio

- `frontend/components/interaction-renderer.tsx` renders select, input, bounded form, file reference, OAuth, and permission requests using existing Base UI components.
- `frontend/components/playground.tsx` restores pending requests from a snapshot, queues concurrent task-level interactions, and submits canonical commands without changing the HarnessSpec.
- `frontend/app/v1` implements capabilities, create, SSE, snapshot, commands, and cancel. The legacy `frontend/app/api/runs` surface remains available.
- `frontend/app/api/tool-permissions` and Settings list and revoke persistent `allow_always` grants. Run-only grants never enter that store.

## Reference host

`/home/louis/Documents/Harnest_root/nextjs_ai` is a separate Next.js service. Its browser talks only to its authenticated BFF. Supabase owns product records and RLS; a lease-based worker talks to Harnest and to a bearer-protected internal provider bridge. The worker does not hold Supabase credentials or directly query product tables.

The create-run request carries an opaque `contextRef`, provider revisions, and safe attachment metadata separately from model input. Harnest asks the host bridge to resolve that reference; neither the reference nor host identifiers are copied into trace, cache identity, or final output.

## Compatibility

- HarnessSpec remains v0.3.
- Existing `invoke()`, `stream()`, embedded `Harnest.load()`, `/api/runs`, and NDJSON callers continue to work for the v1 transition release.
- Legacy `once | always | deny` permission inputs normalize only at compatibility boundaries; persisted/runtime state uses canonical values.
- Internal recovery snapshots remain richer than public API snapshots. Public snapshots deliberately omit response values and model-turn recovery checkpoints.
