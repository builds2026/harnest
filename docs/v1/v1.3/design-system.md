# v1.3 Studio design system

## Product subject and signature

The subject is a developer designing, verifying, and integrating a portable AI agent harness. The UI therefore behaves like a calm verification workspace, not a dashboard template or a generic no-code automation tool.

Its signature is a continuous **Design → Verify → Integrate** path:

- the header reports Recipe, Services, Ready, and Result;
- the Canvas offers typed next actions at the exact port;
- the workbench opens only when tests, comparison, activity, or YAML are needed;
- Integrate renders the production contract and blockers from the same spec.
- Settings groups workspace appearance, reusable services, extensions, and runtime boundaries without duplicating their existing managers.

This relationship is specific to Harnest and would not make sense on a generic admin dashboard.

## Tokens

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#f4f6f9` | `#0f1116` |
| Surface | `#ffffff` | `#1b1f27` |
| Ink | `#17191f` | `#f3f5f8` |
| Muted | `#687180` | `#9ba5b4` |
| Signal | `#5b5bd6` | `#8585ff` |
| Verified | `#0f8f6f` | `#3bc99a` |
| Fault | `#d0443e` | `#ff7169` |

Body and display text use system `Segoe UI Variable` / `Aptos`; identifiers, ports, trace metadata, and code use `Cascadia Code`. No network font is required.

## Interaction rules

- Primary Canvas insertion is the port `+`; the collapsible catalog is the secondary power-user path.
- Port actions appear on hover and keyboard focus. Base UI traps and restores focus, closes on Escape, and positions the picker within the viewport.
- Exact port types sort before wildcard `any` matches. A full input or terminal entrypoint exposes no invalid add action.
- Structural changes are atomic and support 100-step undo/redo. A complete drag is one history item.
- The Inspector shows common fields first. Advanced policy/schema/provider details remain collapsed.
- The bottom workbench is 38 px when idle and opens when a tab or workflow action needs it.
- Status text never relies on color alone; error, ready, running, save, and validation states have labels.

## Responsive and motion behavior

At desktop widths, Canvas and Inspector remain visible while the catalog is optional. Below 900 px, the grid becomes a vertical flow; Playground history/files collapse away from the primary conversation. Integrate collapses from two columns to one and its metrics from four to two to one. Settings becomes a full-height sheet whose section navigation remains reachable as horizontal tabs. Controls keep native keyboard semantics and visible focus rings.

All nonessential transitions are disabled by `prefers-reduced-motion`. Motion is limited to short menu/tab/hover feedback and does not encode required information.
