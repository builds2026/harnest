---
name: traceable-review
description: Produce a concise, evidence-grounded release review with a traceable next step.
metadata:
  harnest-tools: '["demo.release-check"]'
  harnest-permissions: module:execute, filesystem:read
---

Use the connected project Context as the source of truth. State only evidence that appears
in the supplied resources or Tool result. Keep the final response in Korean and preserve the
exact output schema requested by the task prompt. When evidence is incomplete, set status to
`needs-attention` and give one concrete next step.
