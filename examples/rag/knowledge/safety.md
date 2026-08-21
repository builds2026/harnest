# Runtime safety

Harnest rejects unbounded graph cycles. Loop back-edges require a maximum iteration count and can also enforce timeout, token, and cost budgets.

Project files are resolved with realpath to their canonical paths so symlinks and Windows junctions cannot escape the Harness project root.
