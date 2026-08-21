# Harnest v1.1 검증 결과

최종 실행: 2026-08-21, Windows, Node.js `v22.16.0`, npm `10.9.2`.

## 전체 자동 검증

| 명령 | 결과 |
| --- | --- |
| `npm run lint` | PASS, ESLint 오류·경고 없음 |
| `npm run typecheck` | PASS, 전체 package build graph + Studio `tsc --noEmit` |
| `npm test` | PASS, 11 source test files / 59 tests |
| `npm run build` | PASS, package build + Next.js 16.3.1 production build |
| `npm pack --workspace @harnest/studio --dry-run` | PASS, 25 files, 33.3 kB package |

Production build는 `/`, `/api/spec`, `/api/validate`, `/api/run`, `/api/test`, `/api/runs`를 생성했다.

주요 회귀에는 다음이 포함된다.

- v0.1 호환 parse/compile/run과 v0.2 registry/component validation
- 실제 topological parallelism, branch active/inactive Trace, conditional object Join key 정렬
- state conflict, reachability, typed port, subgraph scope와 bounded Loop
- retry-safe 정책, 실패 attempt usage/cost budget, cancel terminal event, node/global timeout
- secret 사전수집/redaction, safe-regex와 JSON Schema pattern preflight
- module path realpath/symlink/junction containment과 명시적 execution gate
- Context path/secret-file gate, Memory atomic persistence
- 실제 MCP v2 stdio·Streamable HTTP discovery/call/error와 실패 연결 evict/reconnect
- 4개 provider Adapter의 byte-split SSE/NDJSON, usage, finish, network error, credential preflight
- Studio YAML round-trip, capability intersection, scoped trace projection, inactive Edge pulse 차단, entrypoint 편집

## CLI Integration/E2E

README에 기록된 npm 명령을 그대로 실행했다.

| 흐름 | 결과 |
| --- | --- |
| Root validate/run | PASS; `Echo: Answer this request clearly: parity check`, 82 tokens |
| RAG run/test | PASS; project `knowledge`의 2개 Markdown을 realpath 경계 안에서 검색, `grounded-context` 1/1 |
| MCP Tool Agent run/test | PASS; 실제 stdio server가 `lookup-city`를 발견·호출해 `Seoul / South Korea`, `finds-seoul` 1/1 |
| Evaluation Loop run/test | PASS; `[REVISED]` 뒤 2회차 `[PASS]`, 329 tokens, `improves-until-pass` 1/1 |

## Production Studio Browser E2E

in-app Browser로 `next start` production build를 조작해 실제 DOM과 상태를 확인했다.

- Registry palette 13/13, category/search, typed Agent `toolResults`, generic Component/Edge Inspector 확인
- Save → Validate → Run gating과 invalid YAML 중 마지막 valid Canvas 보존 확인
- Edge condition을 `exists`로 편집·Save·reload한 뒤 `save reload parity` 실행: 4개 node success, 최종 출력 `Echo: Answer this request clearly: save reload parity`
- 같은 저장 `.harnest-browser.yaml`과 입력을 CLI로 실행해 byte-for-byte 같은 최종 출력 확인
- `evaluation-loop`의 `improve` lens에서 5개 inner node success, 모두 `↻2`, 실행 중 5개 scoped Edge pulse, 최종 `[PASS]` 확인
- Loop Tests dock 1 passed / 0 failed, 47-event persisted Trace에 scoped node/Edge와 iteration 1·2 확인
- default-deny module API는 diagnostic/422, 명시적 host capability에서는 Validate/Run/Test/Trace 성공
- keyboard tab/tabpanel linkage, accessible labels/status와 Browser console warning/error 0건 확인

임시 Browser Spec과 실행 Trace는 작업공간에서 제거했다.
