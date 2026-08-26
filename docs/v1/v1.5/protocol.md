# Runtime and Human Interaction Protocol v1

`@harnestai/protocol` is the browser-safe wire contract. It contains schemas and types only and has no runtime, database, filesystem, or authentication dependency.

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/capabilities` | Protocol version and supported interaction/event features |
| `POST` | `/v1/runs` | Start a run and return its ID and resource URLs |
| `GET` | `/v1/runs/:id/events` | Reconnectable SSE stream (`after` or `Last-Event-ID`) |
| `GET` | `/v1/runs/:id/snapshot` | Current durable run state |
| `POST` | `/v1/runs/:id/commands` | Message, directive, plan patch, interaction response, or cancel |
| `DELETE` | `/v1/runs/:id` | Cancel a run |

Every SSE event uses `id: <sequence>`, `event: <type>`, and one JSON `data` envelope:

```json
{
  "protocolVersion": "1.0",
  "eventId": "evt_42",
  "runId": "run_1",
  "sequence": 42,
  "time": "2026-08-25T12:00:00.000Z",
  "type": "interaction.requested",
  "data": {}
}
```

Consumers reject an unsupported major version, ignore unknown additive fields, deduplicate by `(runId, sequence)`, and reconnect from the last committed sequence. Mutation commands carry a stable command ID so retries are safe.

## Interaction

Canonical kinds are `select`, `input`, `form`, `file`, `oauth`, and `permission`. Responses use `submit`, `decline`, or `cancel`. Permission responses additionally choose `allow_once`, `allow_for_run`, `allow_always`, or `deny`.

- `form` supports the bounded primitive JSON Schema subset published by the package.
- `file` returns an external reference, MIME type, size, and digest, never bytes.
- `oauth` returns an app-owned connection reference, never an access token.
- The response must echo the request's checkpoint digest. Stale or duplicate resolutions do not advance execution.
- Trace events retain request metadata and resolution outcome but redact response values and `contextRef`.

## Pause and resume

The runtime persists `interaction.requested` and the matching snapshot before waiting. A snapshot records pending interactions, run grants, processed interaction and command IDs, model-turn checkpoints, and completed work. Independent Team tasks may continue. When no runnable work remains, status is `paused`; resolving or cancelling the last blocking interaction returns it to `running`.

After process recovery, completed model/tool outputs are reused. A tool whose external side effect cannot be proven complete is not called again; the host receives a recovery interaction instead.

## Compatibility

`/api/runs`, NDJSON streaming, and embedded `stream()`/`invoke()` remain wrappers for one release. Legacy permission values `once` and `always` are accepted only at the compatibility edge and normalize to `allow_once` and `allow_always`.
