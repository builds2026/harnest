# harnestai

Remote-only sync and async Python client for the Harnest Runtime Protocol v1.

```python
from harnestai import HarnestClient

client = HarnestClient("http://127.0.0.1:8787")
context = {"contextRef": "ctx_opaque"}
run = client.create("Hello", context=context, idempotency_key="job-attempt-1")
for event in client.events(run.run_id):
    print(event.type, event.data)
```

After a paused worker restart, call `create` with `resume_run_id`, the original
input, and the original context before resending a command. The server returns
`RUN_RECOVERY_REQUIRED` rather than resuming without host context.
Use a new idempotency key for recovery; the original key remains a lookup for
the original create attempt.

Use `snapshot_state(run_id)` to read both `snapshot` and `active`; the existing
`snapshot(run_id)` method remains snapshot-only.

The Python package does not embed the TypeScript runtime. Product data and
authentication remain owned by the host service.
