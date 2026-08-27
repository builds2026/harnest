# Harnest v1.5

Status: implementation and local verification complete; credentialed integration and registry publication pending
Baseline: v1.4 plus the v0.3 dynamic-Team, durable-run, context-cache, and Studio canvas work present on 2026-08-25

v1.5 makes human input, durable pause/resume, remote SDKs, and app-owned context first-class without turning Harnest into a user database or authentication service.

## Documents

- [audit.md](./audit.md) — baseline code/data-flow findings and retained boundaries
- [research.md](./research.md) — primary sources and adopted principles
- [protocol.md](./protocol.md) — Runtime/Event and Human Interaction wire contract
- [providers.md](./providers.md) — external data-provider ownership and context assembly
- [sdk-publishing.md](./sdk-publishing.md) — TypeScript/Python surface and release process
- [nextjs-ai.md](./nextjs-ai.md) — independent reference product architecture and operation
- [design-system.md](./design-system.md) — shared Studio/UI principles, tokens, Base UI boundaries, and verification rules
- [implementation.md](./implementation.md) — delivered files, compatibility, and data flow
- [tests.md](./tests.md) — verification commands and evidence
- [remaining-issues.md](./remaining-issues.md) — verified environment or release blockers only

## Fixed boundary

1. Harnest owns execution, checkpoint, trace, context assembly, and transient run control.
2. A host owns authentication, authorization, product DB, rate limits, users, chats, messages, files, memories, PKM, and connection secrets.
3. The protocol transports opaque references and bounded metadata; it does not transport host credentials or expose host database identifiers.
4. Studio keeps local providers solely as a development/test host.
5. Existing HarnessSpec v0.3, embedded SDK calls, `/api/runs`, and NDJSON remain compatible during the v1 transition.
