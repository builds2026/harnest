# v1.2 verification

## 자동화 범위

| 영역 | 자동화된 근거 |
| --- | --- |
| v1.1 회귀 | graph validation, branch/join, subgraph/Loop, retry, budget, cancellation, MCP/Tool/Trace 테스트 |
| Provider Tool 계약 | OpenAI, Anthropic, Gemini, Ollama의 Tool definition, streamed call, Tool result mapping 테스트 |
| Agent Tool loop | connected-only allowlist, provider name collision, approval 전 side effect 차단, cancellation, multi-turn 결과, trace redaction 테스트 |
| Connection/Credential | public metadata secret 부재, config secret 거부, same-origin credential injection, issuer-bound OAuth data, one-time callback state 테스트 |
| Search Connection | GET/query와 POST/JSON mapping, response normalization, missing credential 상태, 저장 endpoint authorization 테스트 |
| MCP stdio | 실제 local stdio fixture process를 exact command allowlist로 discover/call하는 테스트 |
| MCP Streamable HTTP | 실제 local `2026-07-28` fixture를 host allowlist 뒤에서 discover/call하는 테스트 |
| OAuth 상태 | local token endpoint callback exchange/replay, 401/insufficient scope 상태, refresh-token/access-token revoke 및 pending 보존 테스트 |
| Custom Tool | schema generation, bounded store, HTTP execution, OpenAPI 3.0/3.1 import, external `$ref` 거부, process timeout/output, module capability, built-in 5종 테스트 |
| Agent Skills | parser, precedence, metadata-only catalog, activation/resource bounds, script hash approval, provenance tamper, local/pinned source 정책 테스트 |
| Studio logic | graph/YAML state, trace graph lens, capability scoping, 5개 template와 exact built-in ID 테스트 |
| CLI | validate/run/runs/trace, saved Connection 진단, exact Tool approval와 RAG/MCP/evaluation example integration 테스트 |
| Ingress bounds | provider stream total/line/event, 오류 본문, Tool call 수/인자, per-turn output, invalid usage와 post-finish record 차단 테스트 |
| Studio Host | literal-loopback Host/Origin 허용과 DNS Host rebinding 요청 거부 테스트 |

Local MCP fixture는 `examples/mcp-tool-agent/server.mjs`와 `http-server.mjs`를 실제 child/server protocol로 실행한다. OAuth fixture는 local HTTP token/revoke/auth-error endpoint를 사용하지만, 아래 전체 OAuth browser sequence를 모두 수행하는 하나의 E2E는 아니다.

## 실행 명령

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

아래는 모든 수정이 반영된 2026-08-22 root snapshot의 최종 결과다.

| 명령 | 최종 결과 |
| --- | --- |
| `npm run lint` | 통과 — ESLint 오류·경고 없음 |
| `npm run typecheck` | 통과 — package project references와 Studio `tsc --noEmit` |
| `npm test` | 통과 — **22 files, 158 tests** |
| `npm run build` | 통과 — package build와 Studio production build, static page **15/15**; Turbopack warning 1건 |
| production Host smoke | 통과 — `Host: 127.0.0.1:3456`은 200, `Host: evil.example`은 403 |
| in-app browser E2E | 통과 — 아래 로컬 흐름과 실제 Gemini provider; 외부 OAuth와 실제 Firecrawl/SearXNG service는 제외 |

### Studio 브라우저 E2E

Next production server와 in-app browser로 다음을 실제 클릭해 확인했다.

- 빈 임시 프로젝트에서 First commissioning과 RAG, Web Research, Coding Agent, MCP Agent, Evaluation Loop 5개 Template 노출
- Evaluation Loop 선택 시 YAML 편집 없이 graph 생성과 inline Provider Connection Wizard 복귀 흐름
- Components/Tools/Skills/Connections/Templates Palette, built-in Tool 5종과 Custom Tool 4개 방식, local/Git/package Skill 추가 Form
- 임시 graph 저장과 Validate; 누락 Provider가 성공으로 위장되지 않고 `MODEL_CONNECTION_REQUIRED`로 표시됨
- 저장된 local echo Harness를 Validate한 뒤 Studio에서 실제 Run 성공, node 상태 반영, persisted Trace의 run/node/edge/usage/text events 확인
- 같은 화면에서 saved harness test를 실행해 **1 passed · 0 failed** 확인
- production server 로그에 처리되지 않은 오류 없음; 검증 중 생성한 임시 프로젝트와 Run trace는 종료 후 제거
- Google AI Studio Gemini 3.5 Flash-Lite Provider Connection test 성공
- SearXNG 호환 local Search Connection을 저장·자동 test한 뒤 Web Research Template이 Provider와 Search를 자동 연결
- Gemini function call의 exact `{query, limit}`를 **Approve once**하고, Search result를 model에 반환해 두 번째 turn의 최종 응답까지 성공

Build에는 dynamic user-data path 때문에 Turbopack이 core trace 범위를 완전히 추론하지 못한다는 비차단 warning 1개가 남았다.

## 자동화되지 않았거나 충분하지 않은 검증

- Protected Resource discovery → Authorization Server discovery → 실제 browser 로그인/consent → callback → refresh → scope 증가 → revoke 전 과정을 잇는 protocol E2E
- 실제 OpenAI/Anthropic/Ollama credential을 사용한 provider-native multi-turn Tool call과 Gemini 오류/재인증 경로
- Studio와 CLI가 같은 persisted custom Tool/Skill/Connection graph를 같은 승인 정책으로 실행한다는 cross-surface E2E
- 실제 Git/package remote Skill materialization
- Windows 이외 secure credential backend
- canvas pointer drag/drop과 edge 재배선, compatible picker 선택, 실제 OAuth consent popup, call-time approval dialog를 한 흐름으로 잇는 추가 브라우저 회귀
- DNS rebinding과 child process tree/resource exhaustion에 대한 보안 테스트

브라우저 E2E가 통과했어도 외부 credential, OAuth consent, OS sandbox와 outbound IP pinning까지 검증한 것으로 기록하지 않는다.
