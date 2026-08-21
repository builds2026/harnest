# v1.2 run guide

## 설치와 기본 확인

```powershell
npm install
npm run harnest -- validate examples/rag/harnest.yaml --allow-modules
npm run harnest -- inspect examples/rag/harnest.yaml --allow-modules
```

CLI 명령은 `validate`, `inspect`, `run`, `test`, `runs`, `trace`, `studio`다. 외부 capability는 기본 거부다.

```powershell
npm run harnest -- run examples/rag/harnest.yaml --input "How are files protected?" --allow-modules --allow-files --context-root knowledge
npm run harnest -- test examples/evaluation-loop/harnest.yaml --allow-modules
npm run harnest -- runs examples/rag/harnest.yaml --limit 20
npm run harnest -- trace <run-id> examples/rag/harnest.yaml --json
```

필요한 경우에만 다음 capability를 정확히 허용한다.

- `--allow-files`: project-contained Context/file 접근
- `--context-root <relative-path>`: Context root 제한, 반복 가능
- `--allow-process <exact-command>`: MCP stdio/local Tool command, 반복 가능
- `--allow-network <host[:port]>`: MCP/HTTP host, 반복 가능
- `--allow-modules`: 검토한 adapter/component/TypeScript Tool module import
- `--approve-tool <exact-id>`: 해당 Tool id의 위험 call 사전 승인, 반복 가능

이 옵션은 sandbox를 만들지 않는다. 특히 `--allow-process`와 `--allow-modules`는 검토한 코드에만 사용한다.

`--approve-tool`은 glob이나 prefix가 아닌 exact id만 받는다. 사전 승인하지 않은 위험 Tool은 TTY에서 call id·risk·input을 보여주고 그 call 한 번만 묻고, non-TTY에서는 기본 거부한다. `studio` 명령은 지정된 exact id 목록을 `HARNEST_APPROVE_TOOLS`로 시작한 Studio process에 전달한다.

저장 MCP Connection에서 발견한 Tool의 exact id는 Connection id와 discovered action을 함께 묶은 catalog id다. 따라서 같은 이름이어도 다른 Connection이나 바뀐 action에는 승인이 전달되지 않는다. Studio catalog가 제공한 id를 사용한다. 기존 raw `mcp-tool` 호환 경로는 설정한 action 이름을 id로 사용하므로 예제처럼 `--approve-tool lookup-city`를 명시한다.

### v1.1 raw MCP 호환 경로

`connectionId` 없이 transport 설정을 직접 가진 기존 `mcp-tool` node도 계속 실행된다. 새 Studio 흐름에는 재사용·상태·discovery catalog가 있는 저장 MCP Connection을 권장한다.

- stdio는 공식 transport로 실제 child process를 실행한다. `node`/`node.exe`는 현재 Node executable의 canonical real path로 고정하며, 다른 command는 absolute canonical non-link regular file이어야 한다. `--allow-process` exact match, project cwd, SDK minimal environment, 최대 128개 args·각 8,192자, 최대 10분 timeout을 적용한다.
- HTTP는 공식 Streamable HTTP transport를 사용한다. remote HTTPS 또는 literal-loopback HTTP, exact `--allow-network`, redirect 거부, 최대 64개 `env:NAME` header, 2 MiB response stream, 최대 16 Tool-list page와 같은 timeout을 적용한다.
- 두 transport 모두 실행할 action이 server discovery 결과에 있어야 하고 위험 call은 별도 exact approval을 통과해야 한다.

## Studio

```powershell
npm run harnest -- studio harnest.yaml --port 3000
```

Studio는 `127.0.0.1`에 dev server를 띄운다. 모든 request는 URL과 일치하는 literal-loopback Host를 요구하고, mutation은 같은 Origin도 요구한다. 일반 흐름은 다음과 같다.

1. 빈 canvas에서 RAG, Web Research, Coding Agent, MCP Agent, Evaluation Loop 중 하나를 고른다.
2. Connections palette 또는 Inspector의 **Connect**에서 필요한 Connection을 저장하고 test한다.
3. Agent Tool/Skill port의 `+`에서 compatible 항목을 연결한다.
4. **Validate** 후 input을 넣고 **Run**한다. 위험 Tool 요청은 exact 인자를 확인해 **Approve once** 또는 **Deny**한다.
5. Trace에서 turn, Tool call/approval/result, Skill 사용과 run history를 확인한다.
6. YAML은 하단 **Advanced** 진단용이며 정상 commissioning에 필수는 아니다.

Connection credential은 password field에 한 번 입력하며 browser로 다시 반환되지 않는다. 현재 secure vault는 Windows DPAPI가 필요하다.

CLI `validate`와 Studio **Validate**는 저장 Connection metadata도 읽어 Model·MCP·Tool binding의 missing, disconnected/unavailable, incompatible kind를 root graph와 subgraph 모두에서 오류로 보고한다. Provider **Test**는 현재 등록된 Adapter로 최소 model probe를 실행한다. MCP는 protocol discovery, Web Search Tool Service는 저장된 request/response mapping으로 search probe를 실행한다. 일반 HTTP API와 Local Runtime은 아직 config validation 중심이다.

Provider stream parser는 기본 total 16 MiB, line/event 8 MiB, HTTP error body 64 KiB로 제한한다. Adapter는 한 응답의 Tool call 128개와 call당 argument 1 MiB를 넘기지 않으며, Agent는 설정된 `maxToolCalls`와 provider turn별 text 8 MiB를 별도로 적용한다. 저장 Trace는 file당 8 MiB, NDJSON event당 64 KiB, run당 10,000 event를 넘으면 read/append를 거부한다.

### Template 준비 조건

- RAG: 실제 text 또는 file knowledge를 설정해야 한다.
- Web Research: Provider와 Web Search Connection이 필요하다. Studio에서 Firecrawl, SearXNG 또는 Custom Search API를 고르고 endpoint·인증·request/response mapping을 저장한다.
- Coding Agent: Provider, Local Runtime, exact process/module capability와 call-time 승인이 필요하다.
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
