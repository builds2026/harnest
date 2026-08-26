# @harnestai/sdk

Browser and Node.js HTTP/SSE client for Harnest Runtime Protocol v1.

```ts
import { HarnestClient } from "@harnestai/sdk";

const client = new HarnestClient({ baseUrl: "http://127.0.0.1:8787" });
const context = { contextRef: "ctx_opaque" };
const run = await client.create("Hello", { context, idempotencyKey: "job-attempt-1" });
for await (const event of client.events(run.runId)) console.log(event);
```

If a paused worker restarts, first call `create` with the original input, the
persisted `runId` as `resumeRunId`, and the original context. Snapshot-only
commands return `RUN_RECOVERY_REQUIRED` because opaque host context is never
stored in snapshots. Then resend the interaction response or other command.
Use a new idempotency key for that recovery request; retrying the original key
only looks up its original run ID.

Use `snapshotState(runId)` to read `{ snapshot, active }`. The original
`snapshot(runId)` method remains snapshot-only for compatibility.

Use `@harnestai/sdk/node` only when embedding the TypeScript runtime. An
embedded host must assign one writer to a Run and serialize `resume()` calls;
multi-worker services should use the HTTP client and the host job lease instead
of sharing a `FileRunStore` directly across processes.
