# v1.2 run guide

## 설치와 기본 확인

```powershell
npm install
npm run harnest -- validate examples/rag/harnest.yaml -- --allow-modules
npm run harnest -- inspect examples/rag/harnest.yaml -- --allow-modules
```

CLI 명령은 `validate`, `inspect`, `run`, `test`, `runs`, `trace`, `studio`, `connections`, `connect`, `connection`, `skill`이다. 외부 capability는 기본 거부다.

```powershell
npm run harnest -- run examples/rag/harnest.yaml -- --input "How are files protected?" --allow-modules --allow-files --context-root knowledge
npm run harnest -- test examples/evaluation-loop/harnest.yaml -- --allow-modules
npm run harnest -- runs examples/rag/harnest.yaml -- --limit 20
npm run harnest -- trace <run-id> examples/rag/harnest.yaml -- --json
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

## Studio

```powershell
npm run harnest -- studio harnest.yaml -- --port 3000
```

브라우저에서 `http://127.0.0.1:3000`을 연다. 실기능을 바로 시험하려면 `npm run harnest -- studio examples/gemini-full-stack/harnest.yaml`을 사용한다. Studio는 선언된 `gemini-main` → `web-main` → `sandbox-main` 누락을 읽고 해당 설정만 차례로 띄운다.

Studio는 `127.0.0.1`에 server를 띄운다. 모든 request는 URL과 일치하는 literal-loopback Host를 요구하고, mutation은 같은 Origin도 요구한다. 일반 흐름은 다음과 같다.

1. 빈 canvas에서 RAG, Web Research, Coding Agent, MCP Agent, Evaluation Loop 중 하나를 고른다.
2. 필요한 Connection은 자동으로 열리며 서비스와 credential만 넣고 **Connect**한다. 저장·로그인/승인·test·Tool discovery가 한 동작으로 이어진다.
3. Agent Tool/Skill port의 `+`에서 compatible 항목을 연결한다.
4. **Validate** 후 input을 넣고 **Run**한다. 위험 Tool 요청은 exact 인자를 확인해 **Approve once** 또는 **Deny**한다.
5. Trace에서 turn, Tool call/approval/result, Skill 사용과 run history를 확인한다.
6. YAML은 하단 **Advanced** 진단용이며 정상 commissioning에 필수는 아니다.

Connection credential은 password field에 한 번 입력하며 browser로 다시 반환되지 않는다. vault는 Windows DPAPI, macOS Keychain, Linux Secret Service 중 안전한 OS backend를 사용하고 plaintext fallback은 없다.

CLI `validate`와 Studio **Validate**는 저장 Connection metadata도 읽어 Model·MCP·Tool binding의 missing, disconnected/unavailable, incompatible kind를 root graph와 subgraph 모두에서 오류로 보고한다. Provider는 등록 Adapter model probe, MCP는 protocol discovery, Web Search/Scrape는 저장 mapping, 일반 HTTP API는 endpoint/auth probe, Local Runtime은 container image/command probe를 수행한다.

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
