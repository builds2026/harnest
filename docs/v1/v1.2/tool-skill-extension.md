# Tool and Skill extension

## Tool 추가

Studio의 **Tools → New custom tool**에서 HTTP Endpoint, project-relative OpenAPI 문서, Local Command, TypeScript Module을 추가한다. 예제 입력·출력에서 JSON Schema 2020-12 초안을 만들 수 있고 저장 전에 수정할 수 있다. 저장된 manifest는 `.harnest/tools/<id>.json`에 있으며 secret이나 특정 Connection ID는 포함하지 않는다. Harness의 Tool node에서 compatible Connection을 선택한다.

최소 HTTP manifest 예시는 다음과 같다.

```json
{
  "manifestVersion": "1",
  "id": "custom.lookup",
  "label": "Lookup",
  "description": "Look up one record",
  "kind": "http",
  "source": "custom",
  "risk": "external",
  "connectionKinds": ["http-api"],
  "inputSchema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": { "id": { "type": "string" } },
    "required": ["id"],
    "additionalProperties": false
  },
  "request": {
    "method": "GET",
    "url": "https://api.example.test/items/{id}",
    "path": { "id": "/id" },
    "response": "json"
  }
}
```

Credential input/property나 Authorization header를 schema/manifest에 넣지 않는다. Connection의 write-only credential과 `headerCredentials` mapping을 사용한다.

### 실행 규칙

- Built-in ID는 `builtin.web-search`, `builtin.web-scrape`, `builtin.http`, `builtin.file`, `builtin.shell`, `builtin.code-runner`다.
- Web Search는 vendor SDK가 아니라 저장된 Tool Service Connection의 declarative HTTP mapping을 실행한다. GET/query와 POST/JSON, query·limit field, static parameter, JSON Pointer result path, title/URL/snippet/content field를 설정할 수 있다. Firecrawl과 SearXNG은 이 공통 계약을 채우는 Studio preset이며 Custom Search API도 같은 실행 경로를 사용한다.
- Web Scrape는 같은 Tool Service의 `scrapeUrl`, URL field, static parameter와 content/title/source JSON Pointer mapping을 사용한다. Firecrawl preset은 Search와 Scrape를 모두 채우고 SearXNG preset은 Search만 제공한다.
- OpenAPI import는 project-contained OpenAPI 3.0/3.1 YAML/JSON과 local `#/...` reference만 지원한다. 외부 `$ref`, cookie parameter, 지원하지 않는 body/content는 경고 또는 fail closed다.
- Tool input/output JSON Schema의 `pattern`과 `patternProperties`는 길이, group/lookaround, backreference와 quantifier를 제한하는 safe-regex 검사에 통과해야 한다. unsafe regex가 있으면 manifest를 등록하지 않는다.
- Local Command, Shell과 Code Runner는 approved Local Runtime Connection의 no-network/read-only/non-root container에서 resource bound와 timeout을 적용한다.
- TypeScript Module은 `--allow-modules` 또는 동등한 Studio host capability가 있어야 한다. host는 esbuild bundle만 만들고 실행은 approved Node container에서 수행한다.
- HTTP/OpenAPI의 `read` 선언은 외부 전송 risk를 낮추지 않고, Local Command/Module은 destructive로 정규화한다.
- CLI의 위험 Tool 승인은 반복 가능한 exact `--approve-tool <id>` 또는 TTY의 call-time one-call prompt를 사용하며, non-TTY는 사전 승인 없는 call을 거부한다. 저장 MCP catalog id는 Connection id와 exact discovered action을 함께 묶으므로 같은 Tool 이름의 다른 Connection이나 action 교체가 승인을 재사용하지 못한다.

새 runtime Tool을 코드로 제공할 때는 `ToolDefinition`의 serializable manifest와 `execute(input, context)`를 `ToolRegistry`에 등록한다. Connection이 필요한 Tool은 `connectionKinds`를 선언하고 graph binding에서 `connectionId`를 제공한다. executor나 credential 값을 graph에 넣지 않는다.

## Skill 추가

폴더 이름과 `SKILL.md`의 `name`은 같아야 한다.

```text
review-project/
  SKILL.md
  references/checklist.md
  assets/report-template.md
  scripts/check.mjs
```

```yaml
---
name: review-project
description: Review a project with a fixed checklist.
license: MIT
metadata:
  harnest-tools: '["builtin.file"]'
  harnest-connections: local-runtime-main
  harnest-permissions: filesystem:read
---
Follow references/checklist.md and report concrete evidence.
```

`harnest-tools`, `harnest-connections`, `harnest-permissions`는 공개 Agent Skills 표준 필드가 아니라 Harnest namespaced metadata 확장이다. catalog에는 name, description, requirements, provenance/trust만 노출된다. Agent에 Skill을 연결해 `activate()`할 때 기록된 provenance content hash를 검증한 뒤 본문을 읽고, provider가 요청한 `assets/` 또는 `references/` resource도 `loadResource()`에서 다시 검증한 뒤 지연 로드한다. 기록된 hash가 맞지 않으면 fail closed한다.

Connection requirement는 기존 exact id(`local-runtime-main`) 또는 `kind:id`(`provider:gemini-main`)를 쓸 수 있다. Studio는 누락 Tool을 먼저 장착하고 exact Connection wizard를 연 뒤 Skill 연결을 자동 재개한다. permission 요구사항은 실행 전에 사용자에게 표시하며 capability를 암묵적으로 확대하지 않는다.

Studio의 **Skills → Add skill**은 다음 위치에 설치한다.

- project: `<project>/.agents/skills` 또는 `<project>/.harnest/skills`
- user: `<user-home>/.agents/skills` 또는 `<user-home>/.harnest/skills`

우선순위는 user보다 project, 같은 scope에서는 `.agents`보다 `.harnest`가 높다. Local folder는 bounded copy를 수행한다. GitHub/GitLab repository URL은 current HEAD를 exact commit으로 고정하고 archive를 받으며, npm package는 exact version과 registry sha512를 확인한다. link/device/traversal, duplicate/reserved provenance, file/byte/decompression 한도를 넘는 archive는 설치하지 않는다.

Script resource는 provenance 표시만으로 실행되지 않는다. Studio **Review** 또는 CLI `skill review`에서 code, bytes, SHA-256을 확인하고 exact hash를 승인해야 읽을 수 있다. 승인 목록은 project-local `.harnest/skill-script-approvals.json`에 저장되고 bytes가 바뀌면 승인이 무효화된다.
