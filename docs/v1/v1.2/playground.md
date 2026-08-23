# Harnest Playground

Harnest Playground는 저장된 Harness를 실제 AI 서비스처럼 대화형으로 시험하는 Studio 상단 surface다. Builder와 분리되어 있으며 Playground의 모델 선택, Tool/MCP/Skill 토글, 첨부 파일, 대화는 `harnest.yaml`을 수정하지 않는다. 각 run은 저장 Spec의 `structuredClone()`에 허용된 override만 적용한다.

## 사용 흐름

1. Builder에서 Harness를 저장하고 Setup 오류를 해결한다.
2. 상단 **Harnest Playground**를 연다.
3. 하단에서 이 Harness가 선언한 모델만 선택하고, 연결된 Tool/MCP/Skill만 run 단위로 켜거나 끈다.
4. Code Runner가 선언된 경우 사진·영상·음성·문서·데이터 파일을 첨부하고 이번 run에 전달할 파일만 체크한다.
5. 요청을 보낸다. 중앙 답변 아래 **Execution timeline**에서 공개 가능한 node, context, skill, tool call/approval/result, retry, fallback, evaluation, usage, 오류 event를 확인한다. 모델의 비공개 chain-of-thought를 표시한다고 주장하지 않는다.
6. Code Runner가 `/mnt/output`에 만드는 파일은 우측 **Sandbox**에 실행 중 목록으로 나타나고, 종료 뒤 안전한 inline preview 또는 download가 가능하다.

좌측 History, 우측 Files/Sandbox/Details는 각각 접을 수 있다. 920px 이하에서는 기본으로 모두 접고 한 번에 한 side panel만 연다.

## 파일과 Code Runner 경계

- 첨부 UI는 Harness v0.2에 `builtin.code-runner` Tool이 실제 선언된 경우에만 나타난다. Playground가 지원하지 않는 기능을 임의로 표시하지 않는다.
- upload 한 개는 64 MiB, session 전체는 100 files/256 MiB로 제한한다. 한 run은 최대 32 files를 선택한다. 같은 bytes의 upload는 SHA-256으로 중복 제거한다.
- 파일은 `<project>/.harnest/playground/sessions/<session-id>/`에 저장하며 public API는 실제 host path나 hash를 반환하지 않는다.
- run마다 선택한 regular/non-link file만 별도 staging directory로 복사한다. Container에는 `/mnt/data` read-only bind mount와 `/mnt/output` writable bind mount만 추가한다.
- 기존 container 정책인 network none, read-only root, dropped capabilities, `no-new-privileges`, non-root user, PID/CPU/memory/tmpfs bound를 그대로 사용한다.
- `/mnt/output`은 depth 5, 100 files, file당 64 MiB, session 전체 256 MiB 안에서만 인덱싱한다. symlink, special/empty/oversize file과 한도 밖 output은 노출하거나 보관하지 않는다.
- image/video/audio/PDF/text는 안전한 media element, sandboxed iframe, text Range request로 미리 본다. SVG/HTML을 실행 가능한 preview로 렌더링하지 않으며 response에는 `nosniff`, CSP sandbox, private no-store를 적용한다.

## 대화, 토큰, 비용

- local session은 activity가 있을 때부터 30일 뒤 만료되며 사용자가 즉시 삭제할 수 있다. session은 최대 200 messages, message당 512 KiB로 제한한다.
- Provider로 다시 보내는 대화는 가장 최근 20 messages와 UTF-8 64 KiB로 별도 제한한다. 따라서 대화가 계속 쌓여도 한 request의 history input은 이 ceiling을 넘지 않아 대화 전체를 매번 무제한 재전송하지 않는다.
- 이것은 Harnest의 deterministic context bound이며 Provider-side prompt/context caching과 다르다. Gemini의 implicit caching 또는 다른 Provider의 cache hit 여부·할인은 Provider가 결정한다. 현재 Harnest는 모든 Adapter에 공통인 explicit cache 생성을 성공으로 가장하지 않는다.
- 각 assistant message는 Provider가 보고한 token usage, cost, finish reason과 persisted run id를 저장한다. Provider가 usage를 보고하지 않으면 임의 추정하지 않는다.

## 서비스 적용

`RunSessionContext`와 read-only input/writable output mount 계약은 Core API에 있으므로 Studio 없이도 host가 자체 conversation/file store와 함께 사용할 수 있다. 현재 Web Studio의 `FilePlaygroundStore`, approval broker, loopback HTTP host는 단일 사용자 local reference host다. 원격 multi-tenant 서비스에서는 인증, tenant별 storage namespace/quota, object malware scanning, retention policy, distributed approval coordination을 서비스 경계에서 제공하고 Core runtime에 검증된 session/mount만 전달해야 한다.
