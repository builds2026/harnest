# v1.2 security

## 보안 경계

Harnest는 graph를 신뢰된 실행 코드로 취급하지 않는다. graph에는 Connection ID와 Tool/Skill reference만 저장하고, 실제 credential과 executor는 runtime service가 해석한다. 파일·네트워크·프로세스·module capability는 기본 거부이며 host가 정확한 범위를 허용해야 한다.

## Credential과 OAuth

- Project/user Connection metadata와 secret vault를 분리한다. API와 Studio는 write-only secret 입력 및 존재 여부만 사용한다.
- Windows vault는 임의 256-bit data key로 AES-256-GCM 암호화하고 key를 DPAPI `CurrentUser`로 감싼다. vault와 key 파일은 함께 있어도 다른 Windows 사용자 문맥에서는 열 수 없다.
- credential, OAuth state/token 또는 process approval이 있는 vault entry는 canonical Connection kind/config hash에 묶는다. metadata를 API 밖에서 바꾸어 hash가 달라지면 secret을 사용하거나 갱신하지 않고 Connection 재생성을 요구한다.
- plaintext fallback은 없다. 따라서 현재 비-Windows 환경에서는 secure credential 기능이 fail closed한다.
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
- 저장 MCP Tool의 사전 승인 id는 Connection id와 정확한 discovered action을 함께 digest한다. catalog에 저장된 action과 id가 모두 일치해야 하므로 graph action 교체, 다른 Connection 또는 built-in id 충돌로 승인을 재사용할 수 없다. 기존 raw `mcp-tool`은 설정된 action id의 explicit approval을 사용한다.
- HTTP credential은 선택한 HTTP API/Tool Service Connection과 같은 origin에만 주입한다. model-controlled Authorization, Host, Cookie, proxy 및 hop-by-hop header는 거부한다.
- remote HTTP는 HTTPS, local fixture는 `127.0.0.1` 또는 `[::1]` literal loopback만 허용한다. redirect는 따르지 않는다.
- stdio/local command는 exact command allowlist, project-contained cwd, shell 비사용, timeout 및 output 제한을 적용한다. 저장 MCP stdio executable은 absolute canonical non-link regular file이어야 하며 fingerprint는 canonical path, file identity(size/mtime/dev/ino), exact args, cwd와 environment credential mapping을 포함한다. Local Command의 기본 환경은 비어 있고 MCP stdio는 SDK의 제한된 기본 환경에 명시적 credential mapping만 더한다. stdio 설정 또는 credential이 바뀌면 승인을 무효화한다. Raw v1.1 stdio도 `node` alias를 현재 canonical runtime으로 고정하고, 그 외 command는 absolute canonical non-link regular file만 허용하며 args는 128개·각 8,192자로 제한한다.
- Raw v1.1 Streamable HTTP는 최대 64개 header의 `env:NAME` 값만 허용하고 routing/proxy/hop-by-hop/content-length header를 거부한다. 응답 stream은 2 MiB, Tool list는 16 page, 연결·목록·호출은 설정 timeout으로 제한한다.
- TypeScript Module은 explicit module capability가 없으면 import하지 않는다. 승인하면 같은 Node.js process 권한으로 실행되므로 신뢰된 코드에만 사용한다.
- project `.harnest`, Tool/Skill 파일과 resource는 realpath/regular-file 검사와 traversal·symlink 방지, 크기 제한을 거친다.
- Shared SSE/NDJSON parser는 기본 total 16 MiB, line 8 MiB, event 8 MiB를 넘으면 stream을 cancel한다. Adapter의 비정상 HTTP body는 64 KiB까지만 읽는다.
- 각 provider 응답은 최대 128개 Tool call과 call당 1 MiB argument만 수용한다. Agent는 수신 중에도 구성된 `maxToolCalls`(기본 32, 최대 128)를 적용하고 Tool input snapshot도 1 MiB로 제한한다.
- Agent는 한 provider turn의 text delta 합계가 8 MiB를 넘으면 실행을 중단한다.

## Studio HTTP 경계

- Next proxy는 page, asset, API를 포함한 모든 Studio request의 raw `Host`가 URL과 일치하는 literal `127.0.0.1` 또는 `[::1]`인지 검사하며, 다른 Host는 `403`으로 거부한다.
- Mutation API는 추가로 같은 scheme·host·port의 literal-loopback `Origin`을 요구한다. Origin 없는 요청과 cross-origin 요청은 거부한다.
- 이 inbound Host/Origin 경계는 아래 outbound provider/MCP DNS rebinding 제한을 대신하지 않는다.

## Trace 저장소

- append는 file descriptor를 열어 regular file, symlink 여부, link count와 inode를 다시 확인하고, 지원되는 플랫폼에서는 `O_NOFOLLOW`를 사용한다. 열린 파일이 검사 뒤 바뀌거나 불완전하면 append하지 않는다.
- trace file은 8 MiB, 각 NDJSON event는 64 KiB, 한 trace는 10,000 event로 제한하며 read와 append 양쪽에서 검사한다.

## Skill trust

- catalog는 `SKILL.md` frontmatter와 provenance metadata만 읽고 본문은 활성화 시, resource는 요청 시 읽는다.
- install은 bounded regular-file tree만 원자적으로 복사하고 content hash와 provenance를 기록한다. 전체 tree hash 검증은 `activate()`와 `loadResource()` 시점에 지연 수행하며, 설치 뒤 내용이 바뀌어 hash가 맞지 않으면 본문이나 resource를 반환하지 않는다.
- Git은 exact commit, package는 exact version+integrity와 exact-source 승인을 요구한다. core는 네트워크 materialization을 하지 않으며 host callback이 없으면 설치를 거부한다.
- `scripts/` resource는 현재 content hash에 대한 별도 `authorizeScript` callback 없이는 읽을 수 없다. Studio는 아직 이 callback을 제공하지 않아 script 실행/읽기가 기본 거부된다.

## 보장하지 않는 것

다음은 현재 구현의 보안 보장이 아니다.

- **OS sandbox 없음:** child process에 OS-level CPU/memory/file/network 격리, job object/cgroup/container가 없다.
- **프로세스 트리 종료 없음:** timeout은 직접 child에 `kill()`을 보내지만 그 child가 만든 후손 전체의 종료를 보장하지 않는다.
- **자원 cap 없음:** timeout과 I/O byte limit 외에 CPU, RSS, descriptor, process count 제한이 없다.
- **Outbound DNS rebinding/IP pinning 없음:** provider/MCP/HTTP URL hostname과 exact `host[:port]`를 확인하지만 DNS 해석 결과를 고정하거나 private/reserved IP로의 변경을 재검증하지 않는다.
- **승인된 module은 격리되지 않음:** 승인 후에는 Harnest process 권한을 가진다.
- **동기 module 중단 보장 없음:** same-process TypeScript Tool이 동기 무한 루프나 blocking native call에 들어가면 `AbortSignal`과 timeout이 event loop를 되찾지 못해 취소할 수 없다.
- **일반 파일의 same-user TOCTOU 완화 미완성:** Trace append는 fd, link/inode 재검사와 가능한 경우 `O_NOFOLLOW`를 사용하지만, 다른 contained file store는 검사와 실제 I/O 사이에 같은 OS 사용자가 symlink/junction을 바꾸는 경쟁을 handle-relative no-follow 방식으로 모두 막지는 못한다.
- **외부 IdP/provider 보장 없음:** 실제 vendor OAuth 정책, token refresh, consent UX와 provider-native Tool call은 로컬 자동화만으로 완전히 검증되지 않았다.

이 항목이 필요한 배포에서는 process worker를 OS sandbox backend로 분리하고, DNS resolve→IP policy→connection pinning을 적용한 네트워크 proxy를 앞에 두기 전까지 untrusted workload를 실행하면 안 된다.
