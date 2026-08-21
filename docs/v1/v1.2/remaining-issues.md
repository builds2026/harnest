# v1.2 remaining issues

우선순위는 prompt의 “실제 실행·E2E·보안” 기준이다.

## 완료 주장 전 필요한 항목

1. **OS process isolation** — MCP stdio와 Shell/Code/local command에 Windows Job Object 또는 격리 worker/container를 적용해 process tree kill, CPU·memory·process count·filesystem/network 제한을 제공해야 한다. 현재 timeout/output/cwd 제한만 있다.
2. **Outbound DNS rebinding 방어** — provider/MCP/HTTP hostname allowlist만으로는 부족하다. DNS resolve 결과를 검사하고 private/reserved IP policy를 적용한 뒤 실제 connection IP를 pinning하는 transport/proxy가 필요하다. Studio inbound request의 literal-loopback Host/Origin 검사는 구현됐지만 이 outbound 문제를 해결하지 않는다.
3. **File TOCTOU 방어** — Run Trace append는 fd, link/inode 재검사와 가능한 경우 `O_NOFOLLOW`를 적용했지만, 다른 file store에서 path containment 검사 뒤 실제 I/O 전 symlink/junction이 바뀌는 경쟁을 막으려면 handle-relative open과 no-follow를 제공하는 platform backend가 필요하다.
4. **OAuth full E2E** — 표준 local authorization server로 discovery, browser login/consent, PKCE callback, refresh, insufficient-scope 재동의와 revoke를 하나의 E2E로 검증해야 한다. 현재 callback/token/revoke와 오류 상태 테스트는 분리돼 있다.
5. **외부 provider 검증** — Gemini 3.5 Flash-Lite의 multi-turn Tool loop는 실제 credential로 확인했다. OpenAI, Anthropic, Ollama와 provider별 refresh/error behavior는 남아 있다.
6. **시각 브라우저 E2E 잔여 범위** — first commissioning, Template, inline Connection Wizard, custom Tool/Skill sheet, Save/Validate, 실제 Run/Test/Trace와 Gemini→Web Search call-time approval→최종 응답은 in-app browser에서 통과했다. canvas pointer drag/drop·edge 재배선, compatible picker 선택과 실제 OAuth consent popup 회귀는 아직 필요하다.
7. **Studio↔CLI parity E2E** — CLI도 runtime Tool 등록, exact preapproval와 TTY call-time 승인을 사용하도록 맞췄지만, 같은 persisted Connection/custom Tool/Skill graph를 두 surface에서 실행해 manifest/risk/trace 결과를 비교하는 E2E가 필요하다.

## 기능상 남은 항목

- Provider는 등록 Adapter로 model probe, Web Search Tool Service는 저장 mapping으로 search probe를 실행한다. 일반 HTTP API health/auth probe와 Local Runtime version/command probe는 남아 있다.
- Git/package Skill 입력 UI와 pin validation은 있지만 기본 host에 remote materializer가 없어 실제 내려받기는 fail closed한다.
- Studio/CLI에 Skill script hash를 보여주고 승인하는 `authorizeScript` 흐름이 없다. script resource는 기본 거부된다.
- Skill requirements는 catalog와 runtime에서 분석·fail closed하지만, 누락 Tool·Connection·permission을 한 화면에서 모두 추가하는 일괄 resolver는 없다.
- Template은 graph를 생성하지만 RAG knowledge, Web Search endpoint, MCP Tool 선택과 Provider/Local Runtime Connection commissioning이 필요하다. 외부 resource 없이 즉시 실행되는 것으로 표시하면 안 된다.
- Web Search는 특정 vendor adapter가 아닌 declarative HTTP Tool Service contract이고 공통 response normalization까지 구현됐다. Firecrawl/SearXNG preset의 실제 외부 service E2E와 pagination·scrape 같은 검색 이후 단계는 별도 검증이 필요하다.
- TypeScript Module Tool은 same-process 실행이라 동기 무한 루프/blocking call을 timeout이나 취소로 회수할 수 없다. 격리 worker가 생기기 전에는 trusted module만 허용해야 한다.
- secure credential backend는 Windows DPAPI만 있다. macOS Keychain/Linux Secret Service 지원 전에는 비-Windows Connection credential 사용이 불가능하다.
- CLI의 OAuth browser onboarding 및 Connection CRUD 명령은 없다. 현재 전체 Connection lifecycle UI는 Studio가 담당한다.

## 배포 판단

현재 버전은 local, reviewed, allowlisted 개발 workload에 적합하다. untrusted code 실행, multi-user server, hostile network 또는 compliance가 필요한 배포는 위 process isolation, IP pinning, cross-platform vault와 E2E가 끝날 때까지 지원 범위로 주장하지 않는다.
