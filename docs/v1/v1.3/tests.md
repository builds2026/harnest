# v1.3 verification report

Verification date: 2026-08-24.

## Automated checks

| Check | Result |
| --- | --- |
| `npm test` | PASS — 29 files, 193 passed, 1 skipped |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS — Next production build, 19 pages/routes generated |
| `npm audit` | PASS — 0 vulnerabilities |
| Four checked-in runnable examples | PASS with explicit `--allow-modules` — custom adapter, evaluation loop, MCP Tool agent, and RAG |
| Current root authoring draft | EXPECTED BLOCKED — the user's uncommitted Skill and Loop have empty required values; validation reports four precise diagnostics without modifying the file |
| Root Integration Contract | PASS — parse-safe description of the current draft: 6 components, 5 connections, and SDK/CLI/HTTP/MCP surfaces |

The final repository-wide commands are:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm audit
```

## Live runtime matrix

| Path | Result |
| --- | --- |
| Google AI Studio Gemini | PASS — exact response `HARNEST_E2E_OK` with streamed trace, usage, finish reason, and cost |
| Docker Python Code Runner | PASS — Gemini invoked the Tool and returned `CODE_RUNNER_E2E_OK:338350` |
| File upload and artifact | PASS — multipart upload was staged read-only at `/mnt/data`; Python wrote `/mnt/output/result.txt`; downloaded content was verified byte-for-byte |
| SearXNG web search | PASS — reusable Connection returned 28 raw results; Gemini invoked `builtin.web-search`, consumed 5 results, and cited `https://www.harness.io/` |
| TypeScript SDK | PASS — real invocation returned `SDK_SURFACE_E2E_OK` |
| HTTP streaming | PASS — `/contract` and `run-start` → `text-delta` → `run-end` stream returned `HTTP_STREAM_E2E_OK` |
| MCP stdio | PASS — `describe_harness` and `invoke_harness` returned the contract and `MCP_SURFACE_E2E_OK` |
| Agent Skills catalog | PASS — 46 skills discovered, including 30 Firecrawl skills; one invalid long description surfaced as an actionable warning |

The live checks used temporary sessions, Connections, specifications, and containers. Those resources were removed after verification; the user's saved conversations and HarnessSpec edits were not changed.

## In-app browser checks

- Loaded the real Studio from the local Next host and inspected its accessibility tree.
- Verified collapsed catalog/workbench, Builder/Playground/Integrate navigation, and light/dark themes.
- Selected an Agent and confirmed keyboard tabs expose Settings and Last run.
- Opened `agent.context` from its contextual port, verified the searchable compatible picker, created Context + edge in one action, and confirmed undo enabled.
- Used undo, waited for automatic save/validation, and confirmed the graph returned to 4 components / 3 connections.
- Verified terminal Output no longer exposes an invalid outgoing add action.
- Inspected Integrate in both themes; its graph, tests, Connections, capabilities, blockers, and snippets came from the current HarnessSpec.
- Verified the Canvas catalog opens from `+ Add`, closes with its button or Escape, and retains search/category/favorites/drag workflows.
- Checked Builder, Playground, and Integrate at 390 × 844 and the default desktop viewport. No horizontal overflow remained.
- Checked the rendered surfaces for duplicate IDs, unlabeled visible controls/dialogs, unnamed buttons/links, and images without `alt`; all result sets were empty.

## Builder scale and design-system checks

- Loaded a generated 121-node graph in the real Studio. Warm development reloads were 1,462–1,549 ms; node selection, tab changes, and catalog changes stayed at the browser-control floor of 277–282 ms, matching the six-node baseline.
- Dragged a node in the 121-node graph and confirmed immediate movement, one save request at drag end, one undo/redo history item, and correct position restoration. Adding and undoing a node also synchronized correctly into React Flow's internal store.
- Confirmed viewport culling reduced mounted nodes from 121 at fit-to-view to 54 after zooming. Port compatibility and connection commits remain covered by the passing automated Studio/Core tests.
- Inspected Builder, Playground, Integrate, Settings, Services, custom Tools, and Skills in light/dark themes and at 390 × 844. The visible surfaces had no unintended light-theme leaks, horizontal overflow, inaccessible dialog names, or unnamed controls.
- Verified Settings uses live project state and that its Services, Tools, and Skills actions open the existing managers. Provider setup exposes Google AI Studio and custom endpoints; web search exposes Firecrawl, SearXNG, and the custom contract; MCP exposes browser sign-in and token fallback.

## Security regression coverage retained

Existing tests still cover same-origin mutation, bounded request bodies, upload Content-Length, Range/CSP file serving, path canonicalization, selected-file staging, container mount arguments, output scanning, connection secret DTOs, Tool approval, provider ingress bounds, and trace redaction.
