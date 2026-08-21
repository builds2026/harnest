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

- Built-in ID는 `builtin.web-search`, `builtin.http`, `builtin.file`, `builtin.shell`, `builtin.code-runner`다.
- Web Search는 vendor SDK가 아니라 저장된 Tool Service Connection의 declarative HTTP mapping을 실행한다. GET/query와 POST/JSON, query·limit field, static parameter, JSON Pointer result path, title/URL/snippet/content field를 설정할 수 있다. Firecrawl과 SearXNG은 이 공통 계약을 채우는 Studio preset이며 Custom Search API도 같은 실행 경로를 사용한다.
- OpenAPI import는 project-contained OpenAPI 3.0/3.1 YAML/JSON과 local `#/...` reference만 지원한다. 외부 `$ref`, cookie parameter, 지원하지 않는 body/content는 경고 또는 fail closed다.
- Tool input/output JSON Schema의 `pattern`과 `patternProperties`는 길이, group/lookaround, backreference와 quantifier를 제한하는 safe-regex 검사에 통과해야 한다. unsafe regex가 있으면 manifest를 등록하지 않는다.
- Local Command는 `shell:false`, exact host command permission, project cwd, bounded input/output와 timeout을 사용한다.
- TypeScript Module은 `--allow-modules` 또는 동등한 Studio host capability가 있어야 하며 OS sandbox가 아니다. same-process 동기 block은 timeout/abort로 회수할 수 없으므로 trusted module에만 사용한다.
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

Studio의 **Skills → Add skill**은 다음 위치에 설치한다.

- project: `<project>/.agents/skills` 또는 `<project>/.harnest/skills`
- user: `<user-home>/.agents/skills` 또는 `<user-home>/.harnest/skills`

우선순위는 user보다 project, 같은 scope에서는 `.agents`보다 `.harnest`가 높다. Local folder는 bounded copy를 수행한다. Git/package 입력은 immutable pin과 승인을 검사하지만, 현재 Studio host에는 remote materializer가 없으므로 실제 원격 내려받기는 실패한다. 먼저 로컬로 검토한 폴더를 설치하는 경로가 동작하는 기본 경로다.

Script resource는 provenance 표시만으로 실행되지 않는다. 현재 hash를 포함한 `authorizeScript` callback을 host가 제공하고 그 요청을 승인해야 읽을 수 있다. 기본 Studio/CLI에는 이 interactive script 승인 흐름이 아직 없다.
