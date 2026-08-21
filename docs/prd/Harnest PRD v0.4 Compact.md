# Harnest PRD v0.4 Compact

## 1. 제품 정의

- **제품명:** Harnest
- **형태:** 오픈소스 AI Agent Harness Engineering IDE
- **대상:** AI Agent를 개발·실험·제품에 적용하는 개인 개발자와 팀

> Harnest는 복잡한 AI Agent 하네스를 코드로 직접 엮는 대신, UI에서 구성요소를 끌어다 놓고 연결해 설계·검증·실행하는 오픈소스 Visual Harness Builder다.

**Web Studio가 핵심 제품이며 HarnessSpec, Core, Adapter, CLI는 시각적 설계 결과를 저장·검증·실행하기 위한 기반 계층이다.**

---

## 2. 해결하려는 문제

AI Agent를 제품에 적용하려면 다음 요소를 직접 연결해야 한다.

- Model·Provider
- Prompt
- Context·RAG
- Memory
- Tool·MCP
- Output Schema
- Permission·Approval
- Retry·Fallback·Timeout
- Guardrail
- Test·Evaluator
- Trace·비용·응답 시간

기존 AI 프로젝트는 모델 호출, Prompt, Tool, MCP, 정책과 검증 로직이 여러 코드에 흩어져 구조가 쉽게 복잡해지고 유지보수 부담이 커진다. Harnest는 이를 하나의 시각적 Harness로 설계·관리하게 한다.

---

## 3. 핵심 흐름

```text
Component 선택·Drag & Drop
→ Canvas 연결·설정
→ Validate
→ 저장·실행·평가
→ Trace 확인
→ CLI·SDK·API·MCP에서 재사용
```

Studio 없이도 실행 가능해야 한다.

```bash
harnest validate harnest.yaml
harnest test harnest.yaml
harnest run harnest.yaml
harnest serve harnest.yaml
```

---

## 4. 제품 원칙

- **Visual First:** 사용자는 코드보다 Canvas에서 Harness를 설계한다.
- **Agent 중심:** Workflow가 아니라 Agent Harness가 기본 단위다.
- **선언적 Spec:** 실행 절차보다 구성요소와 정책을 정의한다.
- **그래프 기반:** Components와 Connections로 Harness를 표현한다.
- **테스트 중심:** 단일 실행보다 반복 평가와 비교를 중시한다.
- **Provider 독립:** 특정 모델·MCP·Vector DB에 종속되지 않는다.
- **동일 Runtime:** Studio·CLI·SDK·API가 같은 Core를 사용한다.
- **독립 실행:** 생성된 Harness는 Studio 없이 실행 가능하다.

---

## 5. n8n과의 차이

- **n8n:** 업무와 서비스의 실행 순서를 자동화한다.
- **Harnest:** Agent가 어떤 모델·도구·정책·평가 기준으로 동작할지 설계한다.

```text
Model ──────────┐
Prompt ─────────┤
Context ────────┤
Memory ─────────┼──→ Agent ──→ Output
Tools·MCP ──────┤       │
Permissions ────┤       ├─ Retry·Fallback
Policies ───────┤       └─ Evaluators
Guardrails ─────┘
```

구성 Graph와 실제 실행 Trace는 분리한다.

---

## 6. 시스템 구성

```text
Harnest
├─ HarnessSpec
├─ Validator
├─ Spec Compiler
├─ Harness Core
├─ Model Adapter Registry
├─ Tool·MCP Registry
├─ Context·Memory Registry
├─ Policy Engine
├─ Test Runner
├─ Evaluation Engine
├─ Trace Store
├─ Web Studio
├─ CLI
└─ TypeScript SDK
```

실행 흐름:

```text
Parse → Validate → Compile → Resolve → Execute → Evaluate → Trace
```

---

## 7. HarnessSpec

프로젝트의 단일 구성 파일은 `harnest.yaml`이다.

### 저장 원칙

- Prompt·Schema·Test·Policy는 기본적으로 YAML에 인라인 저장한다.
- PDF·이미지·대용량 문서는 외부 `assets/`에서 참조한다.
- Secret은 환경변수 또는 Secret Store를 사용한다.
- `studio`는 위치·크기 등 UI 정보이며 Core는 무시한다.
- Components와 Connections를 실행 구조의 단일 원본으로 사용한다.

---

## 8. Harness Core

Visual Studio에서 만든 HarnessSpec을 Runtime Plan으로 변환해 실행한다. Core는 핵심 UI를 지원하는 독립 실행 계층이다.

주요 기능:

- YAML·JSON 파싱 및 Schema 검증
- 구성요소와 Port 연결 검사
- Model 호출과 Streaming
- Context 조합 및 Memory 처리
- Tool·MCP 호출
- Output Schema 강제
- Retry·Fallback·Timeout·취소
- Permission·Approval
- Evaluator 실행
- Trace·비용·응답 시간 기록
- 오류 복구와 Secret 마스킹

Adapter와 Tool은 Core에 고정하지 않고 사용자가 필요한 구현을 설치·등록하거나 직접 추가할 수 있게 한다.

---

## 9. 핵심 제품: Visual Harness Studio

사용자가 하네스 구조를 직접 설계·관리하는 Harnest의 중심 인터페이스다.

기본 구조:

```text
Components | Harness Canvas | Inspector
---------------------------------------
Tests | Experiments | Trace | Cost | Logs
```

주요 기능:

- Component Drag & Drop
- Typed Port·Edge 연결
- Node Inspector
- Canvas와 YAML 양방향 동기화
- Import·Export
- Validate·Run·Test
- Test Case 관리
- 실행 상태와 오류 위치 표시
- Trace·비용·응답 시간·성공률 확인
- 모델·Prompt·Tool 구성 비교

---

## 10. Test & Evaluation

```text
설계 → Test 실행 → 평가 → 실패 Trace 분석
→ 설정 변경 → 이전 결과 비교 → 기준 통과 → 배포
```

평가 항목:

- Output Schema 유효성
- 정답·키워드·Citation 포함
- Groundedness
- Tool 호출 성공 및 금지 Tool 감지
- 비용·응답 시간
- 사용자 정의 Assertion

지원 실험:

- Model 비교
- Prompt 버전 비교
- Temperature 비교
- Tool 구성 비교

---

## 11. Validator와 Trace

### Validator

실행 전에 다음을 탐지한다.

- 필수 구성 누락
- 존재하지 않는 Component·Port 참조
- 잘못된 Edge 연결
- 환경변수 누락
- Schema·Evaluator·Test 문법 오류
- Retry·Fallback 순환
- 과도한 Permission
- 승인 없는 위험 Tool
- 지원하지 않는 Adapter

오류에는 코드, Component ID, Spec 위치, 원인과 수정 방법을 포함한다.

### Trace

각 실행은 `runId`를 가지며 다음을 기록한다.

- Harness·Prompt·Model 버전
- Context와 Memory
- Tool·MCP 호출
- 입력·출력
- Token·비용·응답 시간
- Retry·Fallback·Approval
- Evaluator 결과
- 최종 상태

---

## 12. MCP·CLI·SDK

### MCP

- `stdio`
- Streamable HTTP
- Tool 조회·호출
- Timeout·재연결
- Tool별 Agent 권한

완성된 Harness는 MCP Tool로 제공할 수 있다.

```bash
harnest mcp serve harnest.yaml
```

### CLI

```bash
harnest init
harnest validate harnest.yaml
harnest inspect harnest.yaml
harnest run harnest.yaml
harnest test harnest.yaml
harnest serve harnest.yaml
```

### SDK

```typescript
const harness = await Harnest.load("./harnest.yaml");
const result = await harness.invoke({ message: "질문" });
```

---

## 13. 프로젝트와 배포 구조

```text
project/
├─ harnest.yaml
├─ assets/
└─ .env
```

배포 시 하나의 번들로 패키징한다.

```text
support-agent.harnest
├─ harnest.yaml
└─ assets/
```

---

## 14. MVP

### 필수

- Component Palette, Visual Canvas, Typed Connection, Inspector
- Canvas에서 Model·Prompt·Agent·Output을 구성하고 저장·검증·실행하는 전체 흐름
- HarnessSpec v0.1과 단일 `harnest.yaml`
- TypeScript Harness Core, Validator와 Spec Compiler
- Model·Prompt·Context·Agent·Tool·MCP·Output 구성
- 설치·등록 가능한 Adapter Registry·SDK와 예제 Adapter
- MCP `stdio` Client
- Retry·Timeout과 Output Schema 검사
- YAML Import·Export와 CLI
- 실제 Agent 실행
- Test Runner와 기본 Evaluator
- Node 단위 Trace
- 비용·응답 시간 표시
- RAG Agent Template

### 가능하면 포함

- Memory
- Fallback Model
- Permission·Approval
- 비교 실험
- HTTP API
- TypeScript SDK
- Harness MCP Server
- OAuth Provider

### 후순위
- 복잡한 멀티에이전트
- 범용 업무 자동화 Trigger
- 실시간 협업

---

## 15. 대표 데모

1. RAG Agent Template 선택
2. Model·Prompt 설정
3. 문서 Context와 MCP Tool 연결
4. Output Schema와 Evaluator 연결
5. 여러 Test Case 실행
6. 성공률·비용·응답 시간 확인
7. 실패 Trace 분석
8. Prompt 또는 Model 변경
9. 이전 결과와 비교
10. `harnest.yaml` Export
11. CLI에서 동일 Harness 실행

---

## 16. 성공 기준

- 사용자가 Canvas에서 구성요소를 끌어다 놓고 연결해 Harness를 저장·검증·실행할 수 있다.
- Studio와 CLI의 실행 결과가 동일하다.
- 구성 Graph와 실행 Trace가 구분된다.
- 잘못된 연결을 실행 전에 탐지한다.
- 실제 Model과 MCP Tool을 호출한다.
- Output Schema를 강제한다.
- 여러 Test Case를 일괄 실행한다.
- 품질·비용·속도를 비교한다.
- Node별 입력·출력·오류를 확인한다.
- Secret이 Spec과 Trace에 노출되지 않는다.
- 다른 개발자가 저장소를 내려받아 예제를 실행할 수 있다.

---

## 한 줄 소개

> 복잡한 AI Agent 하네스를 UI에서 끌어다 놓고 연결해 설계·실행·관리하는 오픈소스 Visual Harness Builder.