# Graph and runtime

## Execution model

A Harness is a directed component graph. The `entrypoint` receives run input, connections route typed values between ports, and output components define the public result. Conditional edges, projections, and state writes express control flow without hiding logic in prompts.

Design in this order:

1. define public input and output;
2. place deterministic transforms and context retrieval;
3. add model/agent decisions;
4. attach Tools or subgraphs only where needed;
5. add failure policy, limits, and assertions;
6. validate the root graph and every subgraph.

Prefer an explicit, shallow graph. Use subgraphs for a behavior with a stable boundary, not merely to reduce the number of visible nodes.

## Routing and state

- `select` is a JSON Pointer projection from the source value.
- `condition` reads the current value, graph state, or original input.
- `state.key` stores a value for later conditional/state consumers; `append` accumulates and `replace` is the default.
- Every referenced component and port must exist in the same graph unless a component type explicitly bridges a subgraph.
- Avoid unbounded cycles. Agent/tool loops need iteration, Tool-call, token, cost, and time ceilings.

## Failure and budget policy

Set the broad run ceiling in `runtime`, and narrower component policy only where it differs. Retry only transient, safely repeatable work. Do not retry a side effect unless the Tool declares idempotency or the operation carries a stable idempotency key.

Budgets are hard product behavior, not decoration. Choose a token/cost allowance compatible with the selected model and reserve room for the final answer. `context.overflow: compact` allows structured compaction; `error` fails instead of silently dropping required context.

## Durable runs

The runtime emits public events, commits snapshots, and can pause for interactions. A recovered run reuses completed model/Tool work. If completion of an external side effect is uncertain, it asks the host/user instead of executing it again.

HTTP v1 clients create a run, consume reconnectable SSE events, inspect snapshots, and submit idempotent commands. A paused snapshot must be explicitly resumed with its original safe context. The embedded SDK, CLI, Studio, and HTTP runtime share the same Core semantics. The authoring MCP is separate: it documents and statically validates projects but does not create or control runs.

## Studio metadata

`studio` stores positions, pinned nodes, viewport, and layout direction (`RIGHT` or `DOWN`) for the root and subgraphs. It is safe to omit. Never encode execution order using coordinates; connections and component semantics are the only source of runtime order.
