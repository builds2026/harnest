# v1.2 implementation

이 문서는 2026-08-22의 저장소 상태를 `docs/prompt/v1/v1.2.md`와 대조한 결과다. 상태는 **구현됨**, **부분 구현**, **미검증**으로 구분하며, 자동화가 없는 외부 연동은 구현 코드가 있어도 검증 완료로 보지 않는다.

## 구조

v1.2는 v1.1의 `AdapterRegistry`, `ComponentRegistry`, `ToolRegistry`, graph compiler, Loop, MCP 실행과 Trace를 대체하지 않고 확장한다.

1. Studio 또는 CLI가 Harness를 읽고 기존 Registry를 구성한다.
2. `NodeRuntimeServices`가 Connection, Tool, Skill 저장소와 파일·프로세스·네트워크 capability를 제공한다.
3. graph에는 secret이나 executor 대신 `connectionId`, Tool binding, Skill id만 들어간다.
4. Agent는 연결된 Tool만 provider schema로 변환하고 model → approval → Tool → Tool result → model을 bounded loop로 반복한다.
5. Run event는 기존 저장소에 Tool call·approval·result와 Skill use를 함께 기록한다.

주요 구현은 `packages/core/src/connection.ts`, `node-connections.ts`, `tool.ts`, `node-tools.ts`, `skill.ts`, `node-skills.ts`, `component.ts`, `node.ts`에 있다. Provider별 변환은 `packages/adapter-*`, Studio의 서버 경계와 UI는 `frontend/app/api`, `frontend/lib`, `frontend/components`에 있다.

## 요구사항 대조

| 영역 | 상태 | 현재 범위 |
| --- | --- | --- |
| v1.1 Graph·Loop·Registry·MCP·Trace 유지 | 구현됨 | 기존 component/graph/runtime 계약과 v1.1 테스트를 유지한다. |
| Connection 재사용 | 구현됨/부분 구현 | Provider, MCP, HTTP API, Tool Service, Local Runtime의 project/user scope CRUD, 검색, test action, 상태, disconnect, revoke, reauth를 제공한다. CLI `validate`와 Studio `/api/validate`는 root/subgraph의 Model·MCP·Tool binding을 저장 metadata와 대조해 missing, disconnected/unavailable, kind mismatch를 오류로 낸다. MCP는 protocol test와 Tool discovery, Provider는 등록 Adapter의 최소 model probe, Web Search Tool Service는 저장 mapping으로 실제 search probe를 수행한다. 일반 HTTP API와 Local Runtime의 handshake는 남아 있다. |
| Credential 분리 | 구현됨(Windows) | public metadata에는 credential field 이름과 존재 여부만 두고 값은 DPAPI(CurrentUser)로 감싼 AES-256-GCM vault에 둔다. 보호된 vault entry는 canonical Connection kind/config hash에 묶이므로 `connections.json`을 API 밖에서 바꾸면 credential·OAuth·process approval 접근이 fail closed한다. 안전한 비-Windows backend는 아직 없다. |
| Inspector Connection 선택 | 구현됨 | Model·Tool 설정에서 compatible Connection을 선택하고 없는 경우 현재 picker에서 Connection sheet로 이동한 뒤 돌아온다. |
| MCP stdio/HTTP | 구현됨 | 저장 MCP Connection은 stdio/Streamable HTTP 설정 UI, exact command/host allowlist, Tool schema discovery와 call을 제공한다. stdio executable은 absolute canonical non-link regular file이어야 하고, launch fingerprint는 canonical path와 file identity(size/mtime/dev/ino), args, cwd, environment credential mapping 전체를 포함한다. 기존 v1.1 raw `mcp-tool`도 두 실제 SDK transport를 유지하며, 저장 profile 없이도 canonical stdio command 또는 HTTPS/literal-loopback HTTP와 explicit capability·approval을 요구한다. |
| MCP OAuth | 부분 구현 | SDK 기반 metadata discovery, PKCE/state, loopback callback, client information, issuer/resource-bound token, revoke/reauth 상태 처리가 있다. 전체 브라우저 로그인·refresh E2E와 외부 authorization server 검증은 없다. |
| 공통 Tool 플랫폼 | 구현됨 | Built-in 5종과 HTTP, OpenAPI 3.0/3.1, Local Command, TypeScript Module manifest/store/executor를 제공한다. Tool input/output schema의 `pattern`과 `patternProperties`는 bounded safe-regex subset 검사도 통과해야 한다. |
| Studio↔CLI Tool parity | 구현됨/미검증 | 양쪽 모두 `NodeRuntimeServices.toolDefinitions()`를 validation 전에 Registry에 등록하고 같은 services로 실행한다. CLI는 반복 가능한 exact `--approve-tool`, TTY one-call prompt, non-TTY default deny를 제공하며 Studio 실행에도 preapproval 목록을 환경으로 전달한다. 저장 MCP Tool의 catalog id는 Connection id와 정확한 discovered action을 함께 digest하므로 action 교체나 다른 Connection이 기존 preapproval을 재사용하지 못한다. 같은 persisted graph를 양쪽에서 비교하는 E2E는 남아 있다. |
| Agent multi-turn Tool loop | 구현됨 | OpenAI, Anthropic, Gemini, Ollama adapter가 공통 Tool call/result 계약을 사용한다. shared SSE/NDJSON parser는 기본 total 16 MiB, line/event 8 MiB로 제한하고 HTTP 오류 body는 64 KiB, provider 응답의 Tool call은 128개, 각 argument는 1 MiB로 제한한다. Agent는 exact connected allowlist, input/output validation, approval, timeout, 설정된 turn/call/token/cost bound, provider turn별 text 8 MiB 제한, cancellation과 오류의 model 반환 또는 fail 정책을 추가 적용한다. |
| Agent Skills | 부분 구현 | 공개 `SKILL.md`와 `scripts/`, `references/`, `assets/`, project/user 및 `.agents`/`.harnest` 검색, metadata-first 활성화와 resource load가 있다. catalog는 metadata만 읽고 `activate()`와 `loadResource()`가 provenance content hash를 지연 검증해 불일치 시 fail closed한다. 원격 materializer와 Studio script trust 승인은 기본 제공되지 않는다. |
| Trace 저장 | 구현됨 | NDJSON append는 file descriptor와 regular/non-link/nlink/inode 검사를 사용하고 가능한 플랫폼에서는 `O_NOFOLLOW`를 적용한다. trace당 8 MiB, event당 64 KiB, trace당 10,000 event로 제한한다. |
| Studio UX | 구현됨/부분 구현 | Components, Tools, Skills, Connections, Templates palette, 검색·분류·최근·즐겨찾기, compatible picker, dynamic Inspector, onboarding, Run/Test/Trace, Advanced YAML이 있다. 모든 Studio request는 URL과 일치하는 literal-loopback Host를 요구하고 mutation은 같은 literal-loopback Origin도 요구한다. 요구사항의 Skill 누락 항목 일괄 설치와 모든 template의 무설정 즉시 실행은 완성되지 않았다. |
| Templates | 부분 구현 | RAG, Web Research, Coding Agent, MCP Agent, Evaluation Loop graph를 생성한다. 기존 compatible Connection을 자동 연결한다. Provider 연결과 RAG 지식, MCP Tool, Web Search service 등 실제 resource commissioning은 필요하다. |
| 전체 검증 | 부분 구현 | 로컬 unit/integration/protocol 테스트와 Gemini API + local SearXNG-contract Search Connection의 시각 브라우저 multi-turn E2E가 있다. 실제 외부 OAuth, Firecrawl/SearXNG service, 다른 provider 검증은 남아 있다. 자세한 내용은 `tests.md`와 `remaining-issues.md`를 따른다. |

## 저장 위치

- Project Connection metadata: `<project>/.harnest/connections.json`
- User Connection metadata: OS 사용자 데이터 디렉터리의 `connections.json`
- Credential vault: 같은 사용자 데이터 디렉터리의 `credentials.vault`와 DPAPI-wrapped key
- Project Tool manifest: `<project>/.harnest/tools/*.json`
- Skill roots: project/user 각각의 `.agents/skills/*`와 `.harnest/skills/*`
- Trace와 memory: 기존 project-local `.harnest` 저장소

Credential 값, OAuth transaction/token, process approval은 Harness YAML이나 public Connection DTO에 들어가지 않는다.
