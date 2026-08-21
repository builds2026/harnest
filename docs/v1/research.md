# Harnest v1 research

조사일: 2026-08-20

## 적용한 결정

- Studio는 React Flow controlled graph를 사용하고 HarnessSpec을 유일한 의미 원본으로 유지한다. Palette drag/drop은 브라우저 기본 HTML Drag and Drop API를 쓴다.
- YAML 편집 중 문법 오류가 나도 마지막 정상 graph를 보존하고, parse 성공 시에만 전체 Spec을 교체한다.
- Next.js App Router Route Handler를 로컬 BFF로 사용한다. 저장·검증·실행은 모두 `@harnest/core`를 호출하며 실행 스트림은 NDJSON `ReadableStream`으로 전달한다.
- Core는 단일 `AsyncIterable` 실행 경로만 제공한다. `invoke`는 같은 스트림을 수집하므로 streaming/non-streaming 로직이 갈라지지 않는다.
- Provider SDK를 Core에 넣지 않는다. OpenAI-compatible, Anthropic, Gemini, Ollama Adapter는 별도 패키지이고, Spec에 명시한 모듈만 동적 로드한다.
- MCP는 이번 단계에서 사용하지 않는 의존성을 추가하지 않고 Core/CLI의 프로그래밍 API를 재사용할 확장점만 둔다.

## 1차 자료

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [YAML 1.2.2 specification](https://yaml.org/spec/1.2.2/)
- [React Flow drag and drop](https://reactflow.dev/examples/interaction/drag-and-drop)
- [React Flow handles](https://reactflow.dev/learn/customization/handles)
- [React Flow connection validation](https://reactflow.dev/examples/interaction/validation)
- [React Flow accessibility](https://reactflow.dev/learn/advanced-use/accessibility)
- [Next.js Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- [Next.js Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)
- [Next.js backend-for-frontend guidance](https://nextjs.org/docs/app/guides/backend-for-frontend)
- [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Anthropic streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Gemini GenerateContent API](https://ai.google.dev/api/generate-content)
- [Ollama chat API](https://docs.ollama.com/api/chat)
- [Ollama streaming](https://docs.ollama.com/api/streaming)
- [MCP TypeScript client guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md)
- [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)

## 의도적으로 제외한 것

- Monaco, Zustand, 별도 DnD·자동 layout 라이브러리: 현재 네 종류 노드 편집에는 React state와 브라우저 API로 충분하다.
- Provider SDK: Adapter wire format에 필요한 기능보다 의존성이 커지고 Core의 provider 독립성을 약화한다.
- 완전한 MCP server/client: v1 prompt가 안정적인 재사용 API까지만 요구한다. 실제 MCP tool surface가 확정될 때 추가한다.

