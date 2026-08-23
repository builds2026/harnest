# v1.2 verification

## 자동화 범위

| 영역 | 자동화된 근거 |
| --- | --- |
| Graph/runtime 회귀 | validation, branch/router/join, subgraph/Loop, retry, budget, cancellation, evaluator, Trace |
| Provider Tool 계약 | OpenAI, Anthropic, Gemini, Ollama Tool definition, streamed call, Tool result mapping; Gemini unsupported `additionalProperties` 제거 후 원본 schema의 local AJV 검증 유지 |
| Agent Tool loop | connected-only allowlist, name collision, exact approval 전 side effect 차단, cancellation, multi-turn result, secret redaction |
| Connection/vault | project/user CRUD, config secret 거부, OS backend command boundary, profile-bound encrypted entry, HTTP/local probe, disconnect/revoke/reauth |
| Outbound network | hostname private/reserved 거부, IPv4/IPv6 block lists, Node lookup single/all callback, pinned Host/SNI transport, redirect/size/credential-origin 제한 |
| Web Search/Scrape | GET/query와 POST/JSON, cursor/pagination, response normalization, Firecrawl/SearXNG preset, scrape mapping, missing credential 상태 |
| MCP | containerized stdio discovery/call/error와 raw stdio 거부, 실제 local Streamable HTTP `2026-07-28` discovery/call |
| OAuth | discovery → DCR → PKCE callback → refresh → insufficient-scope 재동의 → revoke를 잇는 local protocol E2E와 replay/pending 상태 |
| Custom/Built-in Tool | schema generation, bounded store, HTTP, OpenAPI 3.0/3.1, external `$ref` 거부, container process, TypeScript bundle, Built-in 6종 |
| Agent Skills | parser/precedence/progressive disclosure, provenance tamper, local install, mocked Git/npm materialization+integrity+hostile archive, exact script hash approval/change invalidation |
| Studio logic | graph/YAML state, trace lens, capability scoping, 5 Templates, missing declared Connection staging, exact Built-in ID |
| CLI | validate/run/test/runs/trace, Connection create→test→list→delete, Skill lifecycle, exact Tool approval, examples integration |
| Studio HTTP | literal-loopback Host/Origin 허용, DNS Host rebinding request 거부, body bounds와 secret-safe DTO |

## 최종 명령 결과

2026-08-23 root snapshot:

| 명령 | 결과 |
| --- | --- |
| `npm run lint` | 통과 — ESLint 오류·경고 없음 |
| `npm run typecheck` | 통과 — package project references + Studio `tsc --noEmit` |
| `npm test` | 통과 — **22 files, 170 passed, 1 platform-conditional skipped (171 total)** |
| `npm run build` | 통과 — package + Studio production build, static pages **15/15**, warning 없음 |
| production Host smoke | 통과 — literal `Host: 127.0.0.1:3456` 200, `Host: evil.example` 403 |

## 실제 Studio E2E

in-app browser와 임시 project에서 다음을 실제 클릭했다.

- first commissioning, 5 Templates, `Template → Connect → Equip → Validate → Run → Trace` rail
- Web Research 선택 후 SearXNG endpoint 입력 한 번의 **Connect**로 저장+probe, `Connected` card와 다음 Gemini requirement 자동 진행
- Local Skill 설치, script code/bytes/SHA-256 표시, **Approve exact hashes** 후 승인 상태
- project-contained Echo adapter graph의 Inspector 수정 → Save → Validate → 두 Run(110/127ms) → persisted node/edge/usage/text Trace
- saved Harness test **1 passed · 0 failed**
- Agent `+ Tool` compatible picker에서 Web Search 한 번 선택 → Tool node/edge/Connection 자동 배선 → 저장/재검증
- server log에 처리되지 않은 오류 없음

마지막 자동-Connection wizard 재접속은 in-app browser의 local URL policy가 차단해 우회하지 않았다. exact id/kind staging은 별도 순수 회귀 테스트로 검증했다.

## 실제 Gemini + Web Search E2E

저장된 Google AI Studio credential 값을 읽거나 출력하지 않고 다음을 수행했다.

1. Provider Connection 최소 probe: `gemini-3.5-flash-lite`가 `usage → finish` 반환.
2. local SearXNG fixture Connection을 생성·실제 probe.
3. `additionalProperties: false`가 있는 Web Search Tool schema를 Gemini에 전송.
4. Gemini가 `{ query: "Harnest trace", limit: 1 }`을 호출.
5. exact `builtin.web-search` 사전 승인 후 fixture 결과 반환.
6. 두 번째 Gemini turn이 `Pinned search result`와 URL을 최종 출력.

Run `3f90c6f6-d244-48a6-b523-329d2c7d8d43`은 **1662ms**, 331 input / 41 output token이었고 Trace에 tool-call, user approval, 23ms tool-result, second-turn text, run-end가 기록됐다. 테스트용 Connection과 YAML은 삭제했다.

## 환경 때문에 남은 검증

- 실제 OpenAI/Anthropic, Firecrawl, self-hosted SearXNG, 외부 MCP OAuth credential/service
- 실행 중인 실제 Docker/Podman daemon의 image pull/container E2E(현재 Docker CLI만 있고 daemon은 중지 상태)
- macOS Keychain/Linux Secret Service의 해당 OS CI
- 실제 공개 GitHub/GitLab Skill repository와 npm Skill package
- OAuth consent popup 및 canvas pointer edge 재배선 시각 회귀

이 항목은 [remaining verification](./remaining-issues.md)에 배포 경계와 함께 기록한다.
