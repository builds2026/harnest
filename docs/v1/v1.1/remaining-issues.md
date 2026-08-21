# Harnest v1.1 남은 문제와 의도적인 제한

최종 감사에서 열린 P0/P1 구현 blocker는 없다. 아래는 이번 버전의 의도적인 범위 제한이다.

## 실행 모델

- 임의 Back Edge와 범용 cyclic scheduler는 지원하지 않는다. DAG 안의 bounded `Loop` + named subgraph가 반복의 유일한 표현이다. arbitrary cycle 자체가 제품 요구가 될 때만 scheduler를 추가한다.
- Provider-native autonomous tool-call은 비활성화했다. Tool은 명시적인 Local/MCP Tool component와 Edge로만 실행된다. 모델 주도 multi-turn tool protocol이 필요할 때 연결된 tool allowlist 안에서 별도 설계한다.
- MCP transport exception은 해당 cached connection을 폐기하고 다음 호출에서 재연결한다. 같은 호출을 몰래 재시도하지 않는다. 부작용 안전성이 명확한 경우에만 explicit retry policy를 확장한다.

## 평가와 검색

- 기본 Evaluator는 결정적인 code grader다. model-as-judge는 provider 비용, calibration과 재현성 정책이 정해질 때 추가한다.
- Directory Context는 최대 크기와 file 수가 제한된 lexical ranking이다. 대규모 corpus가 실제 요구가 될 때 `RuntimeServices.loadContext` 구현으로 vector index를 연결한다.
- 안전한 `matches`는 pattern 256자, 입력 4096자이며 group/lookaround와 복합 quantifier를 거부한다. 더 풍부한 표현이 필요하면 backtracking 없는 regex engine을 도입한다.

## 저장과 운영

- `FileRunStore`와 project Memory는 로컬 project 단위 파일 저장소다. 단일 machine 개발 흐름에는 충분하지만, 다중 process write ordering이나 분산 조회가 필요하면 DB-backed store를 추가한다.
- Trace payload는 개인정보 저장소가 아니다. 선언 secret과 민감 key는 redaction하고 payload를 제한하지만, 사용자는 일반 key 아래의 미선언 개인정보를 입력하지 않아야 한다.
- Studio의 custom catalog는 서버가 module 실행을 명시적으로 허용한 경우에만 확장된다. browser에는 manifest만 전달되며 executor code는 전달하지 않는다.

이 제한들은 `ponytail` 원칙에 따라 현재 요구를 충족하는 가장 작은 안전한 경계로 유지했다.
