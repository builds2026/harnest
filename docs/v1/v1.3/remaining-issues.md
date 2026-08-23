# v1.3 remaining issues

No known requirement-blocking implementation issue remains in the v1.3 scope.

The following checks require external state and are therefore release-environment tasks, not mocked successes:

- Complete a real third-party OAuth consent popup for an MCP server that publishes discovery metadata.
- Run the Gemini + Firecrawl/SearXNG + Code Runner example with real credentials and a running Docker or Podman daemon.
- Execute the selected upload `/mnt/data` → Code Runner → `/mnt/output` path on each supported container engine/OS combination.
- Add screenshot-diff coverage if the competition CI provides stable browser fonts and viewport rendering; current browser verification is structural plus manual visual inspection.
- Provider cache-hit accounting remains Provider-specific. Harnest guarantees bounded replay and reports returned usage/cost, but does not label a request “cached” unless an adapter can prove it.

Reviewed `runtime.modules` execute with host-process authority after explicit opt-in. They must not be described as untrusted plugin sandboxes; model-invoked stored TypeScript, Shell, Code Runner, and saved MCP stdio use the separate container boundary.
