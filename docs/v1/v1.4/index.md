# Harnest v1.4

Status: implemented and locally verified
Baseline: v1.3 plus the uncommitted permission, attachment, version-history, and batched-save work present on 2026-08-25

This folder is the authoritative record for the v1.4 project-IDE and agent-runtime work. `harnest.yaml` remains the portable execution contract. `.harnest/project.json` and its referenced files become the editable project source model; all execution surfaces materialize that source through the same Core loader.

## Documents

- [research.md](./research.md) — primary-source findings and applied principles
- [audit.md](./audit.md) — current code, schema, UI, and runtime gaps
- [plan.md](./plan.md) — ordered implementation and acceptance gates
- [implementation.md](./implementation.md) — shipped architecture and file map
- [tests.md](./tests.md) — commands, fixtures, real E2E evidence, and results
- [performance.md](./performance.md) — save-request and interaction measurements
- [remaining-issues.md](./remaining-issues.md) — only verified unresolved items

## Delivered boundary

- `.harnest/project.json` now indexes portable Prompt, Context, Schema, Test, Skill, and Studio assets while `harnest.yaml` remains the execution fallback.
- Studio provides project file editing/import, exhaustive built-in configuration controls, internal Tool choices, persistent scoped permissions, version preview/restore, recipe reset confirmation, batched saves, durable Playground files, and live/final Artifact previews.
- Core owns structured Loop checkpoints, conversation compaction, multimodal model input, sandbox workspace snapshots, scoped permission grants, Artifact storage/events, and the common loader used by Studio, CLI, SDK, HTTP, and MCP.
- Local deterministic runtime, actual MCP HTTP, and actual Docker Code Runner checks pass. Live third-party Provider checks remain credential-dependent and are recorded separately.

## Non-negotiable compatibility boundary

1. Existing v0.1/v0.2 YAML files continue to load without migration.
2. A project without `.harnest/project.json` behaves exactly as it does today.
3. Project assets may enrich a loaded spec, but secrets never enter project metadata, browser storage, bundles, traces, or generated artifacts.
4. Studio, CLI, SDK, HTTP, and MCP execute the same materialized spec and use the same permission store.
5. A generated `.harnest` project can be bundled and reopened without host-specific absolute paths.
