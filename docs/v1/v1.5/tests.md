# v1.5 verification

## Required gates

Run from `/home/louis/Documents/harnest`:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e:runtime --workspace @harnestai/studio
uv run --project python --extra test pytest -q
uv build --project python
```

Run from `/home/louis/Documents/nextjs_ai`:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Release verification additionally packs every public npm workspace, installs the tarballs together in an empty project, installs the Python wheel in an empty virtual environment, and executes the same protocol golden fixture through both clients.

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

## Live smoke tests

Live Gemini, OAuth, Firecrawl/SearXNG, Supabase RLS, PDF/image, and container tests require operator-owned credentials or services. A passing build is not recorded as a substitute for those checks; their exact status belongs in `remaining-issues.md`.
