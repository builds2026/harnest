# @harnestai/cli

CLI, loopback HTTP/SSE runtime, and authoring MCP surface for Harnest.

```sh
npm run harnest -- validate harnest.yaml
npm run harnest -- serve harnest.yaml -- --port 8787
```

## Authoring MCP

`harnest mcp serve [workspace]` exposes bundled authoring documentation, generated component and Tool catalogs, the HarnessSpec schema, the `design_harness` prompt, and the read-only `validate_harness_project` Tool. It performs static, secret-free validation only. It does not expose a completed Harness as an MCP Tool and never runs models, Tools, adapters, modules, tests, or deployment steps. This is a migration from the former runtime-serving MCP surface; use `harnest run`, the SDK, or `harnest serve` to execute a completed Harness.

Source checkout, after `npm install && npm run build:packages`:

```bash
node /absolute/path/to/harnest/packages/cli/dist/index.js \
  mcp serve /absolute/path/to/harness-project
```

Local Streamable HTTP binds to loopback by default and serves MCP only at the exact origin-form request-target `/mcp`; health checks use the exact target `/health`. Query strings, fragments, absolute-form targets, network-path targets, and normalized path variants are rejected rather than routed to either endpoint.

```bash
node /absolute/path/to/harnest/packages/cli/dist/index.js \
  mcp serve /absolute/path/to/harness-project \
  --transport http --host 127.0.0.1 --port 8790
```

After `0.2.0-beta.2` is published, the equivalent package command will be:

```bash
npx --yes @harnestai/cli@0.2.0-beta.2 mcp serve /absolute/path/to/harness-project
```

The registry currently contains only `0.2.0-beta.1`; it is not the current authoring MCP documented here. Use the source checkout until `0.2.0-beta.2` is published.

ChatGPT web requires a remotely reachable HTTPS Streamable HTTP endpoint such as `https://mcp.example.com/mcp`; it cannot reach the loopback listener. Harnest does not deploy that endpoint or provide its production TLS, authentication, authorization, tenant isolation, or secret management. Keep Harnest behind a controlled, authenticating edge, scope each server to the narrowest workspace, and let the user configure the names returned in `setupRequired` after validation. `--allowed-host` mitigates DNS-rebinding/Host-header attacks. Browser requests with an `Origin` header must match a repeatable hostname-only `--allowed-origin`; server clients without `Origin` pass that check. Neither allowlist authenticates callers.

See the [complete Claude Code, Codex, `config.toml`, and ChatGPT web connection guide](./mcp-docs/integration.md).

`POST /v1/runs` accepts `Idempotency-Key`. A repeated key returns the original
run ID, including after a server restart. Persisted snapshots and SSE history
remain readable after restart; a paused run must be explicitly recovered with
`POST /v1/runs` using `resumeRunId` plus the original safe context before its
commands endpoint accepts control requests. Recovery uses a new idempotency
key; retrying the original key only returns its original run ID.

`GET /v1/runs/:id/snapshot` returns `{ snapshot, active }`. Resume only when
the snapshot is paused and `active` is `false`.
