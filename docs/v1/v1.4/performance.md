# v1.4 performance evidence

## Save request behavior

The Playwright counter observes actual `PUT /api/spec` requests at the browser boundary.

| Interaction | Transient events | Save requests during interaction | Final effective saves |
|---|---:|---:|---:|
| Three immediate textarea replacements | 3 semantic edits | 0 before debounce | 1 |
| Node drag with 24 pointer movement steps | 24 movement steps | 0 | 1 after drag stop/debounce |
| 1.4s idle after either save | 0 | 0 duplicates | unchanged |

Semantic edits wait 850ms; layout commits wait 1,200ms. An unchanged serialized Harness is acknowledged locally without a request. A newer edit aborts the active client request, while the server queue rejects older `clientRevision` values and avoids writing identical YAML.

## Runtime/build measurements

- Real local MCP CLI run: 122ms, 44 total deterministic-fixture tokens.
- Real runtime browser E2E: 23.7s on the final run for seven runs, four explicit decisions, persistent bypass, one upload, one reload, and Settings revocation.
- Studio presentation E2E: 33.6s on the final run for seven end-to-end UX scenarios.
- Full Vitest suite: 33.16s for 243 tests on the final run.
- First separated production build: compile 7.7s, TypeScript 5.9s, static route generation 659ms; warm rebuild: 0.9s compile and 1.9s TypeScript.
- Actual Docker Code Runner smoke: 1.3s including package build check, container launch, execution, Artifact hashing, and cleanup on a warm local image.

There is no trustworthy pre-v1.4 frame-time capture in the repository, so a numerical “less than 10% versus old build” claim would be fabricated. The checked-in save-count regression is the stable baseline for future releases; large-graph frame timing is listed as follow-up rather than inferred.
