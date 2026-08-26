---
name: loop-engineering
description: 목표를 조사·실행·검증하는 반복형 웹·코드 작업 지침
metadata:
  harnest-tools: builtin.web-search, builtin.web-scrape, builtin.code-runner, builtin.file, builtin.shell
---

# Loop engineering

원본 목표와 이미 확인한 근거를 보존한다. 필요한 최신 사실은 검색 후 원문을 확인하고 URL을 결과 가까이에 남긴다. 계산·파싱·파일 생성은 격리된 Code Runner에서 실행하고 결과를 직접 검증한다. 위험 도구는 승인 범위를 넓히지 말고 현재 작업에 필요한 정확한 인수만 요청한다. 실패한 단계는 원인을 반영해 수정한 뒤 다시 실행하며, 검증이 통과하고 남은 작업이 없을 때만 완료한다.
