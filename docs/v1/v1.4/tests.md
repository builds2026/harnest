# v1.4 verification

Verification date: 2026-08-25, Ubuntu host, Node 22.23.2, Docker 29.7.2.

| Command | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm test` | 42 files, 243 tests passed in 33.16s on the final run |
| `npm run build` | pass; Next production compile 5.6s, TypeScript 5.3s, 29 routes generated |
| `npm run e2e --workspace @harnestai/studio` | 7/7 passed in 33.6s on the final run |
| `npm run e2e:runtime --workspace @harnestai/studio` | 1/1 passed in 23.7s on the final run |
| `npm run smoke:container` | pass; actual Docker Python returned `5050` and produced a verified JSON Artifact |

## Real runtime checks

- Runtime Playwright starts a real Studio and a real local MCP HTTP server; it does not intercept runtime APIs. It verifies deny, allow once, ask again, always allow, prompt bypass, Settings revoke, and denial after revoke.
- The same test uploads a real PNG, confirms direct multimodal input, reloads the page, and reuses the same stored file in a later message.
- CLI invoked the same real MCP server with exact network and Tool preapproval. Result: `runtime-ok tool=South Korea media=0`, 122ms, 44 total tokens.
- Docker smoke uses the pinned `python:3.12-slim` digest with `--network none`, read-only root, dropped capabilities, bounded resources, and non-root UID. It executed Python, returned `5050`, and collected `result.json` as `harnest-artifact:container-smoke/...`.
- A production build was executed while the real dev Studio remained on port 3000. A fresh browser loaded `Build` with zero HTTP/page errors afterward, proving `.next-build` no longer corrupts live dev chunks.
- `next start` was then launched from the separated build on port 3300 with the real root Harness; a fresh browser reached Builder at network idle with zero HTTP/page errors.

## Regression coverage added

- Structured Loop state merge, invalid completion rejection, and final-answer isolation.
- Long Agent/tool conversation compaction and private Playground checkpoint preservation.
- Capability/resource-scoped permission persistence, CLI/SDK/API listing and revocation, stale approval rejection, and real UI decisions.
- Session file ownership, next-turn/reload reuse, direct media capability selection, and all four adapter media encodings.
- Recipe reset confirmation, version diff/preview/restore with pre-restore preservation, and project asset CRUD/import.
- Manifest-to-Inspector exhaustiveness, v0.1/v0.2 tests, project materialization/bundle, traversal/symlink/secret rejection, live Artifact event order, and safe download headers.
- Three rapid field edits and a 24-step node drag produce one effective save each; stale client/server revisions are ignored.

## Environment-dependent validation

`npm run harnest -- validate . --allow-modules` successfully resolves the portable root project and then reports nine bindings to four missing saved Connections: primary model, fallback model, web search/scrape service, and local runtime. This is expected on this Ubuntu profile because Connection records and credentials are intentionally not committed.

No `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `FIRECRAWL_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` was present, so no hosted Provider success is claimed. The deterministic adapter is used only as an E2E model fixture; Tool transport, approval storage, files, Studio APIs, Core runtime, and Docker execution are real.
