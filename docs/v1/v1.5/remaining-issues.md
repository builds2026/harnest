# Remaining issues

Only work that cannot be completed safely from the repository is listed here.

## Stable registry promotion

The `0.2.0-beta.3` npm prerelease, including the authoring MCP, is published. Stable `0.2.0` and npm `latest` promotion remain release-owner actions after clean-install cross-language E2E and any follow-up prerelease fixes.

## Credentialed integration checks

The following final smoke checks require credentials or services that are intentionally absent from source control:

- an AI Studio Gemini test key with multimodal and context-cache quota
- a Supabase project with the supplied migration, private Storage, Vault, pgvector, and RLS enabled
- hosted Firecrawl or remote SearXNG, plus an OAuth-capable MCP server; loopback SearXNG is verified

Secrets must be supplied through the documented environment/provider boundary and removed after the check. No test should copy a credential into a HarnessSpec, event, snapshot, trace, browser payload, or cache key.

## Embedded Node ownership boundary

`@harnestai/sdk/node` is an in-process runtime and requires one host-assigned writer per Run. CLI, Studio, and the reference Next.js worker enforce a Run/job lease; a custom multi-process embedded host must provide the same single-writer guarantee. Use the HTTP SDK when several workers can receive the same Run. `FileRunStore` is durable storage, not a distributed scheduler.
