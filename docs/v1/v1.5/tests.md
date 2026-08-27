# v1.5 verification

## Required gates

Run from `/home/louis/Documents/Harnest_root/harnest`:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
uv run --project python --extra test pytest -q
uv build --project python
```

Run from `/home/louis/Documents/Harnest_root/nextjs_ai`:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:db
```

Release verification additionally packs every public npm workspace, installs the tarballs together in an empty project, installs the Python wheel in an empty virtual environment, and executes the same protocol golden fixture through both clients.

## Verified on 2026-08-27

- Harnest: lint, typecheck, 64/64 unit/integration test files with 393/393 tests, the 33-route Studio production build, and both Studio browser suites passed.
- Studio: 26/26 browser journeys and the real-runtime permission/file-reuse journey passed. Builder, Playground, Runs, Integrate, and Settings were also audited at their live remote URL in light and dark mode; the 1024px Playground had no horizontal overflow, console error, or page error.
- Python SDK: 4/4 tests passed; wheel and source distribution built successfully.
- Container isolation: the real Docker Code Runner smoke passed with network disabled, bounded resources, stdout `5050`, and one verified `result.json` artifact.
- Reference host: lint, typecheck, 46/46 tests, the 16-route production build, the browser E2E journey through local Supabase, and all 8 local Supabase RLS assertions passed.
- Reference-host live stack: five durable runs covered `allow_once`, `allow_for_run`, `allow_always`, persistent reuse, revoke, and `deny`; all five reached `succeeded`. Memory and PKM provenance were present in every answer, allowed calls executed the Tool, and the denied call did not.
- Registry publication and operator-credentialed Gemini, remote Supabase, and OAuth/Firecrawl smoke tests were not attempted; they remain in `remaining-issues.md`.

## Verified on 2026-08-26

- Harnest: lint, typecheck, 322/322 unit and integration tests, and production build passed.
- Studio: 7/7 browser journeys and the real-runtime permission/file-reuse journey passed.
- Reference host: lint, typecheck, 29/29 tests, and production build passed.
- Release artifacts: all nine npm tarballs, clean imports, CLI and installed Studio smoke, browser bundle, TypeScript runtime fixture, Python 4/4 tests, wheel/sdist allowlists, and sync/async runtime fixtures passed.
- No npm or PyPI publication was attempted. Credentialed live checks remain listed in `remaining-issues.md`.

## Regression coverage

- six Interaction kinds; submit, decline, cancel, expiry, stale digest, and duplicate response
- crash-safe pause/resume, standalone Interaction resume, and unknown external Tool completion recovery
- independent Team progress while another task waits
- `allow_once`, `allow_for_run`, `allow_always`, and `deny` across runtime, Studio, CLI, HTTP, TypeScript, and Python
- SSE heartbeat, reconnect cursor, deduplication, additive fields, and incompatible protocol major
- external Conversation/Memory/PKM pagination and revisions, adaptive context, cache invalidation, and citation-label validation
- public snapshot/event redaction and cross-run Connection isolation
- Playground attachment reuse and persistent grant revocation
- reference-app ownership, lease/reconnect, provider bridge, file digest, and RLS policy tests
- authoring MCP resource/prompt discovery, `validate_harness_project` structured diagnostics and `setupRequired`, workspace/symlink containment, stdio and Streamable HTTP `/mcp`, and the absence of runtime invocation Tools

## Live smoke tests

Local Supabase RLS, deterministic Memory/PKM, permission, streaming transport, image reuse, and real Docker isolation are verified above. Live Gemini, OAuth, Firecrawl/SearXNG, and a remote Supabase project still require operator-owned credentials or services. A passing build is not recorded as a substitute for those checks; their exact status belongs in `remaining-issues.md`.
