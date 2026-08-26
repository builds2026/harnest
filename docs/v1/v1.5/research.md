# v1.5 research

Research date: 2026-08-25. Only protocol and product principles are adopted; none of the referenced runtimes is added as a dependency.

## Human interaction and durable resume

- [MCP Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) separates bounded form input from URL-based authentication and gives the client explicit `accept`, `decline`, and `cancel` outcomes. Harnest maps this to `InteractionRequest`/`InteractionResponse`; secrets and OAuth tokens are never form values.
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) and [persistence](https://docs.langchain.com/oss/python/langgraph/persistence) establish the important operational rule: persist before pausing and do not repeat pre-interrupt side effects on resume. Harnest applies that rule to its existing `RunSnapshot` and `RunStore` instead of adopting LangGraph.
- [A2A](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) provides useful external status concepts for `input-required` and `auth-required`. Harnest retains its own event vocabulary and provides a deterministic mapping at adapters.

## Language-independent transport

- [WHATWG server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) supplies interoperable `id`, `event`, `data`, heartbeat comments, and `Last-Event-ID` reconnect semantics. The v1 endpoint uses native `ReadableStream` and `fetch`; no SSE dependency is required.
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12) is the published schema format. TypeScript Zod schemas remain the executable source and golden fixtures are also validated by Python models.

## Context, memory, and cache

- Gemini [context caching](https://ai.google.dev/gemini-api/docs/caching), Anthropic [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), and OpenAI [prompt caching](https://openai.com/index/api-prompt-caching/) are provider-specific optimizations. Harnest keeps adapter-native cache hints while its host cache stores only opaque assembled-context entries.
- [Mem0](https://github.com/mem0ai/mem0/blob/main/integrations/mem0-plugin/skills/mem0/references/api-reference.md) demonstrates user-scoped memory APIs, while [Graphiti](https://github.com/getzep/graphiti) demonstrates provenance-aware temporal knowledge. Harnest's `MemoryProvider` accepts namespaces and sources without importing either implementation.
- [Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search) combines full-text and vector retrieval. The example service keeps PKM chunks, embeddings, and citations in its own database and exposes only bounded provider results to the worker.

## Product-service boundary and publishing

- Supabase [Vault](https://supabase.com/docs/guides/database/vault) and [Storage access control](https://supabase.com/docs/guides/storage/security/access-control) support app-owned secrets and private object paths. The example service owns Auth, RLS, rate limiting, conversations, files, memory, connections, and product records.
- npm [scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) and [trusted publishing](https://docs.npmjs.com/trusted-publishers/) plus PyPI [Trusted Publishers](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/) define the release path. Registry availability checks do not reserve a name, so no document claims ownership before the first trusted release.
