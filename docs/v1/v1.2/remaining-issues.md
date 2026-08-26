# v1.2 remaining verification

구현 항목은 완료됐다. 아래는 이 작업 환경에서 소유하지 않은 credential, 외부 service, OS가 있어야만 닫을 수 있는 검증 범위다. 기능을 성공으로 위장하지 않고 해당 Connection 상태와 Validate 오류로 그대로 드러낸다.

## 외부 통합 검증

- 실제 OpenAI·Anthropic credential과 로컬 Ollama model로 provider-native multi-turn Tool call을 재검증한다.
- 실제 Firecrawl와 self-hosted SearXNG에서 인증·rate limit·pagination·오류 응답을 검증한다. Morit MCP는 실제 Protected Resource Metadata → 별도 SSO metadata → DCR/PKCE authorization redirect까지 검증했지만 사용자 로그인·consent·token refresh/revoke는 계정 세션이 있어야 닫힌다.
- 공개 GitHub/GitLab Skill repository와 실제 npm Skill package로 exact pin download를 검증한다. 현재 자동화는 mock archive/registry로 checksum, traversal, link, size 제한을 검증한다.

## 플랫폼 검증

- Windows에서 DPAPI vault를 검증했다. macOS Keychain과 Linux Secret Service backend는 해당 OS CI에서 동일 lifecycle을 실행해야 한다.
- Docker CLI는 설치돼 있지만 daemon이 실행 중이지 않아 실제 image pull/container E2E를 수행하지 못했다. fake engine integration은 image digest approval, no-network/read-only/cap-drop/non-root/resource arguments, timeout과 process tree cleanup을 검증한다.
- in-app browser로 새 Recipe launchpad, 자동 저장/검증, Service form, Morit MCP OAuth auto-discovery 설정, Harnest Playground 3-pane/toggle/upload/text preview/Code Runner capability gating/mobile layout, A/B Compare, Test/Activity와 기존 Skill/Tool 흐름을 검증했다. 실제 OAuth consent popup 완료와 canvas pointer edge 재배선은 별도 시각 회귀 대상이다.
- Playground의 실제 `/mnt/data` → Code Runner → `/mnt/output` container E2E는 실행 중인 Docker/Podman daemon이 필요하다. 현재 자동화는 selected-file staging, mount argument, artifact/live scan과 경계를 검증하고 실제 daemon 검증을 위 플랫폼 항목과 함께 남긴다.

## 의도한 배포 경계

- Studio host는 literal loopback 단일 사용자 개발 UI다. 원격 multi-user control plane으로 공개하지 않는다. 서비스 제품은 `@harnestai/core` runtime을 자체 인증·tenant isolation 경계 안에 embed한다.
- 검토한 `runtime.modules` adapter/component 확장은 host process 권한을 가진다. 모델이 호출하는 stored TypeScript Tool과 Shell/Code/MCP stdio는 container로 격리되지만, host extension 자체를 untrusted plugin sandbox로 주장하지 않는다.
- 외부 credential/resource가 필요한 Template은 staged commissioning 대상이다. 연결되지 않은 graph는 Validate/Run을 통과하지 않는다.
