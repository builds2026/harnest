# v1.2 implementation

이 문서는 2026-08-23의 저장소 상태를 `docs/prompt/v1/v1.2.md`와 대조한 결과다. 상태는 **구현됨**, **부분 구현**, **미검증**으로 구분하며, 사용할 수 없는 외부 credential/service는 구현 코드가 있어도 실제 vendor 검증 완료로 보지 않는다.

## 구조

v1.2는 v1.1의 `AdapterRegistry`, `ComponentRegistry`, `ToolRegistry`, graph compiler, Loop, MCP 실행과 Trace를 대체하지 않고 확장한다.

1. Studio 또는 CLI가 Harness를 읽고 기존 Registry를 구성한다.
2. `NodeRuntimeServices`가 Connection, Tool, Skill 저장소와 파일·프로세스·네트워크 capability를 제공한다.
3. graph에는 secret이나 executor 대신 `connectionId`, Tool binding, Skill id만 들어간다.
4. Agent는 연결된 Tool만 provider schema로 변환하고 model → approval → Tool → Tool result → model을 bounded loop로 반복한다.
5. Run event는 기존 저장소에 Tool call·approval·result와 Skill use를 함께 기록한다.

주요 구현은 `packages/core/src/connection.ts`, `node-connections.ts`, `tool.ts`, `node-tools.ts`, `skill.ts`, `node-skills.ts`, `component.ts`, `node.ts`에 있다. Provider별 변환은 `packages/adapter-*`, 고수준 API는 `packages/sdk`, 독립 실행 surface는 `packages/cli`, Studio의 서버 경계와 UI는 `frontend/app/api`, `frontend/lib`, `frontend/components`에 있다.

## 요구사항 대조

| 영역 | 상태 | 현재 범위 |
| --- | --- | --- |
| v1.1 Graph·Loop·Registry·MCP·Trace 유지 | 구현됨 | 기존 component/graph/runtime 계약과 v1.1 테스트를 유지한다. |
| Connection 재사용 | 구현됨 | Provider, MCP, HTTP API, Tool Service, Local Runtime의 project/user scope CRUD, 검색, protocol test, disconnect, revoke, reauth를 제공한다. CLI `connections`, `connect`, `connection`도 같은 manager를 사용한다. Provider model probe, MCP discovery, HTTP endpoint/auth, Search/Scrape mapping, container image/runtime probe가 있고 root/subgraph binding을 저장 metadata와 대조한다. |
| Credential 분리 | 구현됨 | public metadata에는 credential field 이름과 존재 여부만 둔다. Windows는 DPAPI(CurrentUser)+AES-256-GCM, macOS는 Keychain, Linux는 Secret Service를 사용하며 안전한 backend가 없으면 plaintext 대신 fail closed한다. vault entry는 canonical Connection kind/config hash에 묶여 metadata 변조 시 credential·OAuth·process approval 접근을 거부한다. |
| Inspector Connection 선택 | 구현됨 | Model·Tool 설정에서 compatible Connection을 선택하고 없는 경우 현재 picker에서 Connection sheet로 이동한 뒤 돌아온다. Model은 primary와 다른 fallback Provider를 선택할 수 있다. |
| MCP stdio/HTTP | 구현됨 | 저장 MCP Connection은 Streamable HTTP와 stdio Tool discovery/call을 제공한다. stdio, Shell, Code Runner, TypeScript Tool은 image digest에 묶인 승인 뒤 no-network/read-only/cap-drop/non-root/resource-bounded container에서 실행한다. 격리되지 않은 v1.1 raw stdio는 fail closed하고 raw HTTP만 제한적으로 유지한다. |
| MCP OAuth | 구현됨/외부 redirect 검증 | metadata discovery, DCR, PKCE/state, loopback callback, issuer/resource-bound token, refresh, insufficient-scope 재동의, revoke/reauth를 제공하고 local protocol E2E로 검증했다. Morit MCP의 resource host와 별도 SSO host를 실제 discovery해 authorization redirect, scopes, resource, S256 PKCE까지 확인했다. 사용자 consent/token 교환은 로그인 없이 완료됐다고 주장하지 않는다. |
| 공통 Tool 플랫폼 | 구현됨 | Built-in 6종(Web Search, Web Scrape, HTTP, File, Shell, Code Runner)과 HTTP, OpenAPI 3.0/3.1, Local Command, TypeScript Module manifest/store/executor를 제공한다. TypeScript는 host에서 esbuild bundle만 만들고 container에서 실행한다. Tool schema의 regex도 bounded safe subset을 통과해야 한다. |
| Studio↔CLI Tool parity | 구현됨 | 양쪽 모두 `NodeRuntimeServices.toolDefinitions()`와 같은 Connection/Tool/Skill store를 사용한다. CLI는 exact preapproval, TTY one-call prompt, non-TTY default deny를 제공하고 Studio도 exact call approval을 사용한다. 저장 MCP catalog id는 Connection id와 exact action에 묶인다. |
| Agent multi-turn Tool loop | 구현됨 | OpenAI, Anthropic, Gemini, Ollama adapter가 공통 Tool call/result 계약을 사용한다. shared SSE/NDJSON parser는 기본 total 16 MiB, line/event 8 MiB로 제한하고 HTTP 오류 body는 64 KiB, provider 응답의 Tool call은 128개, 각 argument는 1 MiB로 제한한다. Agent는 exact connected allowlist, input/output validation, approval, timeout, 설정된 turn/call/token/cost bound, provider turn별 text 8 MiB 제한, cancellation과 오류의 model 반환 또는 fail 정책을 추가 적용한다. retryable Provider 오류에는 선택한 fallback Connection으로 한 번 전환하고 실패 attempt의 usage/cost와 전환 event를 Trace에 보존한다. |
| Agent Skills | 구현됨 | `SKILL.md`와 resources, project/user·`.agents`/`.harnest`, metadata-first 활성화, provenance 재검증을 제공한다. Local, GitHub/GitLab exact commit archive, npm exact version+sha512 설치가 있으며 archive traversal/link/bomb를 거부한다. Studio/CLI가 script bytes·SHA-256·code를 표시하고 exact hash 승인을 저장하며 변경 시 무효화한다. Tool/Connection requirements는 누락 항목을 먼저 연결한 뒤 Skill attach를 재개한다. |
| Trace 저장 | 구현됨 | NDJSON append는 file descriptor와 regular/non-link/nlink/inode 검사를 사용하고 가능한 플랫폼에서는 `O_NOFOLLOW`를 적용한다. trace당 8 MiB, event당 64 KiB, trace당 10,000 event로 제한한다. |
| Studio UX | 구현됨 | 첫 방문은 결과·필요 서비스·sample input이 보이는 5개 Recipe launchpad다. Builder는 Build/Tools/Skills/Services/Recipes, Configure, Setup/Tests/Compare/Activity/YAML로 정리했고 기존 Try dock은 제거했다. 상단 Harnest Playground는 history/chat/execution timeline/composer/files·sandbox 3-pane과 panel toggle을 제공한다. 저장과 runtime validation은 debounce로 자동 진행하고 Connection은 한 번의 Connect로 저장·인증/승인·test까지 진행한다. Tests와 Compare는 고급 assertion·원본 Spec을 손실 없이 유지한다. |
| Playground conversation/file runtime | 구현됨 | 저장 Spec을 바꾸지 않는 scoped model/plugin override, project-local 30일 session, 최근 20 messages/64 KiB Provider replay, declared Code Runner에 한정된 upload, selected-file read-only `/mnt/data`, writable `/mnt/output`, live artifact event와 bounded preview/download를 제공한다. Core `RunSessionContext`는 Studio 밖 host도 같은 대화/첨부 계약을 쓸 수 있다. Provider-native explicit cache는 공통 보장하지 않고 별도 adapter/provider capability로 남긴다. |
| Templates | 구현됨 | RAG, Web Research, Coding Agent, MCP Agent, Evaluation Loop를 생성한다. 외부 credential, endpoint, knowledge 같은 실제 resource는 생성할 수 없으므로 staged commissioning 대상으로 표시하고 완료 전 Validate를 통과시키지 않는다. |
| 독립 실행 surface | 구현됨 | `harnest init`, loopback `harnest serve`(`/health`, `/invoke`, NDJSON `/stream`), stdio `harnest mcp serve`, `Harnest.load().invoke/stream/test/close` SDK가 Studio와 같은 Core·Connection·Tool 경로를 사용한다. HTTP와 MCP client integration test가 실제 server를 띄워 호출한다. `harnest bundle`은 검증된 YAML과 regular/non-link `assets/`만 deterministic standard ZIP `.harnest`로 묶고 secret/local state를 제외한다. |
| 비교 실험 | 구현됨 | Studio Compare가 root component의 config field 하나를 A/B로 바꾸고 동일 input으로 2개 variant를 순차 실행한다. 저장 spec은 변경하지 않으며 answer, evaluator pass/score, duration, usage, cost, run id와 실패 diagnostic을 나란히 표시한다. |
| 전체 검증 | 구현됨/외부 일부 미검증 | unit/integration/protocol, local OAuth, Morit OAuth discovery, fake container engine, local Search fixture, CLI lifecycle, production build와 in-app Studio E2E가 있다. 실제 외부 OpenAI/Anthropic/Firecrawl/SearXNG consent 및 실행 중인 Docker daemon은 현재 환경의 credential/service 부재로 미검증이다. 자세한 내용은 `tests.md`와 `remaining-issues.md`를 따른다. |

## 저장 위치

- Project Connection metadata: `<project>/.harnest/connections.json`
- User Connection metadata: OS 사용자 데이터 디렉터리의 `connections.json`
- Credential vault: 같은 사용자 데이터 디렉터리의 encrypted vault와 OS backend-bound key material
- Project Tool manifest: `<project>/.harnest/tools/*.json`
- Skill roots: project/user 각각의 `.agents/skills/*`와 `.harnest/skills/*`
- Trace와 memory: 기존 project-local `.harnest` 저장소
- Playground conversation/upload/artifact: `<project>/.harnest/playground/sessions/*` (30일 inactivity retention)

Credential 값, OAuth transaction/token, process approval은 Harness YAML이나 public Connection DTO에 들어가지 않는다.
