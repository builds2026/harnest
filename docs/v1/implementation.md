# Harnest v1 implementation

완료일: 2026-08-20

## 구현 범위

- `HarnessSpec 0.1`: YAML 1.2 loader, strict schema, component/reference/typed-port/fan-in/cycle/entrypoint/credential/JSON Schema 진단, canonical serializer와 atomic save.
- Core: Studio metadata를 버린 runtime plan, provider-independent Adapter Registry, streaming `AsyncIterable`, timeout/cancel, usage, node trace, JSON output validation과 선언형 test runner.
- Adapter: OpenAI-compatible, Anthropic Messages, Gemini GenerateContent, Ollama를 독립 패키지로 제공. SSE/NDJSON parser, usage/finish mapping, HTTP·network 오류 정규화, AbortSignal을 지원한다.
- CLI: `validate`, `inspect`, `run`, `test`, `studio`. Root echo 예제는 secret이나 외부 서비스 없이 실제 streaming 실행된다.
- Web Studio: Palette drag/drop·click-add, React Flow canvas, typed connection, Inspector, YAML import/export/양방향 의미 동기화, Problems, Save → Validate → Run gating, NDJSON 결과, cancel과 node trace를 구현했다.
- 예제: 정상 echo, 잘못된 graph, OpenAI 환경변수, 별도 custom adapter module.

## 주요 결정

- React Flow node/edge data를 편집 draft로 사용하고 HarnessSpec으로 투영한다. 별도 graph/spec 상태 복제는 두지 않는다.
- YAML text만 문법 오류가 있는 중간 상태를 허용한다. parse가 실패하면 canvas는 마지막 정상 draft를 유지한다.
- Next App Router Route Handler가 저장·검증·실행을 공용 Core에 위임한다. 실행은 `application/x-ndjson` `ReadableStream`이고 request abort를 Core에 전달한다.
- Core는 provider SDK를 포함하지 않는다. Adapter module은 npm package 또는 프로젝트 내부 상대 경로만 허용하며 `allowModuleExecution: true`라는 명시적 SDK gate를 요구한다.
- API key는 `env:NAME` 참조만 허용한다. Core가 해석한 값은 trace에 넣지 않고 provider 오류에 포함돼도 `[REDACTED]`로 치환한다.
- UI state, drag/drop, CLI parsing과 process orchestration은 React·브라우저·Node 표준 기능을 사용했다. 추가 상태관리/DnD/layout/CLI 라이브러리는 넣지 않았다.

## 실행

```bash
npm install
npm run build
npm test
npm run harnest -- validate harnest.yaml
npm run harnest -- inspect harnest.yaml
npm run harnest -- run harnest.yaml --input "hello"
npm run harnest -- test harnest.yaml
npm run harnest -- studio harnest.yaml
```

Studio 기본 주소는 `http://127.0.0.1:3000`이다. 다른 포트는 `--port 3210`처럼 지정한다.

## 검증 결과

- TypeScript workspace build와 Studio typecheck 통과.
- ESLint 전체 통과.
- Vitest: Core, 네 Adapter, CLI, Studio reducer의 8개 파일·24개 테스트 통과.
- CLI echo E2E: validate/inspect/test/run 성공, invalid fixture는 model 호출 전에 진단과 exit 1.
- `harnest studio` Windows process 실행, production build와 실제 Route Handler GET/validate/run 성공.
- Studio UI: 4 components/3 typed connections 로드, Validate 후 Run 활성화, echo streaming과 모든 node success/trace 확인. invalid YAML 입력 중 canvas 보존과 편집 lock 확인.
- Route E2E 출력: `Echo: Answer this request clearly: root e2e`, 12 NDJSON events, `finishReason: stop`, usage 74 tokens.
- 외부 provider는 이 환경에 API key와 로컬 Ollama model이 없어 유료/대용량 실제 호출을 생략했다. 각 wire protocol은 mocked streaming HTTP 응답으로 검증했다.

## 남은 문제

- v0.1 실행 graph는 Model → Prompt → Agent → Output 네 built-in component로 제한된다. Context, Tool, MCP, RAG, Evaluator와 component executor registry는 다음 schema version에서 추가해야 한다.
- 자동 retry, 영속 Trace/비용 store, 평가 실험 UI는 없다. 현재 retryable 오류는 정규화해 전달하며 timeout/cancel과 선언형 문자열 assertion까지만 제공한다.
- YAML은 의미적으로 round-trip하지만 저장 시 주석, anchor와 원래 서식은 canonical YAML로 정규화된다.
- `@harnestai/studio`는 현재 monorepo의 private workspace app이며 `harnest studio`는 개발 서버를 실행한다. 독립 npm 배포 전에는 Studio package 배포/production launcher 구성이 필요하다.

조사 근거는 [research.md](./research.md)에 정리했다.