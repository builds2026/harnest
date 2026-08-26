# v1.5 baseline audit

Audit date: 2026-08-25. The audit was performed against the working tree, preserving all existing uncommitted work.

## Existing assets reused

- Core already has `RunHandle`, sequence events, `RunSnapshot`, command deduplication, dynamic Team scheduling, model-turn checkpoints, structured Loop working state, Artifact references, and a sharded file `RunStore`.
- Runtime services already centralize Tool execution and permission checks across embedded SDK, CLI, Studio API, and MCP-related Tools.
- Conversation compaction, attachment reuse, multimodal adapter input, provider prompt-cache hints, and local Playground file/session storage already exist.
- Studio already has Base UI primitives, a three-region Playground, file upload/workspace lifecycle, trace rows, scoped persistent permission settings, and ko-KR/en-US dictionaries.

## Root gaps found

- Approval waiting used a process-local broker. The pending request was inspectable in Playground but was not a durable `RunSnapshot` interaction, so restart recovery could not be correct.
- Run state had no canonical six-kind interaction record, checkpoint digest, explicit `paused` status, run-only grant set, or processed-interaction ID set.
- Permission values exposed only legacy `once | always | deny`; there was no distinct `allow_for_run` lifetime in every surface.
- The package named SDK was an embedded Node runtime entry point. Browser/Node HTTP+SSE, reconnect, protocol-major validation, and a Python client were absent.
- Conversation, memory, file, connection, permission, and cache operations were coupled to local Studio storage rather than expressed as host provider contracts.
- Existing APIs streamed internal NDJSON. They lacked a versioned capabilities endpoint and standard SSE envelope/reconnect behavior.
- Playground rendered only Tool approval. Generic selection, text, form, file reference, OAuth, expiry, decline/cancel, and pending-state restoration were absent.
- The reference product directory was empty, so the claimed host/runtime ownership boundary had no executable example.

## Constraints preserved

- No workflow framework, ORM, SQL client, Supabase dependency, or new frontend state library is added to Harnest core.
- JSON validation remains at every HTTP, protocol, interaction, file, and permission trust boundary.
- Secrets, interaction values, opaque context references, absolute paths, and internal compact state remain excluded from user output and sanitized trace.
- Persistent `allow_always` grants stay scoped by Harness, Tool, Connection, capability, and resource and remain revocable.
- Resuming cannot blindly repeat an external side effect whose completion is unknown.
