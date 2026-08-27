# Remaining issues

Only work that cannot be completed safely from the repository is listed here.

## Registry ownership and publication

The repository can build and verify npm tarballs and a Python wheel, but it cannot reserve new names, configure organization policy, or publish without the release owner's npm/PyPI accounts and OIDC configuration. npm already contains `@harnestai/cli@0.2.0-beta.1`; the next external release must use the current prerelease version (`0.2.0-beta.2`). Stable `0.2.0` follows only after clean-install cross-language E2E.

## Credentialed integration checks

The following final smoke checks require credentials or services that are intentionally absent from source control:

- an AI Studio Gemini test key with multimodal and context-cache quota
- a Supabase project with the supplied migration, private Storage, Vault, pgvector, and RLS enabled
- Firecrawl and/or SearXNG, plus an OAuth-capable MCP server

Secrets must be supplied through the documented environment/provider boundary and removed after the check. No test should copy a credential into a HarnessSpec, event, snapshot, trace, browser payload, or cache key.

## Embedded Node ownership boundary

`@harnestai/sdk/node` is an in-process runtime and requires one host-assigned writer per Run. CLI, Studio, and the reference Next.js worker enforce a Run/job lease; a custom multi-process embedded host must provide the same single-writer guarantee. Use the HTTP SDK when several workers can receive the same Run. `FileRunStore` is durable storage, not a distributed scheduler.
