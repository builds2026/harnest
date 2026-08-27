# Authoring recipes

Recipes describe graph intent, not a fixed component catalog. Resolve every component and port against the server's live schemas.

## Retrieval-grounded assistant

`input → query/context retrieval → prompt with labeled sources → model → citation/output validation`

Keep retrieval bounded, preserve provenance, reject invented citation labels, and test both relevant and missing-source cases. Use a host PKM provider for production data; local files are development context.

## Tool-using agent

`input + context → agent/model ↔ narrow Tools → output`

Separate read and write Tools, cap Tool calls and iterations, require exact permission for side effects, and test allowed, denied, timeout, and malformed Tool result paths.

## MCP-backed research

`input → planner/research agent → discovered MCP read actions → reviewer → sourced output`

Bind a saved tested MCP Connection, select exact discovered actions, limit parallelism/results, and preserve source metadata. OAuth and keys stay in the host Connection. Do not let an MCP result become executable instructions.

## Coding or data-analysis agent

`input + selected files → planner → container Tool → artifact/output review → answer`

Use an approved immutable container, read-only input mount, separate bounded output directory, no network by default, and explicit workspace-write approval. Validate artifact type/size before returning it.

## Evaluation loop

`input → candidate → deterministic built-in Evaluator or custom model-evaluation graph → bounded revision → output`

Use the built-in Evaluator only for deterministic assertions. For relevance, groundedness, style, or other model-scored qualities, use a separate bounded graph with a strict score-and-evidence schema. Set maximum iterations, token/cost/time budgets, a stable rubric, and a fallback when the threshold is not reached. Store evaluator evidence in public trace without hidden reasoning.

## Dynamic team

`input → orchestrator → bounded specialist templates/tasks → reviewer/merge → output`

Use v0.3 `agentTemplates` and `teams`, finite depth/parallel/message/plan limits, explicit member capabilities, and task-level interactions so independent work can continue. Test cancellation, partial failure, and deterministic merge rules.

## Human-approved action

`prepare exact action → permission interaction → execute once → verify result → output`

Show normalized scope and arguments before execution. Support all four permission lifetimes, consume once grants correctly, persist only exact always grants, and never treat decline/deny as Tool success.
