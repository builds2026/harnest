# v1.2 decisions

## ADR-01 — Connection metadata와 credential을 분리한다

Harness에는 `connectionId`와 비민감 node/action 설정만 저장한다. Project/user Connection metadata는 JSON이고 credential, OAuth transaction, client information, token은 OS-user-bound vault에 둔다. Windows 구현은 DPAPI(CurrentUser)로 감싼 random data key와 AES-256-GCM을 사용한다. 안전한 OS backend가 없는 platform은 plaintext fallback 대신 실패한다.

## ADR-02 — Tool 실행 계약은 하나다

기존 `ToolRegistry` manifest에 output schema, source, risk와 Connection 요구사항을 추가한다. MCP, built-in, HTTP/OpenAPI, command와 module Tool은 같은 binding을 Agent에 제공한다. 기존 v1.1 `local-tool`/`mcp-tool`의 독립 실행은 호환 경로로 남기며 raw MCP도 실제 stdio와 Streamable HTTP SDK transport를 사용하고 exact host/process capability를 통과한다.

## ADR-03 — Tool attachment와 Tool 실행을 분리한다

새 `tool` Component는 serializable binding을 Agent의 typed `tools` port로 전달한다. Executor 함수와 credential은 graph에 넣지 않는다. Agent는 연결된 binding만 provider에 노출하고 normalized call name을 exact allowlist로 역매핑한다.

## ADR-04 — Agent가 bounded multi-turn loop를 소유한다

Provider Adapter는 tool definition, assistant tool call, tool result와 streamed tool call을 공통 Model 계약으로 변환한다. Agent는 model → approval → executor → tool result → model을 반복한다. Turn, tool-call, tool timeout, token, cost와 outer runtime timeout/cancel bound를 적용한다. 거절/오류는 policy에 따라 model에게 오류 result로 돌려 복구하거나 run을 실패시킨다.

## ADR-05 — 위험 Tool은 call-time approval을 받는다

`read`만 기본 policy로 승인한다. `write`, `external`, `destructive`는 명시적 사용자 승인이 없으면 실행하지 않는다. 저장 MCP Tool의 preapproval id는 Connection id와 exact discovered action을 함께 digest하며 둘이 일치해야 한다. MCP annotation은 risk를 낮추는 근거가 아니다. Trace에는 call id, turn, argument, risk, approval source, result/error를 남기고 credential은 redaction한다.

## ADR-06 — Skill은 progressive disclosure다

`skill` Component는 id와 사용자가 고른 resource reference만 전달한다. Catalog는 metadata만, Agent 활성화는 본문만, resource service는 요청된 file만 bounded하게 읽는다. Script는 provenance/hash 확인과 별도 trust callback이 없으면 접근할 수 없다.

## ADR-07 — Studio는 기존 manifest-driven canvas를 확장한다

새 state library나 form dependency를 추가하지 않는다. 현재 reducer, React Flow, JSON Schema, Inspector field와 CSS를 재사용한다. Palette를 Components/Tools/Skills/Connections/Templates로 나누고 compatible picker와 Connection sheet를 transient composer state로 둔다. YAML은 Advanced 진단 도구이며 정상 onboarding에 필요하지 않다. Studio HTTP surface는 모든 request의 literal-loopback Host를, mutation의 same-origin까지 proxy/API 경계에서 검사한다.

## ADR-08 — 실행할 수 없는 항목은 installed/connected로 표시하지 않는다

Protocol test가 없는 일반 HTTP/Local Runtime metadata는 untested다. Provider는 등록 Adapter probe, MCP는 protocol discovery, Web Search는 저장 HTTP mapping probe를 사용한다. Built-in Tool은 실제 executor가 Registry에 들어왔을 때만 installed다. 외부 Git/package materializer, vendor OAuth, OS resource isolation을 확인하지 못하면 unavailable 또는 unverified로 표시한다.
