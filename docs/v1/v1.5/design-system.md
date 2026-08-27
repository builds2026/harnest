# Harnest Product UI 규칙

Harnest Studio와 `nextjs_ai`는 같은 실행 모델을 서로 다른 사용 맥락에서 보여준다. 두 앱은 Toss의 명확한 정보 계층, 충분한 여백, 짧은 문구, 한 맥락의 한 주요 행동을 참고하되 Harnest의 Agent Harness IDE 정체성과 인디고 색상을 유지한다. Toss Design System의 코드나 자산을 복제하지 않는다.

## 제품 원칙

1. 현재 위치, 선택한 Harness·Run·Component, 다음 행동을 첫 화면에서 알 수 있어야 한다.
2. 사용자가 얻는 결과를 먼저 설명하고 설정 비용은 필요한 순간에 단계적으로 공개한다.
3. 한 맥락에는 하나의 가장 강한 행동만 둔다. 저장, 실행, 검증, 연결 중 현재 단계의 행동만 primary로 표시한다.
4. 기술 용어는 숨기지 않는다. 쉬운 이름을 먼저 쓰고 `HarnessSpec`, MCP, PKM 같은 정확한 용어와 짧은 설명을 함께 제공한다.
5. 비동기 작업은 `진행 중 → 성공/입력 대기/실패`를 명시하고 실패에는 재시도나 복구 행동을 제공한다.
6. 삭제, 영구 권한, 버전 복원, Harness 교체처럼 되돌리기 어려운 작업은 Base UI AlertDialog로 범위와 결과를 확인한다.
7. 라이트·다크 모드는 동일한 semantic token과 정보 계층을 사용한다. 색상만으로 상태를 전달하지 않는다.

## 시각 토큰

- Font: 본문은 Inter/Pretendard 계열 variable sans와 시스템 fallback, 코드·ID·Trace는 mono.
- Type: 10px metadata, 11px label, 12px compact UI, 13px control, 14px body, 16px section title를 기본 축으로 사용한다. 9px 이하는 사용하지 않는다.
- Space: 4, 8, 12, 16, 24, 32px 축을 사용한다.
- Control: compact 32px, default 36px, prominent 40px. 모바일 포인터 대상만 44px 이상으로 확장한다.
- Radius: control 8–10px, card 12–14px, overlay 16–20px, 상태 pill은 999px.
- Surface: `bg-app`, `surface-raised`, `surface-muted`, `surface-hover`, `surface-active`만 사용한다.
- Text: `text-primary`, `text-secondary`, `text-tertiary`로 계층을 제한한다.
- State: `accent`, `success`, `warning`, `danger`, `info`와 각 `*-soft` 배경을 짝으로 사용한다.
- Elevation: pane 경계는 border, 떠 있는 card는 subtle shadow, Dialog/Menu만 overlay shadow를 사용한다.
- Motion: interaction 120–140ms, overlay 180–220ms. 위치와 opacity만 움직이며 `prefers-reduced-motion`에서 제거한다.
- Focus: 모든 키보드 대상은 semantic accent focus ring을 유지한다.

## Base UI 사용 경계

- Dialog/AlertDialog: 설정, 서비스, Tool, Skill, Version, 위험 확인.
- Menu/Popover/Tooltip: 짧은 보조 행동과 설명. 핵심 행동이나 오류 복구를 Tooltip에만 두지 않는다.
- Select/Tabs: 키보드 이동, 선택 상태, popup focus를 Base UI가 관리한다.
- Form/Field: label, description, error를 입력과 연결한다. 일반 입력은 native input/textarea를 유지한다.
- Toast: 완료 사실을 알리는 보조 피드백으로만 사용한다. 실패 원인과 재시도는 해당 화면에도 남긴다.

Base UI는 동작과 접근성 계층이며 시각 스타일은 로컬 semantic token으로 통일한다. 화면마다 Dialog, Select, Button을 다시 구현하지 않는다.

## 화면 패턴

### Studio Shell

- Sidebar는 제품·프로젝트·주요 surface와 Settings만 담당한다.
- Top rail은 현재 surface 설명, readiness trail, 현재 단계의 primary action을 보여준다.
- Builder는 Palette–Canvas–Inspector의 선택 관계를 유지하고 선택 대상이 바뀌면 Inspector 제목과 URL이 즉시 따라간다.
- Canvas toolbar에는 편집 모드, graph 선택, undo/redo, fit, arrange, history만 둔다. 긴 설명은 Tooltip을 사용한다.

### Run과 Interaction

- Run은 queued/running/paused/resuming/succeeded/failed/cancelled를 서로 다른 문구와 상태 표시로 구분한다.
- 권한 요청은 requester, tool/action, capability, connection, resource, redacted preview, risk, 적용 범위를 먼저 보여준 뒤 결정 버튼을 제공한다.
- `allow_once`, `allow_for_run`, `allow_always`, `deny`는 효과가 다른 네 행동으로 설명하고 영구 권한은 정확한 resource가 확인될 때만 허용한다.
- Trace는 최종 답변을 먼저 보여주고 시간순 event, raw JSON, artifact를 점진적으로 공개한다.

### Empty, Loading, Error

- Empty: 무엇이 없는지, 왜 필요한지, 시작 행동 하나를 제공한다.
- Loading: skeleton은 실제 레이아웃과 같은 구조로 표시하고 입력이 막힌 이유를 status로 알린다.
- Error: 사용자 언어로 원인 범주를 설명하고 retry, 설정 열기, Builder로 이동 같은 구체 행동을 둔다.
- 배경에서 취소된 Strict Mode/HMR 요청은 사용자 오류로 표시하지 않지만 실제 4xx/5xx와 page error는 테스트 실패로 취급한다.

## 검증 기준

- 1440×900 데스크톱에서 핵심 surface와 overlay를 라이트·다크로 확인한다.
- 1024px에서 수평 잘림이 없어야 하며 off-canvas pane은 닫힌 동안 focus 대상이 아니어야 한다.
- Dialog는 열릴 때 내부로 focus가 이동하고 Escape/Close 후 시작점으로 돌아간다.
- 모든 icon button은 접근 가능한 이름을 갖고 모든 입력은 label 또는 `aria-label`을 갖는다.
- streaming, interaction pause/resume, autosave, validation, test, run delete/export를 실제 Chromium으로 검증한다.
- 최종 gate는 lint, typecheck, unit, Playwright E2E, production build다.

참고: [Toss Consumer UX Guide](https://developers-apps-in-toss.toss.im/design/consumer-ux-guide.html), [Toss Design System](https://toss.tech/article/44097), [Base UI Accessibility](https://base-ui.com/react/overview/accessibility), [Base UI Dialog](https://base-ui.com/react/components/dialog).
