# v1.2 verification

## 자동화 범위

| 영역 | 자동화된 근거 |
| --- | --- |
| Graph/runtime 회귀 | validation, branch/router/join, subgraph/Loop, retry, one-shot Provider fallback, failed-attempt usage/cost, budget, cancellation, evaluator, Trace |
| Provider Tool 계약 | OpenAI, Anthropic, Gemini, Ollama Tool definition, streamed call, Tool result mapping; Gemini unsupported `additionalProperties` 제거 후 원본 schema의 local AJV 검증 유지 |
| Agent Tool loop | connected-only allowlist, name collision, exact approval 전 side effect 차단, cancellation, multi-turn result, secret redaction |
| Connection/vault | project/user CRUD, config secret 거부, OS backend command boundary, profile-bound encrypted entry, HTTP/local probe, disconnect/revoke/reauth |
| Outbound network | hostname private/reserved 거부, IPv4/IPv6 block lists, Node lookup single/all callback, pinned Host/SNI transport, redirect/size/credential-origin 제한 |
| Web Search/Scrape | GET/query와 POST/JSON, cursor/pagination, response normalization, Firecrawl/SearXNG preset, scrape mapping, missing credential 상태 |
| MCP | containerized stdio discovery/call/error와 raw stdio 거부, 실제 local Streamable HTTP `2026-07-28` discovery/call |
| OAuth | discovery → DCR → PKCE callback → refresh → insufficient-scope 재동의 → revoke를 잇는 local protocol E2E와 replay/pending 상태 |
| Custom/Built-in Tool | schema generation, bounded store, HTTP, OpenAPI 3.0/3.1, external `$ref` 거부, container process, TypeScript bundle, Built-in 6종 |
| Agent Skills | parser/precedence/progressive disclosure, provenance tamper, local install, mocked Git/npm materialization+integrity+hostile archive, exact script hash approval/change invalidation |
| Studio logic | graph/YAML state, declarative Test round-trip, trace lens, capability scoping, 5 Templates, primary/fallback Connection staging, exact Built-in ID, non-mutating typed experiment variant와 evaluator quality summary |
| SDK/CLI | high-level load/invoke/test, init overwrite refusal, standard ZIP `.harnest` bundle/overwrite refusal, validate/run/test/runs/trace, loopback HTTP invoke, stdio MCP list/call, Connection·Skill lifecycle, exact Tool approval |
| Studio HTTP | literal-loopback Host/Origin 허용, DNS Host rebinding request 거부, body bounds, secret-safe DTO, Compare input validation, Playground upload의 Content-Length/size/Range/CSP/삭제 경계 |
| Playground | 실제 선언 모델·Plugin만 노출, subgraph-scoped component ID, Spec clone override 불변성, bounded history, selected-file staging, read-only input/writable output mount, live/final artifact scan |

## 최종 명령 결과

2026-08-23 root snapshot:

| 명령 | 결과 |
| --- | --- |
| `npm run lint` | 통과 — ESLint 오류·경고 없음 |
| `npm run typecheck` | 통과 — package project references + Studio `tsc --noEmit` |
| `npm test` | 통과 — **28 files, 187 passed, 1 platform-conditional skipped (188 total)** |
| `npm run build` | 통과 — package + Studio production build, static pages **19/19**, Playground 포함 17 app routes, warning 없음 |
| production Host smoke | 통과 — literal `Host: 127.0.0.1:3456` 200, `Host: evil.example` 403 |

## 실제 Studio E2E

in-app browser와 임시 project에서 다음을 실제 클릭했다.

- 빈 파일에서 결과 중심 Recipe launchpad와 필요한 Service/sample input 표시 확인
- MCP Agent 선택 즉시 graph 생성·자동 저장·자동 check, Google AI Studio Service form, Morit MCP URL과 기본 browser OAuth auto-discovery form까지 이어지는 next-action 확인
- 별도 Save/Validate 조작 없이 `Recipe → Services → Ready → Result` 상태와 Setup blocker 전환 확인
- root Echo graph의 Prompt `template` A/B를 같은 input으로 실제 순차 실행: **136ms / 134ms**, 두 answer·token·run id 나란히 표시
- 상단 Harnest Playground의 3-pane layout, History/Files 접기, 선언 모델·Tool 목록, 실행 timeline과 source Harness 불변 안내 확인
- 실제 `README.md` upload → Files 목록/안전한 text preview → run 선택 chip 반영 확인. Code Runner를 끄면 첨부 control과 선택이 함께 비활성화되고 다시 켜면 복구되는 capability gating 확인
- 680×900 viewport에서 양 side panel이 기본 접히고 Files를 열 때 History가 닫힌 상태를 유지하며, composer와 상단 surface navigation이 계속 사용 가능한지 확인
- Tests에서 case 추가·request/expected text 수정 → 자동 저장·자동 check → 실제 Runtime 일괄 실행 **2 passed · 0 failed, 100% success**(158ms/116ms) 확인
- 기본 narrow viewport와 1440×900에서 navigation, palette overflow, canvas/Configure/dock 배치 확인

- 5 Templates의 graph 생성, compatible Connection 자동 배선과 단계별 missing requirement 진행 회귀
- Web Research 선택 후 SearXNG endpoint 입력 한 번의 **Connect**로 저장+probe, `Connected` card와 다음 Gemini requirement 자동 진행
- Local Skill 설치, script code/bytes/SHA-256 표시, **Approve exact hashes** 후 승인 상태
- project-contained Echo adapter graph의 Inspector 수정 → 저장/검증 → 두 Run(110/127ms) → persisted node/edge/usage/text Trace
- saved Harness test **1 passed · 0 failed**
- Agent `+ Tool` compatible picker에서 Web Search 한 번 선택 → Tool node/edge/Connection 자동 배선 → 저장/재검증
- server log에 처리되지 않은 오류 없음

테스트용 새 YAML은 삭제했다. Morit의 최종 **Connect**는 외부 OAuth client 등록과 사용자 consent를 시작하므로 브라우저 시각 검증에서는 누르지 않았고, 아래 protocol test로 discovery/redirect를 별도 검증했다.

## 실제 Morit MCP OAuth discovery

`https://morit-api.moring.co/mcp`에 secret 없이 실제 protocol request를 보냈다.

1. `401 WWW-Authenticate`의 Protected Resource Metadata URL 확인
2. resource `https://morit-api.moring.co/mcp`, authorization server `https://sso.moring.co`, read/write/build scope 확인
3. 별도 SSO host의 authorization/token/registration/revocation metadata 확인
4. Harnest가 시작 resource host만 허용받은 상태에서 metadata가 선언한 SSO host를 exact allowlist에 추가
5. DCR 뒤 `/auth` redirect, resource parameter, requested scopes와 `S256` PKCE 확인

초기 구현은 `sso.moring.co`가 명시 allowlist에 없다고 실패했다. resource metadata와 authorization metadata가 선언한 HTTPS endpoint host만 파생하도록 공통 OAuth network path를 수정했고, resource server와 auth server가 다른 local regression test도 추가했다. 사용자 로그인/consent, callback token 교환은 수행하지 않았다.

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

- 실제 OpenAI/Anthropic, Firecrawl, self-hosted SearXNG, Morit 사용자 consent/token lifecycle
- 실행 중인 실제 Docker/Podman daemon의 image pull/container E2E(현재 Docker CLI만 있고 daemon은 중지 상태)
- macOS Keychain/Linux Secret Service의 해당 OS CI
- 실제 공개 GitHub/GitLab Skill repository와 npm Skill package
- OAuth consent popup 및 canvas pointer edge 재배선 시각 회귀

이 항목은 [remaining verification](./remaining-issues.md)에 배포 경계와 함께 기록한다.
