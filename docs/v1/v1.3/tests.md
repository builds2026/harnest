# v1.3 verification report

Verification date: 2026-08-24.

## Automated checks

| Check | Result |
| --- | --- |
| Studio TypeScript typecheck | PASS |
| Package project build | PASS |
| Studio document/history/typed-port tests | PASS |
| Playground upload/store/file route tests | PASS |
| Core Integration Contract test | PASS, including secret non-disclosure |
| SDK contract/invoke test | PASS |
| CLI contract, HTTP `/contract`, MCP `describe_harness` integration | PASS |

The final repository-wide commands are:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## In-app browser checks

- Loaded the real Studio from the local Next host and inspected its accessibility tree.
- Verified collapsed catalog/workbench, Builder/Playground/Integrate navigation, and light/dark themes.
- Selected an Agent and confirmed keyboard tabs expose Settings and Last run.
- Opened `agent.context` from its contextual port, verified the searchable compatible picker, created Context + edge in one action, and confirmed undo enabled.
- Used undo, waited for automatic save/validation, and confirmed the graph returned to 4 components / 3 connections.
- Verified terminal Output no longer exposes an invalid outgoing add action.
- Inspected Integrate in both themes; its graph, tests, Connections, capabilities, blockers, and snippets came from the current HarnessSpec.
- Verified the Canvas catalog opens from `+ Add`, can be closed, and retains search/category/favorites/drag workflows.

## Security regression coverage retained

Existing tests still cover same-origin mutation, bounded request bodies, upload Content-Length, Range/CSP file serving, path canonicalization, selected-file staging, container mount arguments, output scanning, connection secret DTOs, Tool approval, provider ingress bounds, and trace redaction.
