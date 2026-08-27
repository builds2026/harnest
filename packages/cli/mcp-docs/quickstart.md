# Quickstart

## 1. Establish the contract

Ask what the Harness must accept, what it must return, which external capabilities it needs, and how success is tested. Keep product authentication, user data, credentials, and deployment outside the Harness.

## 2. Create or inspect the project

For a new project, start with `harnest.yaml`. Use `version: "0.3"`, a small root graph, one valid `entrypoint`, and at least one test. For an existing project, read its YAML and referenced project files before changing it.

```yaml
version: "0.3"
components:
  - id: request_prompt
    type: prompt
    config:
      template: "Answer the request clearly: {{input}}"
  - id: primary_model
    type: model
    config:
      adapter: openai
      model: USER_CONFIGURES_MODEL
      connectionId: provider-main
  - id: responder
    type: agent
    config: {}
  - id: answer
    type: output
    config:
      format: text
connections:
  - from: { component: primary_model, port: model }
    to: { component: responder, port: model }
  - from: { component: request_prompt, port: prompt }
    to: { component: responder, port: prompt }
  - from: { component: responder, port: response }
    to: { component: answer, port: value }
entrypoint: answer
tests:
  - id: returns_answer
    input: "Say hello"
    assertion:
      type: includes
      value: "hello"
```

The example illustrates document shape and a valid model-to-agent topology, not an authoritative port/config catalog. Its unresolved `provider-main` reference intentionally demonstrates a structurally valid result with `setupRequired.connections: [provider-main]`. Query the server's live catalog and adapt the graph to the installed components.

## 3. Keep credentials unresolved

Declare a connection reference or an environment variable name where supported. Add the name to `.env.example`, never the value. Use obvious placeholders such as `USER_CONFIGURES_MODEL`; do not invent a working secret or paste one into a test.

## 4. Validate

Call `validate_harness_project` with the project folder. Validation covers YAML/schema parsing, project includes, component configs, graph references and ports, entrypoints, subgraphs, teams, tests, security rules, and declared connection requirements. Treat the returned file paths and JSON-style paths as the source of truth.

Repeat until `valid` is `true`, then inspect the structured `setupRequired.environmentVariables`, `setupRequired.connections`, `setupRequired.adapters`, and `setupRequired.modules` arrays. Non-empty arrays do not make a structurally valid project invalid; they are the explicit secret-later and host-setup handoff.

Repeat until there are no errors. Warnings require an explicit review: either fix them or leave a short, project-local explanation when the trade-off is intentional.

## 5. Hand off

Report:

- files created or changed;
- behavior and test contract;
- validation result and any warnings;
- required connection IDs and environment variable names;
- capabilities that need user approval;
- live checks not performed because credentials/services were absent.

Stop there. Report the unresolved names without asking for their values. Deployment, hosted MCP exposure, account provisioning, secret entry, credentialed runtime tests, and Harness execution belong to the user or application host.
