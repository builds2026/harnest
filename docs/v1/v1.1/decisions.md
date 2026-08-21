# Harnest v1.1 architecture decisions

## ADR-01 — Incremental HarnessSpec 0.2

`0.1`은 그대로 parse·validate·execute한다. 고급 graph는 `0.2`의 generic component envelope, conditional connection, named subgraph와 runtime policy를 사용한다. Parser가 저장 문서의 version을 임의로 바꾸지 않으며, 두 version은 Compiler에서 같은 Runtime Plan으로 정규화한다.

이 결정은 기존 예제와 Adapter 사용자를 깨뜨리지 않으면서 고정 Zod union을 확장 지점에서 제거한다.

## ADR-02 — Definition과 Manifest 분리

서버의 `ComponentDefinition`은 config schema, port, validator와 executor를 가진다. 클라이언트에는 함수가 제거된 `ComponentManifest`만 전달한다. Core validator, compiler, runtime과 Studio catalog가 같은 registry를 사용한다.

Custom extension module은 기존 Adapter loader와 같은 npm/project-relative realpath 경계와 명시적 code-execution gate를 거친다. Studio browser는 extension code를 import하지 않는다.

## ADR-03 — DAG super-step과 bounded Loop

Root graph와 named subgraph는 DAG다. Compiler가 topological layer를 만들고 Runtime이 같은 layer를 병렬 실행한다. Layer 시작 state는 immutable snapshot이며 patch는 barrier 뒤 merge한다.

반복은 임의 back-edge scheduler가 아니라 `Loop` component가 named subgraph를 재사용하는 방식이다. `maxIterations`는 필수이고 timeout, Token, 비용과 종료 predicate를 다음 회차 전에 검사한다. 전체 실행은 runtime timeout과 budget으로 별도 제한한다.

## ADR-04 — 선언형 Predicate와 결정적 State

Edge condition과 Loop exit는 JSON path + 제한된 operator로 표현한다. `eval`, function serialization과 arbitrary JavaScript는 허용하지 않는다.

State update는 key와 reducer를 명시한다. 같은 super-step에서 reducer 없이 같은 key를 replace하는 graph는 preflight에서 거부한다. 기본적으로 last-writer-wins를 사용하지 않는다.

## ADR-05 — Tool은 연결로 권한을 얻는다

Agent는 graph에서 자기 input port로 연결된 Local/MCP Tool과 Context만 받는다. Tool name은 component namespace를 사용하고 발견된 tool 중 선택된 것만 호출한다. Local module, stdio process, HTTP host와 file context는 각각 capability boundary를 통과해야 한다.

Provider-native autonomous tool-call은 v1.1에서 활성화하지 않는다. Tool 실행은 명시적인 Local/MCP Tool component와 graph 연결만으로 일어나므로, Agent가 graph 밖 tool을 임의 호출할 수 없다.

## ADR-06 — 같은 Runtime, 같은 Trace

Studio API, CLI, SDK와 Test Runner는 모두 `HarnessRuntime`의 streaming 경로를 사용한다. `invoke()`는 stream을 수집할 뿐 별도 실행 로직을 갖지 않는다.

Trace는 실행 Spec과 분리하고 `.harnest/runs/<runId>.ndjson`에 저장한다. Node input/output/state patch, edge 선택, retry attempt, loop iteration, context/tool/evaluator metadata와 usage를 기록한다. 선언 secret과 민감 key는 redaction하며, 일반 payload는 크기·깊이·collection 수를 제한해 저장한다.

## ADR-07 — Native Studio 확장

기존 React reducer, browser Drag and Drop, React Flow와 native form control을 유지한다. Palette search/category, node ports, defaults와 Inspector는 Component manifest에서 생성한다. Edge 조건과 data mapping은 Edge Inspector가 편집하고, Subgraph는 동일 Canvas의 graph lens로 편집한다.

추가 state manager, DnD, form, code editor와 layout dependency는 도입하지 않는다.

## ADR-08 — 공식 MCP SDK v2

MCP `2026-07-28` transport와 tool semantics를 직접 구현하지 않는다. 공식 `@modelcontextprotocol/client` v2로 stdio와 Streamable HTTP를 연결하고 discovery/call/error/cancellation을 처리한다. HTTP는 최신 protocol negotiation을 사용하고, stdio는 project가 명시한 executable과 환경변수만 전달한다.
