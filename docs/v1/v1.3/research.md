# v1.3 product research

Research date: 2026-08-24. The in-app browser was used against the live Dify workflow editor and the official Base UI documentation before implementation.

Primary references: Dify's [workflow quick start](https://docs.dify.ai/en/guides/application-orchestrate/creating-an-application), [workflow implementation](https://github.com/langgenius/dify/blob/main/web/app/components/workflow/index.tsx), [node interaction hook](https://github.com/langgenius/dify/blob/main/web/app/components/workflow/hooks/use-nodes-interactions.ts), [model Provider UI](https://github.com/langgenius/dify/blob/main/web/app/components/header/account-setting/model-provider-page/index.tsx), [model Provider guide](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/creating-new-model-provider), and [plugin extension choices](https://docs.dify.ai/en/develop-plugin/getting-started/choose-plugin-type), plus the [Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx).

## What was worth borrowing

### Dify

- A workflow node exposes contextual add controls at connection points instead of making drag-and-drop the only path.
- The Inspector separates configuration from the last execution, so authoring and debugging remain adjacent without being mixed.
- Searchable node selection groups Nodes, Tools, and reusable snippets, with purpose text and valid next steps.
- Save state, readiness, preview, run history/checklist, and publishing are visible at the workspace level.
- Model Provider setup uses discoverable provider cards, connection status, API-key forms, model selection, and custom endpoints instead of requiring users to edit workflow internals.
- API Access keeps contract documentation, streaming, file upload, and conversation integration close to the application being built.
- Dify's source keeps transient canvas interaction in its workflow store, synchronizes draft/history at interaction boundaries, memoizes heavy panels, and defers optional UI. Those implementation patterns informed Harnest's drag-end commit, stable node presentation cache, grouped diagnostics/trace, and lazy manager loading.

Harnest adopts contextual insertion, Settings / Last run, automatic save/validation status, a compact global progress rail, reusable service cards, guided Provider/custom-endpoint forms, and generated integration recipes. It does not copy Dify's generic automation catalog or visual styling. Harnest still treats typed ports, policies, tests, permissions, trace events, and a portable HarnessSpec as the product boundary.

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
