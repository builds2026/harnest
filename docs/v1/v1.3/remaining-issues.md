# v1.3 remaining issues

No known requirement-blocking implementation issue remains in the v1.3 scope.

The current uncommitted root `harnest.yaml` is an authoring draft, not a release fixture: `skill_1.skill` and `loop_1.subgraph` are empty, and the Loop cannot reach the entrypoint. Studio and CLI surface those four diagnostics correctly. The file was deliberately left untouched because it belongs to the user's worktree.

The following checks require external state and are therefore release-environment tasks, not mocked successes:

- Complete a real third-party OAuth consent popup for an MCP server that publishes discovery metadata.
- Run Firecrawl with a supplied Firecrawl credential. Gemini + SearXNG + Docker Code Runner already passed as real external calls on Windows with Docker Desktop.
- Repeat the passing selected upload `/mnt/data` → Code Runner → `/mnt/output` path on Podman and non-Windows release matrices.
- Add screenshot-diff coverage if the competition CI provides stable browser fonts and viewport rendering; current browser verification is structural plus manual visual inspection.
- Provider cache-hit accounting remains Provider-specific. Harnest guarantees bounded replay and reports returned usage/cost, but does not label a request “cached” unless an adapter can prove it.

Reviewed `runtime.modules` execute with host-process authority after explicit opt-in. They must not be described as untrusted plugin sandboxes; model-invoked stored TypeScript, Shell, Code Runner, and saved MCP stdio use the separate container boundary.
