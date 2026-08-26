# v1.4 remaining issues

## External configuration required

- The repository Harness references four local Connection profiles that are not committed: primary Gemini, fallback model, Firecrawl/SearXNG-compatible search, and a local runtime. Open Studio Settings/Services to create or rebind them. Credentials stay in the OS vault; `.env.example` is only for headless deployment.
- Hosted Gemini/Firecrawl/SearXNG smoke was not runnable because this host has no corresponding API key. This does not affect local MCP, permission, attachment, project, save, version, Artifact, or Docker evidence.

## Known product constraints

- Browser directory selection imports a managed project copy because standard browser file inputs do not grant a server a durable host-directory handle. CLI/SDK can work directly from a project root. A native desktop folder-handle bridge would be a separate host feature.
- `studio.tsx` and legacy global CSS remain larger than ideal. v1.4 reused their reducer and visual contracts to avoid a risky rewrite; further module extraction is maintainability work, not a missing user flow.
- A historical large-graph frame-time baseline was not captured before implementation. Save-request counts are regression-tested, but a reproducible large-graph FPS benchmark should be added before claiming a percentage improvement.
- Conversation growth is bounded by deterministic structured compaction. Provider-native prompt/prefix caching is not enabled; adding it would require per-adapter cache identity, invalidation, billing, and privacy semantics rather than a portable Core toggle.

No known correctness failure remains in the requested local feature set after lint, typecheck, 243 tests, production build, eight Playwright scenarios, real MCP/CLI execution, and real Docker Code Runner smoke.
