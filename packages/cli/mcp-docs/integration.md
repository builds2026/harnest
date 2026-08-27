# MCP client integration

The Harnest authoring MCP server exposes documentation, generated catalogs, the HarnessSpec schema, the `design_harness` prompt, and one read-only Tool: `validate_harness_project`. It does not edit files or execute a Harness. The connected coding agent uses its own workspace tools to make changes and then asks Harnest to validate them.

`harnest mcp serve [workspace]` now means **authoring and static validation**. This changed from the former runtime-serving MCP surface: the command no longer exposes runtime invocation Tools and does not call models, Tools, adapters, or modules. Run a completed Harness with `harnest run`, the embedded SDK, or the loopback `harnest serve` HTTP API.

## Choose the executable

Harnest requires Node.js 22.15 or newer. Use one of these launch forms in the client examples below.

From a source checkout, install dependencies and build once:

```bash
cd /absolute/path/to/harnest
npm install
npm run build:packages
```

Then use this executable and argument list:

```text
node /absolute/path/to/harnest/packages/cli/dist/index.js mcp serve /absolute/path/to/harness-project
```

The registry currently contains only `@harnestai/cli@0.2.0-beta.1`, not the current `0.2.0-beta.2` implementation documented here. Use the source checkout above. After this release is published, the equivalent package command will be:

```text
npx --yes @harnestai/cli@0.2.0-beta.2 mcp serve /absolute/path/to/harness-project
```

Use the narrowest workspace root that contains the project the agent may validate. Do not use a home directory, repository collection, or filesystem root.

## Claude Code: local stdio

Claude Code's options must precede the server name, and `--` separates the server name from the stdio command.

Source checkout:

```bash
claude mcp add --transport stdio --scope project harnest-authoring -- \
  node /absolute/path/to/harnest/packages/cli/dist/index.js \
  mcp serve /absolute/path/to/harness-project
```

After `0.2.0-beta.2` is published, the package form will be:

```bash
claude mcp add --transport stdio --scope project harnest-authoring -- \
  npx --yes @harnestai/cli@0.2.0-beta.2 mcp serve /absolute/path/to/harness-project
```

Use `claude mcp list` to inspect the saved server and `/mcp` inside Claude Code to check its connection. Project scope writes `.mcp.json` and is appropriate only when the command contains paths that every collaborator can resolve; otherwise use `--scope local` or `--scope user` and keep the machine-specific configuration out of version control.

Official reference: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp).

## Codex: local stdio

Source checkout:

```bash
codex mcp add harnest-authoring -- \
  node /absolute/path/to/harnest/packages/cli/dist/index.js \
  mcp serve /absolute/path/to/harness-project
```

After `0.2.0-beta.2` is published, the package form will be:

```bash
codex mcp add harnest-authoring -- \
  npx --yes @harnestai/cli@0.2.0-beta.2 mcp serve /absolute/path/to/harness-project
```

The source-checkout entry in `~/.codex/config.toml`, or in `.codex/config.toml` for a trusted project, is:

```toml
[mcp_servers.harnest-authoring]
command = "node"
args = [
  "/absolute/path/to/harnest/packages/cli/dist/index.js",
  "mcp",
  "serve",
  "/absolute/path/to/harness-project",
]
```

After `0.2.0-beta.2` is published, the equivalent package entry will be:

```toml
[mcp_servers.harnest-authoring]
command = "npx"
args = ["--yes", "@harnestai/cli@0.2.0-beta.2", "mcp", "serve", "/absolute/path/to/harness-project"]
```

Run `codex mcp list` to inspect configured servers and use `/mcp` in the Codex TUI to see the active connection. Codex CLI, the IDE extension, and the ChatGPT desktop app on the same host share this configuration; ChatGPT **web** does not read it.

Official reference: [Codex Model Context Protocol](https://developers.openai.com/codex/mcp/).

## Loopback Streamable HTTP

For an HTTP-capable client running on the same machine, Harnest can listen on loopback:

```bash
node /absolute/path/to/harnest/packages/cli/dist/index.js \
  mcp serve /absolute/path/to/harness-project \
  --transport http --host 127.0.0.1 --port 8790
```

Connect the local client to `http://127.0.0.1:8790/mcp`. The default host is `127.0.0.1`; plain HTTP is for same-machine development only. A browser-hosted service cannot reach this loopback address.

## ChatGPT web: remote Streamable HTTP

ChatGPT web needs an endpoint it can reach, using MCP Streamable HTTP at a URL that normally ends in `/mcp`. The client URL is therefore:

```text
https://mcp.example.com/mcp
```

Harnest does **not** deploy that URL and its HTTP transport does **not** provide production TLS, OAuth, tenant isolation, or an internet-facing authorization layer. The operator must provide a controlled, authenticating HTTPS edge or a supported secure tunnel, authenticate and authorize callers there, route only `/mcp`, and map each connection to a deliberately bounded workspace. Never expose the Harnest listener directly to the public internet or share one broad workspace across untrusted users.

When a reverse proxy runs on the Harnest host, keep Harnest on loopback and allow the exact browser-visible host that the proxy preserves:

```bash
node /absolute/path/to/harnest/packages/cli/dist/index.js \
  mcp serve /srv/harnest-project \
  --transport http --host 127.0.0.1 --port 8790 \
  --allowed-host mcp.example.com \
  --allowed-origin mcp.example.com
```

`--allowed-host` constrains accepted Host headers to mitigate DNS rebinding. `--allowed-origin` is a separate, exact, repeatable hostname allowlist for browser Origin checks. Server-to-server clients that send no `Origin` header pass the Origin check; when an `Origin` header is present, its hostname must match an explicit `--allowed-origin` value. Supply hostnames only: the SDK guard compares the hostname and ignores the Origin's scheme and port. Neither allowlist authenticates or authorizes callers, so the authenticating HTTPS edge remains mandatory.

If the listener must bind a non-loopback interface, pass that address with `--host` and at least one exact, repeatable `--allowed-host`. Network binding is not deployment: TLS termination, supported client authentication, authorization, rate limits, logging, and workspace isolation remain operator responsibilities.

In ChatGPT web:

1. Enable Developer mode if the account and workspace policy allow it.
2. Open Plugins, select the add (`+`) action, and enter a user-facing name and description.
3. Choose the public endpoint connection method and enter the complete `https://mcp.example.com/mcp` URL, including `/mcp`.
4. Complete the mandatory edge's supported authentication flow.
5. Review the discovered server metadata and `validate_harness_project` Tool before using the connection. If that ChatGPT surface exposes MCP resources or prompts, also confirm the authoring index and `design_harness`; client surfaces do not all expose every MCP capability in the same UI.

Official OpenAI references: [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) and [build an MCP server](https://developers.openai.com/plugins/build/mcp-server).

## Authoring and secret-later workflow

1. Read `harnest://docs/index`, the relevant guides, and the generated component and Tool catalogs.
2. Inspect and edit the target project using the coding client's own filesystem tools.
3. Call `validate_harness_project` with a path inside the configured workspace, or pass `yaml` when the MCP server cannot see the client's filesystem.
4. Repair every error and review warnings. Repeat until `valid` is `true`.
5. Read `setupRequired.environmentVariables`, `setupRequired.connections`, `setupRequired.adapters`, and `setupRequired.modules` from the structured result.
6. Report those names as later user/host setup. Do not invent values, request secret values in chat, edit a real `.env`, create accounts, authenticate services, run the Harness, or deploy anything.

A valid project may still have non-empty `setupRequired` arrays. That means its static contract is valid but runtime setup remains. The user later supplies secret values through the host vault, environment, or Connection/OAuth UI and separately performs credentialed runtime tests.

## Troubleshooting

- **Server disconnected:** run the exact configured command in a terminal. Protocol messages must use stdout; diagnostics must use stderr. With the current unpublished `0.2.0-beta.2`, configure the source-checkout `node .../dist/index.js` command. After publication, if a package runner injects stdout, install the pinned package and configure the resolved `harnest` executable directly.
- **No resources or Tools:** verify that the command is `mcp serve`, not runtime `serve`, and that the client supports the negotiated MCP version.
- **Project denied:** pass the intended absolute workspace path and keep validation targets inside it. Symlink escapes are rejected.
- **ChatGPT cannot connect:** first verify the public HTTPS `/mcp` endpoint and authentication from outside the host. `127.0.0.1` is not reachable from ChatGPT web.
- **Authentication failure:** fix it at the controlled edge and client connection flow. Never paste bearer tokens, OAuth codes, passwords, or client secrets into HarnessSpec or an MCP prompt.
