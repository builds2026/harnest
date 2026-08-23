# v1.3 product research

Research date: 2026-08-24. The in-app browser was used against the live Dify workflow editor and the official Base UI documentation before implementation.

## What was worth borrowing

### Dify

- A workflow node exposes contextual add controls at connection points instead of making drag-and-drop the only path.
- The Inspector separates configuration from the last execution, so authoring and debugging remain adjacent without being mixed.
- Searchable node selection shows a short purpose statement and valid next steps.
- Save state, readiness, preview, and publishing are visible at the workspace level.

Harnest adopts contextual insertion, Settings / Last run, automatic save/validation status, and a compact global progress rail. It does not copy Dify's generic automation catalog or visual styling. Harnest still treats typed ports, policies, tests, permissions, trace events, and a portable HarnessSpec as the product boundary.

### Base UI

The official [Popover](https://base-ui.com/react/components/popover), [Tabs](https://base-ui.com/react/components/tabs), and [Menu](https://base-ui.com/react/components/menu) contracts were reviewed. Base UI provides focus management, keyboard navigation, portal positioning, collision handling, and state attributes without imposing a visual brand.

Harnest uses Base UI for the typed-port picker and Inspector tabs, then applies one Harnest token/state system. Native form controls remain preferable where they already provide the correct behavior.

## Deliberate product difference

The strongest differentiator is the **Portable Integration Contract**. One HarnessSpec now produces a stable, secret-free description of:

- graphs, components, and entrypoint;
- Provider and Tool dependencies by reusable Connection ID;
- real capabilities such as web search, MCP, file attachments, isolated code, memory, evaluation, and artifacts;
- tests, output boundary, timeout/retry/token/cost policy;
- SDK, CLI, HTTP, and MCP integration surfaces.

The same Core function is consumed by Studio, `harnest contract`, the SDK, `GET /contract`, and the MCP `describe_harness` Tool. This makes Harnest closer to “Supabase for agent harnesses”: design once, verify once, integrate through several production surfaces without rewriting the agent.

## Choices intentionally rejected

- A free-form automation canvas with untyped connections: it would weaken deterministic validation.
- A provider-specific Gemini Search shortcut: Firecrawl, SearXNG, HTTP, and MCP remain first-class reusable Connections.
- A pretend universal prompt cache: bounded replay is guaranteed, Provider cache hits are not.
- A browser-side code executor: selected files run only through the declared, approved container Code Runner.
- A large custom component library: Base UI plus native controls covers the accessibility-critical primitives.
