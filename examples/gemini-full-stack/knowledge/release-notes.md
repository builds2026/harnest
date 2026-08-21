# Release notes

Harnest records run events as a trace. The integrated harness test verifies Context loading,
Memory initialization, Skill activation, a standalone local Tool call, an Agent Tool call,
schema evaluation, a bounded Loop, routing, and JSON output validation.

The local `demo.release-check` Tool is deliberately small: it checks for required terms and has
no filesystem, network, or process side effects. It is still treated as a reviewed module Tool
and therefore requires explicit capability and call approval.
