# Context, Memory, PKM, and providers

Harnest executes a run; the host application owns users, sessions, conversations, messages, files, Memory, PKM records, credentials, authorization, database policy, and rate limits.

## Keep the sources distinct

- **Context** is bounded information assembled for the current run: system rules, request, unresolved work, recent conversation, retrieved sources, and attachments.
- **Memory** is durable, user- or conversation-scoped information such as preferences or prior decisions.
- **PKM** is provenance-bearing personal/project knowledge retrieved from documents or knowledge stores.
- **Cache** is an optimization and must never become the authoritative copy of product data.

Do not emulate production ownership by writing user data into the Harness project. Studio's local providers are development fixtures only.

## Host provider boundary

A production host can supply Conversation, Memory, Cache, File, Connection, Permission, and RunStore providers. The application authenticates the user and issues an opaque `contextRef`; Harnest resolves bounded data through the provider bridge. Host paths, database IDs, access tokens, and the opaque reference are not model-visible or copied into public trace.

Memory operations use an explicit namespace (`user`, `conversation`, or `pkm`) and preserve provenance. File transfer uses an external reference with MIME type, size, and digest, never an unrestricted filesystem path. Connection providers inject credentials only into a bounded outbound operation.

## Context assembly and citations

Retention priority is:

1. system and Harness rules;
2. current request;
3. unresolved Tool/interaction work;
4. durable goal, plan, validation, and checkpoints;
5. recent conversation;
6. long-term Memory and PKM.

Older turns may be compacted, while originals stay with the host Conversation provider. Retrieved sources receive stable labels such as `S1`; only supplied labels are valid citations. Preserve source ID, title, URI when safe, document/page/chunk location, retrieval time, and revision.

Cache identity includes the Harness digest, model, Tool schema digest, and Conversation/Memory/PKM revisions. A changed revision invalidates dependent assembled context. Provider-native prompt caching remains adapter-specific.

## Authoring guidance

Declare provider-backed context/memory components and their safe namespace/query behavior, then leave tenant credentials and concrete records to the host. Tests should use deterministic fixtures or fakes. Never claim a production Memory/PKM integration from a local fixture or a build-only check.

