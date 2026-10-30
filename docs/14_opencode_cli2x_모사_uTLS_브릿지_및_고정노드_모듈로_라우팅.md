---
title: OpenCode CLI 2.x 정품 모사, uTLS BoringSSL 브릿지 및 고정 IP 노드 모듈로 라우팅
created: 2026-10-30
tags: [opencode, utls, boringssl, vercel, deno, northflank, rate-limit, pool]
---

# OpenCode CLI 2.x 정품 모사, uTLS BoringSSL 브릿지 및 고정 IP 노드 모듈로 라우팅

## 1. 개요 및 배경

2026년 10월 말 OpenCode 상위(Upstream) 백엔드가 1.x 레인을 공식 폐기하고 2.x 체계로 전면 전환되면서, 기존 프록시 및 서드파티 클라이언트에 대한 검증 필터(Gatekeeper)가 대폭 강화되었다.
동시에 기존 8790 포트에서 구동되던 genuine OpenCode v2 서버 + 어댑터 구조는 메모리/프로세스 점유가 크고 릴레이 의존성이 높아, 이를 종료하고 경량 프록시(`opencode-proxy`, 8769)와 풀 프록시(`opencode-pool`, 8770) 체계로 단일화할 필요가 있었다.

본 작업에서는 다음 6대 핵심 과제를 구현하고 검증했다:
1. **8790 포트 레거시 서비스 종료 및 Git 코드 아카이브**
2. **OpenCode CLI 2.x 규격 전면 모사 (엔드포인트, 헤더, 프롬프트, 도구 스키마)**
3. **Go 기반 uTLS Bun/BoringSSL 전송 브릿지(`utls_bridge`) 개발 및 통합**
4. **전체 함대(로컬, Deno, Vercel, Northflank) 배포 및 동기화**
5. **OpenCode CLI 무료 모델 전용 엔드포인트(`/opencode/v1/models`) 구축**
6. **429 즉시 반환 최적화 및 고정 IP 노드 1:1 매핑 + 모듈로(N % 3) 라우팅**

---

## 2. 핵심 원인 분석 (Root Cause)

### 2.1 상위 서버의 가짜 429 (Disguised 429) 메커니즘
OpenCode Zen 백엔드는 비정상적인 클라이언트 호출 시 400이나 403 대신 **의도적으로 `429 FreeUsageLimitError ("Free usage limit reached")`를 반환**하여 사용자가 실제 한도 초과인지, 지문 불일치인지 구분하기 어렵게 설계되어 있었다:
- 시스템 프롬프트 부재 또는 `<env>` 블록 내 `Working directory:` 누락 시 ➔ 429 반환
- 공유 프로젝트 ID(`x-opencode-project: 'global'`) 사용 시 ➔ 전 세계 공용 버킷 소진으로 429 반환
- 도구의 `parameters`가 빈 스키마(`{}`)이거나 1.x 구 도구 혼입 시 ➔ 403 또는 429 반환

### 2.2 결정적 장벽: TLS ClientHello 지문 (Bun BoringSSL vs Node OpenSSL)
동일 머신(`oracle2`, 146.56.178.120)에서 동일 시각에 교차 실측한 결과:
- **`afree-proxy` (Go + uTLS BoringSSL)**: **`HTTP 200 OK` (성공)**
- **`Node.js fetch` (OpenSSL)**: **`HTTP 429 FreeUsageLimitError` (실패)**

상위 서버는 HTTP 페이로드가 완벽하더라도 **전송 계층의 TLS Handshake가 Bun(BoringSSL) 지문(JA3 `1523504b...`)이 아니면 즉각 차단**함을 실증했다. 따라서 Node.js 기본 fetch로는 429를 뚫을 수 없으며, 반드시 uTLS 수준의 패킷 형성이 필요했다.

---

## 3. 구현 세부 내역

### 3.1 8790 포트 서비스 종료 및 Git 아카이브
- `/opt/opencode-v2/`의 `oc-adapter.mjs`, `multi-bridge.mjs`, 모니터링 스크립트 및 systemd 유닛 파일을 `legacy/opencode-v2-8790/`로 복사 후 git 커밋(`ca73e5a`).
- `opencode-adapter.service`, `opencode-v2.service`, `opencode-relay-bridge.service` 중지 및 비활성화 완료 (포트 8790, 18790 닫힘 확인).

### 3.2 OpenCode CLI 2.x 규격 모사
- **Upstream URL**: `https://opencode.ai/zen/v1` ➔ `https://opencode.ai/inference/v1`
- **User-Agent**: `opencode/latest/2.2.0/cli`
- **Project ID**: 고정 `'global'` 제거 ➔ 40자리 랜덤 Git SHA 해시 생성 주입 (독립 쿼터 버킷 확보)
- **세션 헤더 동기화**: `x-opencode-session-id`, `x-opencode-session`, `x-session-affinity`, `x-session-id` 4종 헤더를 동일한 세션 ID로 전송하고 레거시 `x-opencode-request` 완전 제거
- **시스템 프롬프트 `<env>`**: `Platform: linux`, `Date: <실시간 UTC>` 포함
- **도구 스키마**: 2.x 필수 도구인 `read`, `shell`의 정품 파라미터 JSON Schema 완비

### 3.3 Go uTLS Bun BoringSSL 브릿지 (`utls_bridge`)
- **경로**: `/root/llm_proxy/opencode_proxy/utls_bridge/`
- `tls_bun.go`: Bun 1.4.3의 BoringSSL ClientHello 스펙 완벽 구현:
  - Curves: `X25519MLKEM768` (0x11ec) 최우선 배치, `X25519`, `CurveP256`, `CurveP384`
  - SignatureAlgorithms: 20종 정품 순서 일치
  - UtlsPaddingExtension 제거
- `main.go`: 로컬 포트(18791)에서 HTTP 요청을 수신하여 `https://opencode.ai:443`으로 uTLS 터널링 후 응답(SSE 스트리밍 포함) 전달
- `server.js` 연동: 기동 시 `utls_bridge` 바이너리를 자동 감지하여 18791 포트에 백그라운드로 띄우고 `UPSTREAM = http://127.0.0.1:18791/inference/v1`로 자동 연결
- `Dockerfile`: Go 1.24 멀티스테이지 빌드로 컨테이너 이미지(Northflank)에도 자동 내장

### 3.4 OpenCode CLI 무료 모델 전용 엔드포인트 (`/opencode/v1/models`)
- 기존에 `/opencode/v1/*`가 `/v1/*`로 포워딩되어 Kilo, Dahl, Blockrun 등이 섞여 나오던 문제를 해결.
- `isOpencodePrefix` 라우팅 분기를 추가하여, `/opencode/v1/models` 요청 시 **타 프로바이더를 일체 배제하고 순수 OpenCode CLI 무료 모델 9종(네이티브 ID + `opencode/` 접두사 총 18개 엔트리)만 반환**하도록 수정.

### 3.5 429 즉시 반환 최적화 (`pool.js`)
- OpenCode 요청에서 상위 429(`FreeUsageLimitError`) 수신 시, 12개 후보 노드를 15초간 헛돌며 순환(failover)하지 않고 **0.38초 만에 즉시 429를 클라이언트로 반환**하도록 최적화. 상위 라우터(OmniRoute, New-API)가 즉시 다음 프로바이더로 전환 가능.

### 3.6 고정 IP 노드 1:1 매핑 및 N%3 모듈로 라우팅 (`pool.js`)
- **OpenCode 모델 한정 라우팅**:
  - `isOpenCodeCliModel(model, url)`을 통해 `opencode/*` 및 Zen 계열 모델만 고정 노드 매핑을 거치도록 격리.
  - **Kilo, Blockrun, Dahl 등 타 프로바이더 모델은 키 번호와 관계없이 전체 44개 노드(Vercel, Deno 등)로 정상 분산(Load Balancing)**됨.
- 고정 IP / 전용 uTLS 노드 목록을 `FIXED_NODES` 배열로 분리:
  ```javascript
  const FIXED_NODES = [
    { node: 1, name: 'oracle1', url: 'http://192.168.200.1:8769', description: 'Oracle Cloud 1 (131.186.17.46)' },
    { node: 2, name: 'oracle2', url: 'http://192.168.200.2:8769', description: 'Oracle Cloud 2 (146.56.178.120)' },
    { node: 3, name: 'northflank', url: 'https://p01--opencode-proxy--vrjr6d2bxlz4.code.run', description: 'Northflank Container (Dedicated Egress)' },
  ];
  ```
- **라우팅 규칙**:
  - `keyNum`: 클라이언트가 전송한 API Key (`Bearer 1`, `node-2`, `3` 등)
  - `targetNodeNum = ((keyNum - 1) % FIXED_NODES.length) + 1`
  - Key 1 ➔ 1번 노드 (oracle1)
  - Key 2 ➔ 2번 노드 (oracle2)
  - Key 3 ➔ 3번 노드 (northflank)
  - Key 4 ➔ 4 % 3 = 1번 노드 (oracle1)
  - Key 5 ➔ 5 % 3 = 2번 노드 (oracle2)
  - Key 6 ➔ 6 % 3 = 3번 노드 (northflank)
- **업스트림 public 호출**: 클라이언트의 키는 업스트림으로 전달하지 않고 `Authorization: Bearer public`으로 변환하여 무료 모드 호출.
- **확장성**: 향후 노드가 추가되면 `FIXED_NODES`에 노드 객체만 추가하면 모듈로 제수가 자동으로 확장됨.

---

## 4. 실측 검증 데이터

### 4.1 고정 노드 Key 1 ~ 6 호출 실측
`http://192.168.200.2:8770/v1/chat/completions` (모델: `opencode/big-pickle`):

| Key | 계산식 | 대상 노드 | 실제 라우팅 결과 | 응답 시간 |
| :---: | :---: | :---: | :---: | :---: |
| `Bearer 1` | 1 | Node 1 (oracle1) | `HTTP/1.1 200 OK` (x-node: 1, x-upstream: oracle1) | 2.5s |
| `Bearer 2` | 2 | Node 2 (oracle2) | `HTTP/1.1 200 OK` (x-node: 2, x-upstream: oracle2) | 0.9s |
| `Bearer 3` | 3 | Node 3 (northflank) | `HTTP/1.1 200 OK` (x-node: 3, x-upstream: northflank) | 1.1s |
| `Bearer 4` | 4%3=1 | Node 1 (oracle1) | `HTTP/1.1 200 OK` (x-node: 1, x-upstream: oracle1) | 2.8s |
| `Bearer 5` | 5%3=2 | Node 2 (oracle2) | `HTTP/1.1 200 OK` (x-node: 2, x-upstream: oracle2) | 1.1s |
| `Bearer 6` | 6%3=3 | Node 3 (northflank) | `HTTP/1.1 200 OK` (x-node: 3, x-upstream: northflank) | 1.2s |

### 4.2 전체 44개 노드 전수 테스트 결과 요약 (엑셀)
- 파일: `/root/llm_proxy/opencode_pool_node_test_results.xlsx`
- **Blockrun** (`north-mini-code`): 43/44개 노드 200 OK (성공률 98%)
- **Kilo** (`kilo-auto/free`): 33/44개 노드 200 OK (성공률 75%)
- **OpenCode** (`big-pickle`): 고정 uTLS 노드(oracle1, oracle2, northflank) 200 OK 정상 동작
