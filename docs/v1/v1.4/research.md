# v1.4 research

Research date: 2026-08-25. Only primary product documentation and source repositories are used for implementation decisions.

## Dify

- Dify keeps the graph draft as the editing source, sends a unique hash with draft synchronization, and reports hash conflicts rather than silently overwriting another revision. The Harnest save protocol will retain revision/abort handling and add a server-side compare token for project assets. [Draft workflow API](https://github.com/langgenius/dify/blob/main/api/controllers/console/app/workflow.py)
- Node dragging is local during pointer movement; history and draft synchronization occur at the drag-stop boundary. Harnest will keep transient React Flow movement separate from semantic edits and persist layout only after the interaction ends. [Node interaction hook](https://github.com/langgenius/dify/blob/main/web/app/components/workflow/hooks/use-nodes-interactions.ts)
- Dify separates the canvas from interaction, history, draft-sync, selection, panel, and search hooks. Harnest will split responsibilities at domain boundaries while preserving its current reducer and React Flow graph. [Workflow editor](https://github.com/langgenius/dify/blob/main/web/app/components/workflow/index.tsx)
- Provider setup is card-based: install/select, enter only required credentials, test before availability, then show models and credential state. Harnest will expose connection status next to the consuming node and keep custom endpoints in Advanced. [Model Providers](https://docs.dify.ai/en/cloud/use-dify/workspace/model-providers)
- Tools share one catalog but retain explicit types: plugin, OpenAPI, reusable workflow, and MCP. MCP performs connection, authorization, and discovery, with Dynamic Client Registration preferred when supported. Harnest will keep its Tool/Skill/Connection stores but provide one selection flow. [Dify Tools](https://docs.dify.ai/en/cloud/use-dify/workspace/tools)
- Multimodal outputs use typed file metadata and preview URLs, not opaque text. Harnest will introduce typed artifact events and store references, while keeping bytes out of Trace JSON. [Multimodal Tool](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/develop-multimodal-data-processing-tool)

Applied UX principles, not copied visuals:

1. One primary action per empty/error state.
2. Local editing first; explicit synchronization boundaries and visible save state.
3. Connection and credential status where a component consumes them.
4. Progressive disclosure for custom endpoint, raw schemas, and host capabilities.
5. Catalog selection first; identifiers and file paths are generated or selected rather than typed.

## Claude Code

- Permission rules are ordered allow/ask/deny decisions, and sandbox boundaries reduce repeated prompts without bypassing policy. Harnest will preserve exact Harness + Tool + Connection grants and separately authorize workspace scopes. [Permissions](https://code.claude.com/docs/en/permissions), [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- A permission suggestion can become a persistent allow rule only after explicit user choice. Harnest's `once | always | deny` decision remains the common contract for Studio, CLI, SDK, HTTP, and MCP. [Hooks](https://code.claude.com/docs/en/hooks)

## OpenAI Codex and API

- Long-running, tool-heavy work should compact at milestones and preserve completed actions, current assumptions, identifiers, tool outcomes, blockers, and the next goal. Harnest will compact a typed run context rather than truncating arbitrary messages. [OpenAI compaction guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
- Model input may contain text, image, and file items; tool-call counts and truncation are explicit request controls. Harnest will represent session inputs and artifacts as typed references, with adapter capability checks. [Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

## OpenHands

- The UI does not execute actions. A backend owns conversations, settings, secrets, skills, and MCP, while workspaces provide the file/terminal boundary. Harnest will keep browser code free of host paths and secrets; Studio APIs mediate all project access. [Agent Canvas architecture](https://github.com/OpenHands/OpenHands/blob/main/docs/architecture.md)
- Local, container, and remote workspaces share an agent API and event stream. Harnest will use one `RuntimeServices` contract and a project-scoped workspace descriptor across all hosts. [Agent Server overview](https://docs.openhands.dev/sdk/guides/agent-server/overview)
- Container isolation protects the host only when workspace mounts are explicit and narrow. Harnest will mount approved project inputs read-only and a per-run output directory read-write. [OpenHands FAQ](https://docs.openhands.dev/overview/faqs)

## Deliberate differences

- Harnest is not adding Dify Marketplace, Knowledge Base, multi-workspace RBAC, or hosted billing in v1.4.
- Harnest does not treat the Studio database as the runtime source of truth. A portable project remains runnable from CLI/SDK without Studio.
- Harnest does not auto-approve a dangerous tool because it happens to run in a container. Tool intent approval and OS isolation are independent layers.
