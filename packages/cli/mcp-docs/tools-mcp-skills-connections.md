# Tools, MCP, Skills, and Connections

These concepts are related but not interchangeable:

- A **Tool** is an action exposed to an agent or graph.
- **MCP** is one transport/protocol through which Tool actions and resources may be discovered.
- A **Skill** is progressively disclosed instruction and optional resources; it may declare Tool and Connection requirements.
- A **Connection** is host-managed, reusable metadata and credential resolution for a provider, MCP server, HTTP API, Tool service, or local runtime.

## Tool design

Give each Tool a narrow action, strict input schema, bounded output, clear side effects, and an honest risk/capability classification. Return structured data rather than prose when downstream nodes consume it. Separate read and write actions. For writes, accept an idempotency key where possible.

Local Tool modules are reviewed executable code. Keep them inside approved project roots, pin their dependencies, avoid shell invocation, and request only necessary capabilities. Validation may prove their structure and import boundary; execution still needs host approval.

## MCP Tools

Prefer a saved MCP Connection and select actions from discovery. Streamable HTTP connections use an exact HTTPS resource (literal-loopback HTTP is allowed for local development), bounded redirects/response sizes, and host-controlled OAuth. Stdio connections must run through the approved container isolation path; raw host stdio is not considered sandboxed and fails closed.

Never place MCP bearer tokens, OAuth codes, client secrets, or authorization headers in `harnest.yaml`. An OAuth interaction returns an app-owned connection reference, not a token.

## Skills

Skills live under project or user `.agents/skills/<name>` or `.harnest/skills/<name>`. A Skill uses `SKILL.md` with name and description frontmatter and can include `scripts/`, `references/`, and `assets/`. Harnest extensions may declare Tool, Connection, and permission requirements.

Keep catalog text short. Load the full body only when activated and individual resources only when needed. Installed provenance is pinned and content-hashed; modified content must be reviewed again. A Skill does not bypass Tool permission checks.

## Connections

Reference stable Connection IDs from components instead of copying endpoints and auth into every graph. Project connections belong to the project; user connections can be reused by that user. The host owns creation, secret storage, testing, OAuth, revoke, and deletion.

Authoring output should list each required Connection with:

- ID and kind;
- intended component/action;
- endpoint or model placeholder if non-secret;
- required environment variable **name**, when applicable;
- needed capability and whether a live protocol probe remains.

Authoring validation that does not read the host Connection store can report Connection IDs named by the HarnessSpec, require a Connection ID for a built-in Tool whose manifest declares compatible kinds, and report those expected kinds. It cannot determine whether a named Connection exists, is connected or available, or actually has a compatible kind. A host validation that reads the Connection store can make those checks; a live provider/model/MCP probe still requires the user's service and credentials and is a distinct result.
