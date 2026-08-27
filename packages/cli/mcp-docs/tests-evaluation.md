# Tests and evaluation

Tests are part of the Harness contract. Add the cheapest deterministic assertion that would fail if the intended behavior breaks. For qualities that cannot be expressed directly, use the bounded custom model-evaluation graph pattern described below rather than treating it as a built-in assertion.

```yaml
tests:
  - id: structured_result
    input: { question: "What is 2 + 2?" }
    assertions:
      - type: includes
        value: "4"
      - type: latency
        maxMs: 10000
      - type: iterations
        max: 3
```

Supported assertion families are:

- `includes`, `equals`, `matches` for text;
- `output-schema` for structured output;
- `tool-called` with optional minimum/maximum calls;
- `latency` with `maxMs`;
- `iterations` with optional minimum/maximum.

Each case has exactly one `assertion` or a non-empty `assertions` list. IDs are stable and unique. Use strict output schemas and bounded regular expressions. Avoid assertions on timestamps, random IDs, exact model phrasing, or private trace implementation details.

## Evaluation design

The built-in Evaluator supports only the deterministic assertion families listed above; it does not provide model-based relevance, groundedness, or style scoring. When those qualitative checks are necessary, build an explicit custom graph pattern: send bounded candidate/evidence inputs through a separately prompted model, require a strict score-and-evidence schema, compare the score to a deterministic threshold, and cap cost, time, and retries. Do not use the same unconstrained model response as both answer and proof of correctness.

Include negative cases: denied permission, missing context, malformed provider output, Tool failure, budget exhaustion, and citation labels that were not supplied. External services should be replaced by deterministic fixtures for routine tests; label credentialed live checks separately.

Declarative Harness tests do not inject host interaction responses. Never simulate `allow_once`, `allow_for_run`, `allow_always`, or `deny` by writing that decision into the test input and then claim the interaction was tested. Verify permission decisions through a host/runtime E2E flow that submits the real Interaction response.

## Validation versus execution

Authoring MCP validation proves structure, references, schemas, policy, and test definitions; it does not run the declared tests. Running tests proves runtime behavior in the tested environment. Live provider/MCP success additionally requires user-owned credentials and available services. Report these three results separately, preserve non-empty `setupRequired` as later setup, and never convert “not configured” into a pass.
