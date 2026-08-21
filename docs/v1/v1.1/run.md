# Harnest v1.1 실행법

검증 환경은 Node.js 22 이상과 npm 10 이상이다.

## 설치와 기본 실행

```bash
npm install
npm run build
npm test
npm run harnest -- validate harnest.yaml -- --allow-modules
npm run harnest -- run harnest.yaml -- --input "hello" --allow-modules
npm run harnest -- studio harnest.yaml -- --allow-modules
```

두 번째 `--`는 npm이 `--input` 같은 Harnest 옵션을 자체 옵션으로 소비하지 않게 한다. 설치된 `harnest` binary를 직접 실행할 때는 이 구분자가 필요 없다.

## 대표 예제

```bash
# Project-bounded lexical RAG
npm run harnest -- run examples/rag/harnest.yaml -- \
  --input "How are Context paths protected?" \
  --allow-files --context-root knowledge --allow-modules

# 실제 MCP stdio discovery + tool call + Agent
npm run harnest -- run examples/mcp-tool-agent/harnest.yaml -- \
  --input "Which country contains the configured city?" \
  --allow-process node --allow-modules

# generate → evaluate → improve, 2회 뒤 종료
npm run harnest -- run examples/evaluation-loop/harnest.yaml -- \
  --input "Draft answer" --allow-modules
```

선언된 Test Runner도 같은 저장 Spec과 Runtime을 사용한다.

```bash
npm run harnest -- test examples/rag/harnest.yaml -- --allow-files --context-root knowledge --allow-modules
npm run harnest -- test examples/mcp-tool-agent/harnest.yaml -- --allow-process node --allow-modules
npm run harnest -- test examples/evaluation-loop/harnest.yaml -- --allow-modules
```

## Capability

모든 외부 capability는 기본 거부다.

- `--allow-modules`: 검토한 Adapter/Component/Tool module 실행
- `--allow-files`: project 안의 비민감 Context file/directory 읽기
- `--context-root <path>`: 읽을 수 있는 project-relative root를 추가 제한; 반복 가능
- `--allow-process <command>`: exact MCP stdio command 허용; 반복 가능
- `--allow-network <host[:port]>`: exact MCP HTTP host 허용; 반복 가능

Studio CLI는 같은 flag를 `HARNEST_ALLOW_MODULES`, `HARNEST_ALLOW_FILES`, `HARNEST_CONTEXT_ROOTS`, `HARNEST_ALLOW_PROCESS`, `HARNEST_ALLOW_NETWORK` 서버 환경으로 전달한다. Studio는 저장 요청에서 module을 실행하지 않고, Validate/Run/Test 때만 host capability와 Spec 요청의 교집합을 사용한다.

## Run과 Trace 조회

실행 event는 Spec이 있는 project의 `.harnest/runs/<runId>.ndjson`에 저장된다.

```bash
npm run harnest -- runs examples/rag/harnest.yaml
npm run harnest -- trace <run-id> examples/rag/harnest.yaml
npm run harnest -- trace <run-id> examples/rag/harnest.yaml -- --json
```

Project Memory는 같은 project의 `.harnest/memory.json`에 atomic write한다. 이 폴더는 `.gitignore`에 포함되어 있다.
