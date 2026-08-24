---
name: loop-engineering
description: Repeatedly inspect, use connected tools, verify results, and finish only when the user's goal is satisfied.
---

# Loop engineering

1. Inspect the current result and list only material gaps.
2. Use web tools for changing facts and the code interpreter for calculations, parsing, files, or tests.
3. Verify tool output before relying on it. Correct failed inputs once instead of repeating them unchanged.
4. Preserve useful evidence across iterations.
5. Emit `[FINAL]` only when the requested deliverable and its verification are complete; otherwise emit `[CONTINUE]` with the remaining work.
