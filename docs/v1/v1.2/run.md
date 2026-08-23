# v1.2 run guide

## 설치와 기본 확인

```powershell
npm install
npm run harnest -- validate examples/rag/harnest.yaml -- --allow-modules
npm run harnest -- inspect examples/rag/harnest.yaml -- --allow-modules
```

CLI 명령은 `init`, `bundle`, `validate`, `inspect`, `run`, `test`, `runs`, `trace`, `serve`, `mcp serve`, `studio`, `connections`, `connect`, `connection`, `skill`이다. 외부 capability는 기본 거부다.

```powershell
npm run harnest -- run examples/rag/harnest.yaml -- --input "How are files protected?" --allow-modules --allow-files --context-root knowledge
npm run harnest -- test examples/evaluation-loop/harnest.yaml -- --allow-modules
npm run harnest -- runs examples/rag/harnest.yaml -- --limit 20
npm run harnest -- trace <run-id> examples/rag/harnest.yaml -- --json
```

새 폴더에는 안전한 Gemini starter를 만들 수 있다. 기존 파일은 덮어쓰지 않는다.

```powershell
npm run harnest -- init my-agent
npm run harnest -- studio my-agent/harnest.yaml
```

배포 artifact는 검증된 YAML과 project `assets/`만 포함하는 standard ZIP `.harnest`다. `.env`, Connection/vault, Trace와 `.harnest/` local state는 포함하지 않으며 기존 output을 덮어쓰지 않는다.

```powershell
npm run harnest -- bundle my-agent/harnest.yaml -- --output support-agent.harnest
```

필요한 경우에만 다음 capability를 정확히 허용한다.

- `--allow-files`: project-contained Context/file 접근
- `--context-root <relative-path>`: Context root 제한, 반복 가능
- `--allow-process <exact-command>`: 검토한 legacy local Tool command, 반복 가능
- `--allow-network <host[:port]>`: MCP/HTTP host, 반복 가능
- `--allow-modules`: 검토한 adapter/component/TypeScript Tool module import
- `--approve-tool <exact-id>`: 해당 Tool id의 위험 call 사전 승인, 반복 가능

이 옵션은 sandbox를 만들지 않는다. 특히 `--allow-process`와 `--allow-modules`는 검토한 코드에만 사용한다.

`--approve-tool`은 glob이나 prefix가 아닌 exact id만 받는다. 사전 승인하지 않은 위험 Tool은 TTY에서 call id·risk·input을 보여주고 그 call 한 번만 묻고, non-TTY에서는 기본 거부한다. `studio` 명령은 지정된 exact id 목록을 `HARNEST_APPROVE_TOOLS`로 시작한 Studio process에 전달한다.

저장 MCP Connection에서 발견한 Tool의 exact id는 Connection id와 discovered action을 함께 묶은 catalog id다. 따라서 같은 이름이어도 다른 Connection이나 바뀐 action에는 승인이 전달되지 않는다. Studio catalog가 제공한 id를 사용한다.

### v1.1 raw MCP 호환 경로

`connectionId` 없이 transport 설정을 직접 가진 기존 `mcp-tool`의 HTTP 경로만 제한적으로 유지한다. raw stdio는 OS isolation을 보장할 수 없어 fail closed한다. stdio가 필요하면 저장 MCP Connection을 만들며, Harnest가 승인된 no-network container에서 실행한다.

- HTTP는 공식 Streamable HTTP transport를 사용한다. remote HTTPS 또는 literal-loopback HTTP, exact `--allow-network`, redirect 거부, 최대 64개 `env:NAME` header, 2 MiB response stream, 최대 16 Tool-list page와 같은 timeout을 적용한다.
- 실행할 action은 server discovery 결과에 있어야 하고 위험 call은 별도 exact approval을 통과해야 한다.

### Connection과 Skill을 CLI에서 준비

```powershell
$env:GEMINI_API_KEY = "..."
$env:FIRECRAWL_API_KEY = "..."
npm run harnest -- connect gemini examples/gemini-full-stack/harnest.yaml -- --id gemini-main --secret-env GEMINI_API_KEY
npm run harnest -- connect firecrawl examples/gemini-full-stack/harnest.yaml -- --id web-main --secret-env FIRECRAWL_API_KEY
npm run harnest -- connect sandbox examples/gemini-full-stack/harnest.yaml -- --id sandbox-main --runtime node
npm run harnest -- connections examples/gemini-full-stack/harnest.yaml
```

`npm run` 뒤 Harnest option을 전달할 때는 예시처럼 두 번째 `--`가 필요하다. `connect`는 생성/갱신, credential 저장, OAuth 또는 sandbox 승인, 실제 test를 한 번에 수행한다. key/token은 hidden TTY 입력이나 `--secret-env`로만 받고 argv에 값을 받지 않는다. `connection test|login|disconnect|revoke|delete`로 lifecycle을 관리한다. Skill은 `skill list|install|review|approve`를 사용하며 GitHub/GitLab은 exact commit, npm은 exact version+sha512로 자동 고정한다.

### Studio 없이 사용

```powershell
# literal-loopback HTTP: GET /health, POST /invoke, POST /stream
npm run harnest -- serve harnest.yaml -- --port 8787 --allow-modules

# stdio MCP: invoke_harness Tool
npm run harnest -- mcp serve harnest.yaml -- --allow-modules
```

두 server는 같은 `@harnest/sdk` load/invoke/stream 경로를 사용한다. HTTP request body는 `{ "input": ... }`이고 `/stream`은 NDJSON이다. MCP Tool input은 `{ "message": "..." }` 또는 `{ "input": ... }`이다.

```ts
import { Harnest } from "@harnest/sdk";

const harness = await Harnest.load("./harnest.yaml", { allowModuleExecution: true });
try {
  console.log((await harness.invoke("hello")).output);
  console.log(await harness.test());
} finally {
  await harness.close();
}
```

## Studio

```powershell
npm run harnest -- studio harnest.yaml -- --port 3000
```

브라우저에서 `http://127.0.0.1:3000`을 연다. 실기능을 바로 시험하려면 `npm run harnest -- studio examples/gemini-full-stack/harnest.yaml`을 사용한다. Studio는 선언된 `gemini-main` → `web-main` → `sandbox-main` 누락을 읽고 해당 설정만 차례로 띄운다.

Studio는 `127.0.0.1`에 server를 띄운다. 모든 request는 URL과 일치하는 literal-loopback Host를 요구하고, mutation은 같은 Origin도 요구한다. 일반 흐름은 다음과 같다.

1. 첫 화면에서 RAG, Web Research, Coding Agent, MCP Agent, Evaluation Loop 중 원하는 결과의 **Recipe**를 고른다. 각 card는 필요한 Service와 sample input을 먼저 보여준다.
2. 필요한 **Service** sheet가 자동으로 열린다. credential 또는 endpoint만 넣고 **Connect**하면 저장·OAuth/승인·test·Tool discovery가 이어진다. MCP OAuth는 URL에서 resource metadata, authorization server와 scope를 자동 탐색한다.
3. Studio가 YAML을 자동 저장하고 runtime validation을 연속 실행한다. 상단의 한 개 next action과 **Setup** tab만 따라가면 된다.
4. 상단 **Harnest Playground**에서 새 대화를 열고 요청을 보낸다. 중앙에는 answer와 공개 가능한 실행 timeline, 하단에는 이 Harness가 선언한 모델·Tool/MCP/Skill과 파일 입력, 우측에는 upload·sandbox output·지원 범위가 표시된다. 위험 Tool은 정확한 argument와 사람이 읽을 수 있는 권한 설명을 보고 **Allow once** 또는 **Don’t allow**를 고른다.
5. **Tests**에서 case ID·request·문자열 기대값을 추가·수정·삭제하고 자동 저장/check 뒤 **Run all**로 성공률과 case latency를 본다. object input, Output Schema, Tool-call·latency·iteration 같은 고급 assertion은 YAML에 그대로 보존된다.
6. **Compare**는 같은 input의 A/B component setting을 실행하고 answer·evaluator 품질·비용·속도를 나란히 보여준다. **Activity**는 turn·Tool·approval·fallback·usage·run history를 보여준다.
7. **YAML**은 import/export나 고급 편집이 필요할 때만 사용한다.

Playground 선택은 저장 Harness를 바꾸지 않는다. Code Runner가 있는 Harness만 file attachment를 표시하며 선택한 파일만 container `/mnt/data`에 read-only로 전달한다. 결과 파일은 `/mnt/output`에 저장해야 Sandbox explorer에 돌아온다. 대화 기록·파일 보존·context/cost ceiling은 [Playground 문서](./playground.md)를 따른다.

Model을 선택하면 **Fallback provider**에서 primary와 다른 저장 Provider 하나를 고를 수 있다. primary Adapter가 retryable 오류를 보고한 경우에만 한 번 전환하며 두 attempt의 사용량·비용과 이유가 Activity에 남는다.

Connection credential은 password field에 한 번 입력하며 browser로 다시 반환되지 않는다. vault는 Windows DPAPI, macOS Keychain, Linux Secret Service 중 안전한 OS backend를 사용하고 plaintext fallback은 없다.

CLI `validate`와 Studio의 자동 setup check는 저장 Connection metadata도 읽어 Model·MCP·Tool binding의 missing, disconnected/unavailable, incompatible kind를 root graph와 subgraph 모두에서 오류로 보고한다. Provider는 등록 Adapter model probe, MCP는 protocol discovery, Web Search/Scrape는 저장 mapping, 일반 HTTP API는 endpoint/auth probe, Local Runtime은 container image/command probe를 수행한다.

Provider stream parser는 기본 total 16 MiB, line/event 8 MiB, HTTP error body 64 KiB로 제한한다. Adapter는 한 응답의 Tool call 128개와 call당 argument 1 MiB를 넘기지 않으며, Agent는 설정된 `maxToolCalls`와 provider turn별 text 8 MiB를 별도로 적용한다. 저장 Trace는 file당 8 MiB, NDJSON event당 64 KiB, run당 10,000 event를 넘으면 read/append를 거부한다.

### Template 준비 조건

- RAG: 실제 text 또는 file knowledge를 설정해야 한다.
- Web Research: Provider와 Web Search Connection이 필요하다. Studio에서 Firecrawl, SearXNG 또는 Custom Search API를 고르고 endpoint·인증·request/response mapping을 저장한다.
- Coding Agent: Provider와 Docker/Podman 기반 Sandbox Connection, call-time 승인이 필요하다.
- MCP Agent: Provider, tested MCP Connection과 선택한 discovered Tool이 필요하다.
- Evaluation Loop: Provider Connection을 연결해야 한다.

Template은 이 commissioning을 줄이는 graph 초안이지 외부 credential/resource 없이 즉시 성공하는 demo가 아니다.

## 개발 검증

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Production Studio만 직접 실행하려면 먼저 `npm run build --workspace @harnest/studio` 후 `frontend` 디렉터리에서 `npx next start --hostname 127.0.0.1 --port 3000`을 사용하고 `HARNEST_FILE` 등 capability 환경 변수를 명시한다. 일반 사용에는 CLI의 `studio` 명령이 더 안전하다.
