# @harnestai/cli

CLI and HTTP/SSE worker surface for Harnest.

```sh
npx @harnestai/cli validate harnest.yaml
npx @harnestai/cli serve harnest.yaml --port 8787
```

`POST /v1/runs` accepts `Idempotency-Key`. A repeated key returns the original
run ID, including after a server restart. Persisted snapshots and SSE history
remain readable after restart; a paused run must be explicitly recovered with
`POST /v1/runs` using `resumeRunId` plus the original safe context before its
commands endpoint accepts control requests. Recovery uses a new idempotency
key; retrying the original key only returns its original run ID.

`GET /v1/runs/:id/snapshot` returns `{ snapshot, active }`. Resume only when
the snapshot is paused and `active` is `false`.
