# v1.2 research

조사 기준일은 2026-08-21이다. v1.1의 Registry, capability gate, MCP SDK v2, trace redaction을 유지하고 연결·도구·스킬을 그 위에 통합했다.

## 현재 구조에서 확인한 문제

- Model 설정은 adapter, URL, API key reference를 노드마다 보유했다.
- Local/MCP Tool은 Agent보다 먼저 실행된 결과를 prompt에 붙였다. provider-native model → tool → result → model 반복은 없었다.
- MCP transport cache는 node id 기준이고, 연결 CRUD·상태·OAuth lifecycle·재사용 catalog가 없었다.
- Studio는 `ComponentManifest[]`만 표시하고 raw MCP/Model 설정과 YAML을 정상 흐름에 노출했다.

따라서 새 Registry를 만들지 않고 기존 `AdapterRegistry`, `ComponentRegistry`, `ToolRegistry`, `RuntimeServices`를 확장하는 것이 가장 작은 일관된 변경이다.

## MCP와 OAuth

최신 MCP `2026-07-28` authorization은 HTTP transport에 적용된다. MCP server는 OAuth protected resource이고, client는 `401` challenge에서 Protected Resource Metadata를 찾은 뒤 Authorization Server Metadata를 탐색한다. stdio transport는 이 HTTP OAuth 흐름을 사용하지 않는다. [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [MCP Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)

Client 등록 우선순위는 사전 등록, Client ID Metadata Document(CIMD), 호환 목적의 Dynamic Client Registration 순이다. 최신 revision에서 DCR은 deprecated compatibility 경로다. [MCP Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration), [2026-07-28 release](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md)

공식 TypeScript SDK v2의 `OAuthClientProvider`, `auth`, `StreamableHTTPClientTransport.finishAuth`를 사용한다. 애플리케이션은 SDK 밖에서 callback state를 constant-time으로 검증하고, PKCE verifier·state·discovery·client information·token을 issuer와 resource에 묶어 보관해야 한다. Native/local callback은 외부 browser와 loopback redirect를 사용한다. [MCP TypeScript client guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md), [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)

OAuth token 폐기는 metadata의 revocation endpoint가 있을 때만 원격 검증할 수 있다. 연결 삭제와 원격 token 폐기는 다른 상태다. [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html), [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html)

MCP Tool annotation은 UX hint다. 신뢰하지 않은 server의 `readOnlyHint`로 approval을 낮추지 않는다. 입력·출력 Schema, pagination과 list change는 SDK catalog 갱신에 사용하되 risk의 기본값은 보수적으로 둔다. [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

## Agent Skills

공개 Agent Skills 형식은 폴더의 `SKILL.md`와 선택적인 `scripts/`, `references/`, `assets/`를 정의한다. catalog 단계에는 frontmatter의 name·description만 읽고, 활성화할 때 본문, 실제 참조할 때 resource를 읽는 progressive disclosure가 권장된다. [Agent Skills specification](https://agentskills.io/specification), [Client implementation guide](https://agentskills.io/client-implementation/adding-skills-support)

표준에는 required Tool·Connection·permission 정형 필드가 없다. Harnest 요구사항은 `metadata.harnest-*` namespace 확장으로 해석하며 표준 필드라고 표시하지 않는다. Script가 있는 Skill은 provenance, hash, 요청 resource를 보여주고 별도 승인을 받아야 한다.

## OpenAPI와 JSON Schema

OpenAPI operation은 코드를 생성하는 별도 runtime이 아니라 기존 `ToolManifest`로 정규화한다. OpenAPI 3.0/3.1 문서의 operation, parameter, request body, response schema와 security requirement를 import하고 credential 값은 Connection에만 둔다. OpenAPI 3.1 Schema dialect는 JSON Schema 2020-12에 기반한다. [OpenAPI Specification](https://spec.openapis.org/oas/latest.html), [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)

외부 `$ref`는 자동 fetch하지 않는다. 승인된 file/host root와 byte/depth/cycle 제한이 생기기 전에는 fail closed가 맞다. JSON Schema `format`은 기본적으로 annotation이라는 점도 validator UX에 반영한다. [JSON Schema validation vocabulary](https://json-schema.org/draft/2020-12/json-schema-validation)

## n8n에서 가져온 UX 원칙

n8n의 화면을 복제하지 않고 다음 행동만 적용한다.

- 노드 안에서 credential을 선택하거나 생성하고 저장 후 test한다.
- Resource → Action에 따라 필요한 field만 보인다.
- secret은 masked write-only field이며 다시 browser로 보내지 않는다.
- 위험 Tool은 실행할 tool과 argument를 보여주고 approve/deny한다.
- Palette와 port `+`에서 호환 가능한 항목만 검색하고 선택 즉시 연결한다.

근거: [n8n credentials](https://docs.n8n.io/credentials/), [n8n node UI elements](https://docs.n8n.io/integrations/creating-nodes/build/reference/ui-elements/), [n8n human fallback](https://docs.n8n.io/advanced-ai/human-fallback/).

## 검증 원칙

- 로컬 fixture로 확인한 protocol과 외부 vendor 실검증을 구분한다.
- HTTP/process/file/module/script는 기존 exact capability boundary를 통과해야 한다.
- child process의 cwd·timeout·output limit는 보안 경계지만 OS-level CPU/memory sandbox는 아니다. 그런 backend가 없으면 “sandboxed”라고 표시하지 않는다.
- sentinel credential은 metadata, YAML, export, error와 persisted trace 어디에도 나타나면 안 된다.
