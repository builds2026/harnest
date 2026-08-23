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
| `harnest validate harnest.yaml` | PASS |
| Root Integration Contract | PASS — 4 components, 3 connections, conversation capability, SDK/CLI/HTTP/MCP surfaces |

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

## Security regression coverage retained

Existing tests still cover same-origin mutation, bounded request bodies, upload Content-Length, Range/CSP file serving, path canonicalization, selected-file staging, container mount arguments, output scanning, connection secret DTOs, Tool approval, provider ingress bounds, and trace redaction.
