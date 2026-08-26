# `nextjs_ai` reference service

The independent app at `/home/louis/Documents/nextjs_ai` demonstrates the production ownership boundary. Next.js authenticates and authorizes every browser request; Supabase owns all product data; a separate Node worker runs Harnest through the protocol and provider bridge.

## UI

- Left: new conversation, search, saved conversations, and running/paused badges
- Center: streaming user/assistant messages, Tool and Agent activity, inline Interaction renderer, and file composer
- Right: Artifact, Files, Memory, PKM Sources, Citations, and Trace tabs
- Mobile: the side regions become Base UI dialogs/drawers without duplicating state

## Data and security

The included SQL defines app-owned conversations, messages, files, artifacts, memories, PKM sources/chunks, citations, run jobs/events/snapshots, persistent permission grants, cache entries, and connection metadata. User-facing tables use RLS and private Storage object paths are owner-prefixed. Vault references hold secrets; access tokens are never inserted into Harnest events or browser payloads.

The Next.js BFF verifies the Supabase session, conversation ownership, file ownership, and rate limit before enqueuing or controlling a run. The worker claims a job with a lease, calls the internal host-provider API with an app-issued opaque `contextRef`, runs the Harness, and commits sequence events and snapshots. Browser SSE is re-emitted by the BFF and can reconnect without direct worker or database access.

## Representative Harness

```text
Classifier
 ├─ direct: multimodal Agent
 ├─ research: Researcher + Web Search + PKM + Reviewer Team
 └─ engineering: Planner + Code Runner + File Tool + Reviewer Team
        ↓
Join → Evaluator → bounded correction Loop → Output
```

Images go to a multimodal adapter first. The sandbox is available only when execution or conversion is required. Firecrawl, SearXNG, and MCP are connection-backed Tools. Long-term Memory writes, OAuth, and dangerous Tools use the shared Interaction/Permission protocol.

## Local operation

Copy `.env.example`, configure the Supabase URL/public key plus server-only service/worker credentials, apply the included migration, and start the web and worker processes. Without Supabase credentials the UI can build and its pure protocol/provider tests run, but no production data or live provider success is claimed.
