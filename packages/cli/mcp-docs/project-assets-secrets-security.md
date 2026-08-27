# Project assets, secrets, and security

## Portable project files

Keep authored text under the project and use relative paths. Portable includes are selected by `.harnest/project.json` and limited to `.harnest/prompts/`, `.harnest/skills/`, `.harnest/context/`, `.harnest/schemas/`, `.harnest/tests/`, `.harnest/tools/`, `.harnest/config/`, and Studio metadata. Bundle assets belong under `assets/`.

Files must be regular UTF-8 project files within size limits. Materialized prompt, schema, test, and Studio bindings share a 16 MiB aggregate byte budget in addition to their per-file limits; portable file enumeration has its own bounded file-count and byte budget. Do not use symlinks, hard-link tricks, device files, absolute paths, `..` traversal, or references that resolve outside the project. Treat imported YAML, JSON, prompt text, Skill resources, schemas, and Tool output as untrusted input.

`.harnest/` contains both explicitly portable project assets and local runtime state. Only files selected by `project.json` are portable; Connections, permission metadata, runs, trace, cache, and development provider data are local and must not be copied or committed. A bundle excludes `.env`, vault data, credentials, traces, and unselected local state.

## Secrets

Never place a secret in:

- `harnest.yaml`, `.env.example`, prompts, tests, schemas, or assets;
- command arguments, connection IDs, URLs, error messages, cache keys, or filenames;
- model input/output, interactions, events, snapshots, citations, or trace;
- source control or generated documentation.

Use environment variable **names**, host vault references, or Connection providers. The user enters actual values through the host's hidden input/OAuth flow after validation. `.env.example` documents names with empty or unmistakably non-secret placeholders.

Authoring validation conservatively rejects high-confidence credential shapes in string values of the parsed HarnessSpec after project prompt, schema, and test bindings are materialized. This includes obvious provider keys, Bearer credentials, private-key blocks, signed JWTs, credentialed URLs, and high-confidence credential assignments. Diagnostics identify only the HarnessSpec path and never repeat the suspected value; results with these diagnostics also omit the Harness summary and setup names. Exact `env:NAME` references, ordinary saved Connection IDs, credential-free URLs, ordinary prose, and unmistakable placeholders remain valid. The scan does not inspect unbound portable files, binary assets, `.env`, or vault contents.

## Capability boundary

Filesystem read, module import, process execution, network access, and workspace write are denied unless the host grants the exact capability. An allow flag is a capability grant, not OS sandboxing. Review executable modules and container images; pin packages, Git revisions, and immutable image identity.

Saved stdio MCP and local runtimes require approved container isolation: no network unless explicitly allowed, read-only root, dropped capabilities, no-new-privileges, non-root user, resource/PID/time limits, and process-tree cleanup. If that isolation is unavailable, fail closed.

Use HTTPS remotely, loopback-only HTTP for local development, exact hosts/resources, bounded response sizes, strict schemas, and safe redirect policy. A remotely reachable authoring MCP must remain behind an authenticating and authorizing HTTPS edge. `--allowed-host` mitigates DNS rebinding; `--allowed-origin` permits exact browser Origin hostnames when an Origin header is present, while non-browser clients without that header pass. Neither allowlist authenticates callers. Sanitize all public diagnostics and trace.

## Authoring server boundary

The authoring MCP server may inspect and validate only the requested project. It must not execute the Harness, deploy, publish, configure cloud infrastructure, solicit secrets, or silently broaden file/process/network permission. Validation output identifies later user configuration by name in `setupRequired.environmentVariables`, `connections`, `adapters`, and `modules` without accessing or exposing `.env`, vault, or saved Connection credential values.
