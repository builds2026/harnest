# Host providers and data ownership

Harnest processes a run. It does not own a product's users, sessions, conversations, messages, files, memories, PKM records, credentials, authentication, database, or rate limits.

## Provider boundary

```ts
interface HostProviders {
  conversation?: ConversationProvider;
  memory?: MemoryProvider;
  cache?: CacheProvider;
  files?: FileProvider;
  connections?: ConnectionProvider;
  permissions?: PermissionProvider;
  runs: RunStore;
}
```

- Conversation reads are cursor- and revision-based. The host writes the final assistant message after a terminal event.
- Memory search/write/delete is namespaced by `user`, `conversation`, or `pkm` and preserves source provenance.
- Cache entries are opaque JSON with namespace, TTL, ETag, and revision-aware keys.
- File and Artifact transfer is streamed through external references; a run never receives an unrestricted host path.
- Connection resolution injects credentials into a bounded outbound operation without returning tokens to browser/runtime state.
- Persistent permissions contain only `allow_always` grants scoped by Harness, Tool, Connection, capability, and optional normalized resource. Run-only grants remain in the snapshot.
- `RunStore.commit` atomically commits an event and checkpoint. `readEvents` and `readSnapshot` support recovery and replay.

## Context assembly

Input allowance derives from the selected model's context window, output reserve, and run budget. The retained order is system/Harness rules, current request, unresolved Tool or Interaction work, durable goal/plan/validation state, recent conversation, then long-term Memory and PKM. Old conversation turns are compressed into the existing structured checkpoint while originals remain in the host Conversation Provider.

Cache identity includes Harness digest, model, Tool schema digest, and Conversation/Memory/PKM revisions. A changed revision invalidates only dependent assembled context. Provider-native prompt caching remains adapter-specific.

Provider results normalize to `ContextSource` records with stable `S1`, `S2`, ... labels. Only labels present in the supplied source set become output citations; invented labels are retained as plain text and flagged in trace.

## Failure contract

Timeout, authentication expiry, rate limiting, and revision conflicts are classified and surfaced to the host without leaking credentials or host database IDs. A provider failure may be retried only when it is marked recoverable and the operation is side-effect free or idempotent.

Studio's local Conversation/File/Cache/Permission/Run adapters are development fixtures. Production services must provide their own ownership and authorization checks before issuing a `contextRef`.
