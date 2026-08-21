# Harnest v1.1 research

조사일: 2026-08-20~21

Firecrawl CLI와 `npx firecrawl`은 이 환경에서 실행할 수 없어, 공식 문서와 공식 저장소만 대상으로 웹 검색과 원문 확인을 진행했다.

## 제품 용어

- **Graph Engineering**은 범용 업계 표준명으로 가정하지 않고 Harnest의 제품 용어로 정의한다. Agent Harness를 Component, Typed Port, Edge, State, Branch, Join, Subgraph로 명시하고 실행 전 검증 가능한 그래프로 만드는 작업이다.
- **Loop Engineering**은 tool-use, plan→execute→validate, generate→evaluate→improve 반복을 종료 조건과 횟수·시간·Token·비용 예산 안에서 설계하고 관찰하는 작업이다.
- **Harness Engineering**은 모델을 둘러싼 입력 처리, 도구 orchestration, 환경, 검증, 관측과 feedback loop를 설계하는 작업이다. Anthropic은 agent harness를 입력을 처리하고 tool call을 조정해 결과를 반환하는 시스템으로, evaluation harness를 실행·기록·채점·집계 인프라로 구분한다. OpenAI도 환경·도구·검증·feedback loop를 agent가 읽고 집행할 수 있게 만드는 일을 harness engineering으로 설명한다.

따라서 Harnest는 범용 업무 자동화기가 아니라 **Agent Harness의 구성 요소와 실행 구조를 직접 설계하는 Visual Graph Engineering Platform**으로 유지한다.

## 그래프 실행 모델

LangGraph는 node가 공유 state를 읽고 update를 반환하며, 한 super-step에서 활성 node들을 병렬 실행한다. 복수 outgoing edge는 다음 super-step의 병렬 fan-out이고, conditional edge는 state를 읽어 다음 node를 선택한다. Checkpoint는 super-step 경계에 저장된다. 이 모델에서 다음 원칙을 채택했다.

- 상위 graph와 named subgraph는 DAG로 컴파일한다.
- 같은 topological layer는 실제 병렬 실행하고, layer 시작 state snapshot을 공유한다.
- 병렬 state patch는 barrier 뒤 결정적으로 합친다. reducer 없이 같은 key를 덮어쓰는 경우 실행 전에 거부한다.
- 조건은 임의 JavaScript가 아니라 JSON path와 제한된 operator로 표현한다.
- 비선택 branch는 `skipped`로 확정해 join이 영원히 대기하지 않게 한다.
- 범용 cyclic scheduler 대신 bounded `Loop` component가 named subgraph를 반복한다. v1.1의 Back Edge **또는** Loop 요구 중 Loop를 선택하면 정적 검증과 hard budget을 더 작은 실행 모델로 보장할 수 있다.

AutoGen GraphFlow는 sequential, parallel, conditional, loop와 `all`/`any` activation group을 보여 주는 비교 구현이지만 공식적으로 experimental이다. 실행 dependency로 채택하지 않고 join semantics의 참고로만 사용한다.

근거:

- [LangGraph Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)
- [LangGraph persistence and super-steps](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)
- [AutoGen GraphFlow](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html)
- [Anthropic Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)

## Component와 Studio

Core의 `ComponentDefinition`은 config JSON Schema, Port, Validator와 Executor를 보유한다. Studio에는 함수나 module code가 아니라 직렬화 가능한 manifest만 전달한다. Palette, typed handle, 기본 config와 Inspector field가 같은 manifest를 사용하므로 새 Component를 추가할 때 Core와 Studio의 type switch를 함께 고칠 필요가 없다.

React Flow의 custom node와 `Handle`은 여러 typed source/target port를 표현할 수 있고, 전체 graph의 `isValidConnection`에서 연결 검증을 수행하는 방식을 권장한다. 저장되는 실행 의미는 React Flow 내부 object가 아니라 HarnessSpec이며, Canvas는 그 투영이다.

근거:

- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)
- [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes)
- [React Flow handles](https://reactflow.dev/api-reference/components/handle)
- [React Flow save and restore](https://reactflow.dev/examples/interaction/save-and-restore)
- [React Flow sub-flows](https://reactflow.dev/learn/layouting/sub-flows)

## MCP 2026-07-28

2026-08-20 현재 최신 MCP 명세는 `2026-07-28`이고 TypeScript SDK v2가 이를 지원한다. 이 revision은 protocol-level session과 initialize handshake를 제거하고 각 요청을 self-contained하게 만들었다. 표준 transport는 newline-delimited stdio와, 단일 POST가 JSON 또는 request-scoped SSE를 반환하는 Streamable HTTP다.

직접 JSON-RPC/transport를 재구현하지 않고 공식 `@modelcontextprotocol/client` v2의 `Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`, `listTools()`와 `callTool()`을 사용한다. `isError: true`인 tool result와 protocol/transport exception을 구분하고 항상 client를 닫는다. stdio process, HTTP host, project file context는 각각 명시된 capability boundary를 통과해야 한다.

근거:

- [MCP 2026-07-28 release](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md)
- [MCP 2026 transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP TypeScript client guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md)
- [MCP SDK v2 migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)

## Harness와 Evaluation

Evaluation은 최종 문자열만 비교하는 작업이 아니다. Agent는 여러 turn에서 tool을 호출하고 state를 바꾸므로 transcript, 실제 outcome, latency, usage와 tool behavior를 함께 평가해야 한다. Harnest의 기본 evaluator는 deterministic code grader로 제한하고 output schema, 문자열, tool call, latency와 iteration count를 지원한다. 모델 기반 judge는 provider 선택·비용·calibration 문제가 있으므로 v1.1 기본 evaluator에 넣지 않는다.

근거:

- [Anthropic Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [OpenAI Harness engineering](https://openai.com/index/harness-engineering/)

## 채택하지 않은 것

- LangGraph/AutoGen runtime dependency: 기존 Adapter·검증·streaming 계약을 버리고 재구현하게 되므로 semantics만 참고한다.
- arbitrary expression/eval: 직렬화, 재현성, 보안을 깨뜨린다.
- 범용 cyclic scheduler: bounded Loop+Subgraph가 이번 요구를 더 작고 안전하게 충족한다.
- DB와 별도 run index: 프로젝트 단위 `.harnest/runs/<runId>.ndjson`과 directory scan이면 로컬 MVP에 충분하다.
- 추가 UI state, DnD, form, layout library: 현재 React reducer, 브라우저 DnD, React Flow와 native form control로 충분하다.
