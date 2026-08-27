# SDK packages and publishing

## Package surface

- `@harnestai/protocol`: Zod wire schemas, TypeScript types, generated Draft 2020-12 schemas, golden fixtures
- `@harnestai/core`: embedded runtime and provider contracts
- `@harnestai/sdk`: browser/Node HTTP and SSE client
- `@harnestai/sdk/node`: embedded `Harnest.load()` entry point
- `@harnestai/cli`: protocol-based commands
- `@harnestai/adapter-*`: model adapters
- PyPI `harnestai`: sync and async HTTP/SSE clients; no embedded Python runtime

Both remote SDKs expose `create`, `events(after?)`, `snapshot`, `command`, `respond`, `cancel`, and `wait`. They use native `fetch` in TypeScript and `httpx` in Python. The Python SSE parser is intentionally small and validates the same golden protocol fixtures.

## Release checklist

1. Secure the npm organization and configure npm and PyPI OIDC Trusted Publishers. Package-name availability is not treated as ownership.
2. Build and pack every public package with only `dist`, schemas, license, readme, exports, and provenance metadata.
3. Install the npm tarballs and Python wheel into clean temporary projects and run the same reconnect, interaction, cancel, and wait E2E fixture.
4. Verify public package contents, browser imports, Node subpath imports, and protocol-major rejection for both ecosystems.
5. Only after both verification jobs pass and the release owner approves the external change, publish the current workspace prerelease (`0.2.0-beta.2`) under npm `next` and the matching PyPI pre-release, then verify signatures and provenance. `0.2.0-beta.1` already exists in npm and does not contain the current authoring MCP.
6. Promote the identical commit to `0.2.0` and npm `latest` only after the compatibility suite passes.

External publication is a release-owner operation because it reserves public names and changes registry state. Repository automation prepares and validates artifacts but never publishes from an untrusted pull request or local developer credential.
