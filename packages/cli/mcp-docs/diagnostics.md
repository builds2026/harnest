# Diagnostics

Validation diagnostics identify a severity, stable code, JSON-style path, message, and sometimes a component ID and remediation hint. Fix the root cause at the referenced project file; do not suppress or rewrite diagnostics merely to make validation green.

## Triage order

1. YAML parsing and duplicate-key errors.
2. HarnessSpec version/schema and unknown fields.
3. Unsafe or missing project assets/includes.
4. Duplicate/missing component IDs, entrypoints, ports, and graph references.
5. Component config and connection compatibility.
6. Subgraph, agent-template, and team references/limits.
7. Runtime policy, capabilities, Connections, Skills, and secrets.
8. Test and Studio metadata warnings.

Earlier structural errors can cause later reference errors. Revalidate after each coherent fix.

## Common failures

- **Unknown field or invalid component config:** query the live component catalog; remove guessed keys rather than weakening the schema.
- **Custom module component unknown:** authoring validation never executes `runtime.modules`, so a type registered only by executable module code is unavailable. Use a built-in/known type or expose the component contract through a declarative schema mechanism supported by the validating host; keep the module in `setupRequired.modules` for later reviewed runtime setup.
- **Component/port not found:** check graph-local IDs, case, selected component version, and direction.
- **Invalid entrypoint:** reference a component in the same root/subgraph and ensure it can accept graph input.
- **Connection missing/incompatible:** keep the declared stable ID, report the required kind, and let the user create/test it; never insert a secret to silence validation.
- **Module or file denied:** move the reference under an approved project root, remove traversal/symlinks, and list the exact capability the user must review.
- **Cycle/budget risk:** add a real termination condition and finite iteration, Tool-call, time, token, and cost limits.
- **Test invalid:** use one assertion or a non-empty assertions list and a supported assertion schema.
- **Secret detected:** remove it from every project/history artifact, rotate it if it was real, and replace it with an environment variable name or Connection reference.

## Runtime-only failures

Schema validation cannot prove network reachability, credentials, OAuth, provider model availability, container engine availability, or remote MCP behavior. Classify live failures as authentication, authorization, timeout, rate limit, unavailable dependency, protocol incompatibility, revision conflict, permission denial, or non-idempotent recovery risk. Redact credentials and host identifiers.

## Completion checklist

- validation exits cleanly with zero errors;
- every warning was reviewed and reported;
- no credentials or machine-local state are in authored files;
- tests cover the public contract and important denial/failure paths;
- required Connections, environment variable names, and capabilities are listed;
- credentialed/live checks are explicitly passed, failed, or not run;
- no deployment or external provisioning is claimed.
