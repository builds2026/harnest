# v1.2 security

## 보안 경계

Harnest는 graph를 신뢰된 실행 코드로 취급하지 않는다. graph에는 Connection ID와 Tool/Skill reference만 저장하고, 실제 credential과 executor는 runtime service가 해석한다. 파일·네트워크·프로세스·module capability는 기본 거부이며 host가 정확한 범위를 허용해야 한다.

## Credential과 OAuth

- Project/user Connection metadata와 secret vault를 분리한다. API와 Studio는 write-only secret 입력 및 존재 여부만 사용한다.
- vault payload는 AES-256-GCM으로 암호화한다. Windows는 data key를 DPAPI `CurrentUser`로 감싸고, macOS는 Keychain, Linux는 Secret Service에 사용자-bound key material을 보관한다.
- credential, OAuth state/token 또는 process approval이 있는 vault entry는 canonical Connection kind/config hash에 묶는다. metadata를 API 밖에서 바꾸어 hash가 달라지면 secret을 사용하거나 갱신하지 않고 Connection 재생성을 요구한다.
- plaintext fallback은 없다. 지원 OS backend를 사용할 수 없으면 credential 기능이 fail closed한다.
- public config의 secret-like key/value, Authorization/Cookie 계열 header, prototype key와 과도한 크기·깊이를 거부한다.
- trace, discovered MCP metadata, Tool 결과와 오류는 해당 Connection의 credential 값을 redaction한 뒤 외부로 보낸다.
- OAuth state는 vault에서 원자적으로 한 번만 소비하고 PKCE verifier, discovery, client information과 token은 issuer/resource 문맥에 묶는다.
- callback은 userinfo·fragment·예약 OAuth query가 없는 literal loopback HTTP URL만 허용한다. 원격 endpoint는 HTTPS만 허용한다.
- OAuth fetch는 redirect를 거부하고 host allowlist, timeout과 응답 크기 제한을 적용한다. revoke 실패 시 credential을 지우지 않고 `revocation_pending`으로 남겨 재시도 가능하게 한다.

## Tool과 Connection

- Agent에는 graph edge로 연결되고 allow/deny policy를 통과한 Tool만 노출한다. provider가 광고되지 않은 이름을 호출하면 실행하지 않는다.
- graph의 risk/schema/source override보다 Registry 또는 persisted manifest를 우선한다. MCP `readOnlyHint`는 risk를 낮추지 않는다.
- Tool JSON Schema는 크기·깊이·node 수를 제한하고 `pattern`과 `patternProperties`의 regex를 작은 동기 실행 안전 subset으로 검사한 뒤에만 Registry에 snapshot한다.
- `read`는 policy 승인, `write`·`external`·`destructive`는 정확한 call id와 인자를 보여준 뒤 1회 승인한다. 승인 대기 중 취소되면 executor를 시작하지 않는다.
- 저장 MCP Tool의 사전 승인 id는 Connection id와 정확한 discovered action을 함께 digest한다. catalog에 저장된 action과 id가 모두 일치해야 하므로 graph action 교체, 다른 Connection 또는 built-in id 충돌로 승인을 재사용할 수 없다.
- HTTP credential은 선택한 HTTP API/Tool Service Connection과 같은 origin에만 주입한다. model-controlled Authorization, Host, Cookie, proxy 및 hop-by-hop header는 거부한다.
- remote HTTP는 HTTPS, local fixture는 `127.0.0.1` 또는 `[::1]` literal loopback만 허용한다. redirect는 따르지 않는다. hostname은 A/AAAA를 해석해 private/reserved/multicast/unspecified 주소를 거부하고, 승인한 IP와 Host/SNI를 실제 connection에 pin한다. IPv4/IPv6 policy와 IPv4-mapped IPv6도 별도로 검사한다.
- 저장 MCP stdio, Shell, Code Runner, Local Command, TypeScript Tool은 Docker/Podman executable과 immutable image identity, command/args/runtime 설정에 묶어 승인한다. 실행은 shell 없이 no-network, read-only root, capability drop, no-new-privileges, non-root user, memory/CPU/PID 제한과 timeout/container tree cleanup을 적용한다. 설정/image/credential이 바뀌면 승인을 무효화한다. 격리되지 않은 raw v1.1 stdio는 실행하지 않는다.
- Raw v1.1 Streamable HTTP는 최대 64개 header의 `env:NAME` 값만 허용하고 routing/proxy/hop-by-hop/content-length header를 거부한다. 응답 stream은 2 MiB, Tool list는 16 page, 연결·목록·호출은 설정 timeout으로 제한한다.
- Stored TypeScript Tool은 explicit module capability 뒤 host에서 esbuild로 bundle만 생성하고 승인된 Node container에서 실행한다. `runtime.modules`로 등록하는 adapter/component host extension은 별도 경계이며 검토한 코드만 허용한다.
- project `.harnest`, Context, Tool/Skill/resource와 Trace는 canonical containment 뒤 열린 handle의 file identity를 I/O 전후 다시 확인하고 traversal·link swap·크기 경쟁을 fail closed한다. 가능한 플랫폼에서는 `O_NOFOLLOW`를 추가 적용한다.
- Shared SSE/NDJSON parser는 기본 total 16 MiB, line 8 MiB, event 8 MiB를 넘으면 stream을 cancel한다. Adapter의 비정상 HTTP body는 64 KiB까지만 읽는다.
- 각 provider 응답은 최대 128개 Tool call과 call당 1 MiB argument만 수용한다. Agent는 수신 중에도 구성된 `maxToolCalls`(기본 32, 최대 128)를 적용하고 Tool input snapshot도 1 MiB로 제한한다.
- Agent는 한 provider turn의 text delta 합계가 8 MiB를 넘으면 실행을 중단한다.

## 배포 번들

- `harnest bundle`은 semantic validation을 통과한 `harnest.yaml`과 project의 `assets/` regular file만 standard ZIP `.harnest`에 저장한다.
- `.env`, Connection metadata/vault, OAuth token, Trace, Memory, `.harnest/` local state는 탐색하거나 포함하지 않는다.
- asset link·junction·special file을 거부하고 1,000 files/64 MiB로 제한하며 deterministic path/order/time을 사용한다. 기존 artifact는 덮어쓰지 않는다.

## Studio HTTP 경계

- Next proxy는 page, asset, API를 포함한 모든 Studio request의 raw `Host`가 URL과 일치하는 literal `127.0.0.1` 또는 `[::1]`인지 검사하며, 다른 Host는 `403`으로 거부한다.
- Mutation API는 추가로 같은 scheme·host·port의 literal-loopback `Origin`을 요구한다. Origin 없는 요청과 cross-origin 요청은 거부한다.
- inbound Host/Origin과 outbound DNS/IP pinning은 서로 다른 경계로 각각 적용한다.

## Trace 저장소

- append는 file descriptor를 열어 regular file, symlink 여부, link count와 inode를 다시 확인하고, 지원되는 플랫폼에서는 `O_NOFOLLOW`를 사용한다. 열린 파일이 검사 뒤 바뀌거나 불완전하면 append하지 않는다.
- trace file은 8 MiB, 각 NDJSON event는 64 KiB, 한 trace는 10,000 event로 제한하며 read와 append 양쪽에서 검사한다.

## Skill trust

- catalog는 `SKILL.md` frontmatter와 provenance metadata만 읽고 본문은 활성화 시, resource는 요청 시 읽는다.
- install은 bounded regular-file tree만 원자적으로 복사하고 content hash와 provenance를 기록한다. 전체 tree hash 검증은 `activate()`와 `loadResource()` 시점에 지연 수행하며, 설치 뒤 내용이 바뀌어 hash가 맞지 않으면 본문이나 resource를 반환하지 않는다.
- GitHub/GitLab repository는 HEAD를 exact commit으로 해석하고 그 archive만 받는다. npm은 exact version과 registry sha512를 확인한다. archive는 traversal, absolute/backslash/colon path, link/device, duplicate provenance, file/byte/decompression 한도를 검사한다.
- `scripts/` resource는 Studio/CLI가 code, bytes, SHA-256을 표시하고 사용자가 승인한 exact hash만 읽는다. 설치 뒤 한 byte라도 바뀌면 provenance와 script 승인이 모두 무효화된다.

## 보장하지 않는 것

다음은 현재 구현의 보안 보장이 아니다.

- **Container daemon 자체의 격리:** Harnest는 승인된 Docker/Podman daemon을 신뢰 경계로 사용하며 daemon 취약점이나 관리자 설정을 대신 방어하지 않는다.
- **Host runtime extension sandbox:** 검토 후 로드한 `runtime.modules` adapter/component는 Harnest process 권한을 가진다. 모델 호출용 stored TypeScript Tool의 container 경계와 혼동하면 안 된다.
- **임의 proxy/transport:** 제공 Adapter와 Connection은 pinned fetch를 사용한다. 제3자 host extension이 context transport를 무시하고 직접 socket/global fetch를 열면 그 extension의 권한이다.
- **원격 multi-user Studio:** Studio HTTP host는 literal loopback 단일 사용자 운영만 지원한다. multi-tenant service는 Core를 별도 인증·tenant isolation·secret service 안에 embed해야 한다.
- **외부 IdP/provider 검증:** 실제 vendor consent 정책, rate limit, provider-native 오류 behavior는 해당 external E2E가 필요하다.
