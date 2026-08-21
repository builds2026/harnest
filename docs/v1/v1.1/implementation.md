# Harnest v1.1 구현 범위

완료일: 2026-08-21

Harnest v1.1은 기존 v0.1 HarnessSpec과 Adapter 실행 경로를 유지하면서, 실제로 설계·검증·실행·관찰할 수 있는 Visual Graph Engineering Platform으로 확장했다. 동작하지 않는 placeholder는 포함하지 않았다.

## 구현된 범위

| 영역 | 구현 |
| --- | --- |
| Spec | 엄격한 v0.1 호환과 generic component envelope 기반 v0.2, 조건·select·state Edge, named subgraph, retry와 budget |
| Component | `ComponentRegistry`, 직렬화 가능한 `ComponentManifest`, 서버 전용 validator/executor, JSON Schema config와 generic Inspector |
| Built-in | Model, Prompt, Agent, Output, Context, Memory, Local Tool, MCP Tool, Router, Evaluator, Join, Subgraph, Loop의 13종 |
| Graph | 실행 전 port/type/ref/reachability/join/state-conflict/cycle 검증, topological layer 병렬 실행, fan-out/fan-in, 조건 branch, JSON Pointer projection, 결정적 state merge |
| Loop | named subgraph 반복, 필수 `maxIterations`, 종료 predicate, timeout, Token·비용 budget, Evaluator 기반 재실행, 회차별 Trace |
| Tool·Context | 등록된 Local Tool, MCP v2 stdio·Streamable HTTP discovery/call, static/file/directory Context, project Memory |
| Runtime | streaming 단일 경로, 취소, 협조하지 않는 custom executor까지 강제하는 timeout, retry-safe 재시도, 모든 attempt의 usage/cost 집계 |
| Evaluation | equals/includes/matches/output-schema/tool-called/latency/iterations evaluator와 Test Runner, schema·regex preflight |
| Trace | node input/output/state, active/inactive Edge, retry, iteration, Context/Tool/Evaluation, usage/cost를 프로젝트 NDJSON에 영속 저장 |
| Studio | 13종 catalog 검색·분류·DnD, typed ports, schema-driven Inspector, Edge 조건/data/state 편집, subgraph lens, 실행 pulse·iteration badge, Problems/Run/Tests/Trace |
| CLI | validate, inspect, run, test, runs, trace, studio와 default-deny capability flags |

## 실행 의미

- `HarnessSpec`이 유일한 저장 의미다. React Flow node/edge는 Spec의 controlled projection이고, YAML은 parse 성공 시에만 Canvas를 교체한다.
- Root graph와 subgraph는 DAG다. Compiler가 만든 topological layer를 Runtime이 병렬 실행하고, 같은 layer의 state patch는 barrier 뒤 병합한다.
- 반복은 임의 back-edge가 아니라 bounded `Loop`가 named subgraph를 호출하는 구조다. 이 선택으로 무한 cycle을 정적 거부하면서 실행 budget을 한 곳에서 강제한다.
- Studio API, CLI, SDK와 Test Runner는 모두 같은 `HarnessRuntime.stream()`을 사용한다. `invoke()`는 stream을 수집하는 편의 API다.
- Subgraph node와 Edge ID는 `loop/subgraph/local-id` 형태로 scope되어 Canvas와 영속 Trace가 정확한 회차·요소를 가리킨다.

## 확장과 신뢰 경계

- Custom module은 `register({ adapters, components, tools })`로 새 정의를 등록한다. Core validator/compiler/runtime은 registry를 사용하므로 새 타입을 위한 switch 수정이 필요 없다.
- 브라우저에는 실행 함수가 제거된 manifest만 전달한다. 서버 module 실행은 `--allow-modules` 또는 `HARNEST_ALLOW_MODULES=1`이 없으면 거부한다.
- file Context, process, network는 각각 별도 capability가 필요하다. project-relative path는 `realpath`로 symlink·Windows junction까지 확인한다.
- stdio는 exact command와 minimal environment, HTTP는 exact host·no redirect·`env:NAME` header만 허용한다.
- 선언된 secret은 첫 `run-start` 전에 수집해 값과 민감 key를 redaction한다. Trace event는 크기·깊이·collection 수가 제한된다.
- 정규식은 길이와 문법을 제한한 공용 guard를 predicate, evaluator, test와 JSON Schema `pattern`에 적용해 event-loop ReDoS를 차단한다.

## 주요 위치

- `packages/core`: Spec, registry, validator/compiler, runtime, evaluator와 trace 계약
- `packages/core/src/node.ts`: module loader, Context/Memory, MCP client, `FileRunStore`
- `packages/cli`: CLI와 capability 전달
- `frontend`: Next.js Studio와 validate/run/test/runs API
- `examples/rag`, `examples/mcp-tool-agent`, `examples/evaluation-loop`: 실행 가능한 대표 예제

조사 근거는 [research.md](./research.md), 아키텍처 결정은 [decisions.md](./decisions.md), 실행법은 [run.md](./run.md), 검증 증거는 [tests.md](./tests.md), 의도적인 제한은 [remaining-issues.md](./remaining-issues.md)에 기록했다.
