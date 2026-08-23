# v1.3 implementation report

## Requirement evidence

| Requirement | Implementation |
| --- | --- |
| Contextual Canvas insertion | Every available input/output port derives options with `compatiblePortInsertions()`. The Base UI Popover searches only connections accepted by Core validation; selection adds one node and edge atomically. Terminal entrypoints and full fan-in ports expose no invalid action. |
| Keyboard, errors, undo/redo | Popover focus/Escape behavior comes from Base UI. Connection validation errors go to the live Studio status. Canvas changes support toolbar buttons and Ctrl/⌘ Z, Ctrl/⌘ Shift Z, or Ctrl/⌘ Y. Drag updates are coalesced into one history entry. |
| Reduced drag-and-drop dependence | The component catalog is collapsed by default and opened from `+ Add`. Drag-and-drop remains available as a secondary workflow. |
| Dify-inspired Inspector | Common settings remain visible; detailed policy/schema fields use Advanced disclosure. Settings and actual Last run data are keyboard-navigable Base UI tabs. |
| Shared design system | Canvas, Inspector, Header, catalog, workbench, Playground, and Integrate use common surface/state/type tokens. Light/dark themes persist locally and honor reduced motion. |
| Workflow completion | Recipes, reusable Connections, automatic save/validation, tests, A/B Compare, persisted Activity, YAML import/export, Playground, and recovery states remain wired to existing runtime APIs. |
| Differentiation | Core `describeHarness()` creates the secret-free Portable Integration Contract. It is exposed through Studio, CLI, SDK, HTTP, and MCP. |
| Compatibility | `specToDraft()` / `draftToSpec()` remain the single Canvas/YAML round trip. v0.1 upgrades only when a v0.2 component or edge feature requires it. Existing runtime behavior is unchanged. |

## File upload and Code Runner

This is a real runtime path, not a UI placeholder:

1. Playground accepts bounded multipart uploads only when the saved graph declares an enabled `builtin.code-runner` with an approved local-runtime Connection.
2. A run includes only explicitly selected file IDs.
3. The session store copies those files into a run workspace inside the project and mounts it at `/mnt/data` read-only.
4. The approved Docker/Podman runner has a read-only root, no network, dropped capabilities, a non-root user, and bounded resources.
5. Files written below `/mnt/output` are scanned with depth/count/size/link limits, indexed as artifacts, and returned for safe preview or download.

Limits remain one file 64 MiB, session 100 files / 256 MiB, and one run 32 selected files. HTML/SVG are never rendered as executable previews.

## Conversation and cost boundary

Playground sessions persist project-locally for 30 inactive days. Provider replay is bounded to the latest 20 messages and 64 KiB, so prior conversation does not grow without limit. This is deterministic context bounding, not a claim that every Provider supplied a cache discount. Provider-native implicit/explicit caching remains adapter/provider-specific.

## Integration Contract surfaces

```bash
harnest contract harnest.yaml --json
harnest serve harnest.yaml        # GET /contract
harnest mcp serve harnest.yaml    # describe_harness + invoke_harness
```

```ts
const harness = await Harnest.load("harnest.yaml");
console.log(harness.contract);
```

Only allowlisted metadata is emitted. API keys, credentials, headers, arbitrary component config, file paths, and secret values are excluded.
