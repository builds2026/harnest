# Interactions and permissions

Interactions are durable, typed requests from a Harness, agent, Tool, or MCP server to the host/user. Canonical kinds are `select`, `input`, `form`, `file`, `oauth`, and `permission`; they block one task or the whole run.

## Interaction rules

- Use `select` for a bounded choice and `input` for short non-secret text.
- Use `form` only for the supported bounded primitive JSON Schema subset.
- `file` returns an external reference, MIME type, size, and digest—not file bytes or a host path.
- `oauth` opens a host-controlled URL flow and returns a Connection reference—not an access token.
- Never request API keys, passwords, recovery codes, or OAuth tokens through interaction fields.
- Provide a concise title, the reason, the exact effect of accepting, and a safe decline/cancel path.

Responses are `submit`, `decline`, or `cancel` and echo the checkpoint digest. Stale or duplicate responses do not advance the run. The runtime commits the request and snapshot before waiting, so pending work survives restart.

## Permission choices

| Choice | Scope |
|---|---|
| `allow_once` | This interaction digest and Tool call only |
| `allow_for_run` | Matching calls in the current run |
| `allow_always` | Persistent exact scope, stored by the host |
| `deny` | Do not execute the requested call |

A permission scope binds the Harness, exact Tool, capability (`network`, `process`, or `workspace-write`), optional Connection, and optional normalized resource. It is not a wildcard. A changed Tool, Connection, credential-bearing execution identity, action, or resource must not inherit an old grant.

Persistent storage is for `allow_always`; run grants live in the durable snapshot. `allow_once` is consumed by its call. The user can inspect and revoke persistent grants.

## Design defaults

Read-only deterministic work should still declare its real external capability. Writes, process execution, network access, and workspace mutation require clear permission copy and precise arguments. Destructive or irreversible actions should have a domain-level confirmation in addition to capability approval when the consequence is not obvious.

Trace may show request metadata and resolution outcome, but it must redact submitted values, secrets, OAuth material, and opaque context references.

