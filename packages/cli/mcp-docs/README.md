# Harnest authoring guide

Harnest is an Agent Harness IDE and runtime. A Harness is a portable, declarative graph in `harnest.yaml`: model calls, prompts, agents, context, Tools, MCP actions, Skills, teams, tests, policies, and output behavior are designed together and checked before an application uses them.

This documentation is for an MCP client that edits a Harnest project. Use the server's live component catalog for exact component types, ports, and config schemas; those details are generated from the installed runtime and are intentionally not duplicated here.

## Safe authoring loop

1. Read this overview, [HarnessSpec v0.3](harnest://docs/harness-spec), and the relevant feature guide.
2. Inspect the target project. Preserve its existing behavior and local conventions.
3. Edit the smallest coherent set of project files. Never put credentials in YAML, prompts, tests, assets, traces, or source control.
4. Run the MCP validation Tool on the project folder. Fix every error and review warnings.
5. If credentials are available, the user may separately exercise providers and external Tools. Structural validation does not claim that an unconfigured external service works.

Validation is the finish line for this authoring server. It does **not** execute a Harness, deploy, publish, provision infrastructure, create provider accounts, or collect secrets. A successful result can contain `setupRequired` names for environment variables, Connections, adapters, and modules. The user supplies those provider keys, OAuth grants, endpoints, and production host-provider settings later, after the structure is safe and valid.

## Project map

```text
my-harness/
├── harnest.yaml                 # canonical HarnessSpec
├── assets/                      # bundle assets; never credentials
├── .env.example                 # variable names and safe placeholders only
└── .harnest/
    ├── project.json             # portable asset bindings
    ├── prompts/                 # optional prompt text
    ├── context/                 # optional portable context
    ├── schemas/                 # optional JSON schemas
    ├── tests/                   # optional external test definitions
    ├── tools/                   # reviewed Tool manifests/modules
    ├── skills/<name>/SKILL.md   # Agent Skills
    └── config/                  # non-secret portable configuration
```

Only paths selected by `.harnest/project.json` are portable. Connections, credentials, permissions, runs, traces, and caches also use local `.harnest` state but are never portable assets and must not be hand-authored. Avoid absolute paths, `..` traversal, symlinks, generated build output, and machine-specific state.

## Documentation index

- [Quickstart](harnest://docs/quickstart)
- [HarnessSpec v0.3](harnest://docs/harness-spec)
- [Graph and runtime](harnest://docs/graphs-runtime)
- [Tools, MCP, Skills, and Connections](harnest://docs/tools-connections-skills)
- [Context, Memory, PKM, and providers](harnest://docs/context-memory-pkm)
- [Interactions and permissions](harnest://docs/interactions-permissions)
- [Tests and evaluation](harnest://docs/tests-evaluation)
- [Project assets, secrets, and security](harnest://docs/project-security)
- [MCP client integration](harnest://docs/integration)
- [Recipes](harnest://docs/recipes)
- [Diagnostics](harnest://docs/diagnostics)
