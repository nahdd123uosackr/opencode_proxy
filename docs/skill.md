---
title: OPENCODE_PROXY 마스터 가이드 (skill)
created: 2026-09-11
tags: [opencode-proxy, opencode-pool, omniroute, bifrost, kilo, muse-spark, skill]
source: 2026-08-21~2026-09-12(P20-P23 포함) 누적 구축/장애대응 실기록 종합 — 정본: /alist/s3/obsidian/03 - 프로젝트/IT/llm_proxy/OPENCODE_PROXY (/root/opencode_proxy 는 심링크)
---

# OPENCODE_PROXY 마스터 가이드

> 이 폴더(OPENCODE_PROXY)의 모든 문서를 읽지 않고도, 이 파일 하나만 읽으면 시스템 전체
> 구조·운영법·트러블슈팅 이력을 파악하고 바로 작업할 수 있게 만든 진입점 문서다.
> 더 깊은 배경/이력이 필요하면 각 절 끝의 "관련 문서"로 이동할 것.

## 0. 한 문단 요약

**OmniRoute**(오라클1 k3s의 Next.js LLM 게이트웨이)가 muse-spark(무료 reasoning 모델)와
Kilo Gateway 모델을 쓸 때, 내장 **bifrost**(임베디드 `@maximhq/bifrost` 바이너리, 소스 접근
불가)를 거쳐 **opencode-pool**(`:8770`, 오라클2)이라는 자체 제작 failover 프록시를 호출하고,
pool이 다시 **opencode-proxy**라는 동일 코드가 배포된 **~50개의 서로 다른 서버리스/컨테이너
인스턴스**(Vercel 38 + Deno 4 + 로컬 2 + Netlify 3 + 컨테이너 3)에 요청을 분산시켜, 실제
`opencode.ai/zen`과 `api.kilo.ai`의 무료 티어를 IP 분산으로 안정적으로 소진한다.

## 1. 전체 아키텍처 (상→하)

```
Codex/Claude Code/Hermes 등 클라이언트
   │  (OpenAI-Chat / OpenAI-Responses 프로토콜, 콤보를 통해)
   ▼
OmniRoute (오라클1, k3s, 네임스페이스 omniroute, 파드 omniroute-scsi-*)
   │  콤보 멤버가 "bifrost/..."인 경우 bifrost로 위임
   ▼
bifrost (omniroute 파드에 임베디드, 포트 8080, config.db에 provider 설정)
   │  virtual provider: opencode-proxy / opencode-zen1 / kilo-gateway
   │  (2026-09-11부터 셋 다 base_url이 동일하게 오라클2:8770 = pool)
   ▼
opencode-pool  (:8770, 오라클2, /opt/opencode-pool/pool.js, systemd opencode-pool.service)
   │  자체 failover/동티어대체/블랙리스트/헬스체크 — 아래 §3
   ▼
opencode-proxy  (동일 api/index.js 코드가 ~50곳에 배포됨 — 아래 §4)
   │  museToInput/Kilo 브릿지/키 타입 판별
   ▼
실제 업스트림: https://opencode.ai/zen/v1 (muse-spark 등 free 모델)
             https://api.kilo.ai/api/gateway (Kilo 모델)
```

- **오라클1**(`instance1`, wg0 사설IP `192.168.200.1`): OmniRoute k3s 클러스터 + bifrost + **오라클1 자체의 별도 opencode-proxy 인스턴스**(`192.168.200.1:8769`, `/opt/opencode-proxy`). 오라클2와 **완전히 다른 서버**이며 며칠씩 방치되면 구버전으로 드리프트되기 쉽다(P17에서 517줄짜리 P9~P17 전부 누락 사본으로 발견됨).
- **오라클2**(`instance2`, wg0 사설IP `192.168.200.2`, 공인IP `146.56.178.120`): opencode-pool(:8770) + 오라클2 자체 opencode-proxy(:8769, `/opt/opencode-proxy`) + 배포용 git 저장소(`/root/opencode_proxy`) + Vercel/Deno CLI + 모든 계정 토큰.

## 2. bifrost가 보는 3개 provider — 지금은 전부 같은 곳

`config.db`(`config_providers` 테이블)에 `kilo-gateway`/`opencode-zen1`/`opencode-proxy` 3개
provider가 있고, 2026-09-11부로 **셋 다 base_url이 `http://146.56.178.120:8770`(오라클2의 pool)**
로 통일됐다. 키 풀은 provider별로 분리돼 있어 provider 선택은 유지된다:
- `kilo-gateway`: JWT형(`eyJ...`) 키 14개
- `opencode-zen1`: `sk-`형 키 15개
- `opencode-proxy`: 더미 키(`1`) 1개 — 모델 prefix(`opencode/`)로만 라우팅

pool.js는 클라이언트 헤더(Authorization 등)를 **호스트/커넥션류만 빼고 그대로** 업스트림에
전달하므로(`attempt()` 참고), 각 opencode-proxy 인스턴스의 `isKiloKey`/`isOpenCodeZenKey`
판별과 "키 타입-모델 불일치 차단 가드"(`Kilo API key can only be used with kilo models` 등)가
pool을 거쳐도 그대로 살아있다 — 이건 직접 라이브 테스트로 검증됨(P17 관련 작업 중).

## 3. opencode-pool (`:8770`, `/opt/opencode-pool/pool.js`)

풀 자체의 핵심 로직 — 자세한 건 `10_opencode_pool_아키텍처_및_dispatcher_버그.md (→ 이후 ../../OPENCODE_POOL/docs/00_아키텍처_및_dispatcher_버그.md 로 분리됨)` 참고
(단, 그 문서는 15업스트림 시절 기록이라 **숫자가 지금은 50개로 바뀜**, 최신 상태는 이 절과
`배포.md`를 신뢰할 것).

- ~~"API 키 감지 시 instance2 직통" 우회~~ — **2026-09-11 P19에서 제거됨.** 예전엔 더미 키가 아닌 실키(Kilo JWT, zen `sk-`)가 오면 `buildAttemptPlan`을 아예 안 타고 오라클2 로컬 인스턴스 하나로만(대체 후보 없이) 보냈다 — bifrost의 `kilo-gateway`/`opencode-zen1` 트래픽 전체가 그 노드 하나에 대한 단일 장애점이었다(P18, 코덱스 반복 실패의 실질 원인). 지금은 **키가 있든 없든 전부 `buildAttemptPlan`으로 정상 페일오버**하고, `attempt()`가 이미 헤더(Authorization 포함)를 그대로 전달하므로 실키도 그대로 업스트림에 도달한다 — 익명 사용량과 키 사용량을 분리해 총 가용량을 늘리려는 목적(키 요청이 익명 quota만 쓰고 끝나면 안 됨)이므로 키 전달 자체는 유지.
- **시도 계획**(`buildAttemptPlan`, 위 우회에 안 걸리는 더미 키/무키 요청만 해당): 원모델로 **다른 서버 최대 5회**(`SAME_MODEL_RETRY_LIMIT`) 우선 시도 → 그래도 실패하면 동티어 대체 모델(`alternateModel`)로 전환, 최대 `MAX_ATTEMPTS=12`.
- **동적 티어**: `models.dev/api.json`을 10분마다 수집해 zen 모델은 XL/L/M/S로 자동 분류. **Kilo 모델은 완전히 분리된 별도 티어 테이블**(`DYN.kiloByModel` 등)을 쓴다 — 예전엔 zen 정규식과 우연히 겹쳐 오매칭되던 버그가 있었음(고침).
- **모델 블랙리스트**(`BAD_MODELS`): "이 모델 자체가 죽었다"(`ModelError` 등) 판단 시 그 모델을 제외. **10분 TTL 있음**(2026-09-11 이전엔 무기한 Set이라 오탐 한 번이면 재시작 전까지 영구 장애였음 — P13). `response_format`/`json_schema`/`"param"` 필드가 있는 오류는 "이 요청 하나의 문제"로 보고 블랙리스트 제외.
- **타임아웃**: `UPSTREAM_TIMEOUT_MS=8000`(개별 시도, 응답 헤더까지만 잼 — 스트리밍 본문은 안 잼), `REQUEST_DEADLINE_MS=27000`(전체 요청). 08-26 한때 둘 다 35000이라 데드라인 체크가 무력화됐던 사고가 있었음(P11).
- **hold-back**: 빈 스트림 오판 방지용 버퍼링. `HOLDBACK_TIMEOUT_MS`가 "전체 요청 시작 시점" 기준 남은 예산(`CLIENT_PATIENCE_MS=26000`)에 맞춰 동적으로 줄어듦 — 안 그러면 여러 번 재시도한 뒤의 hold-back이 bifrost의 ~30초 dead-air 한도를 넘겨버림(P10).
- **4xx 처리**: 기본은 "재시도해도 소용없다"고 보고 즉시 클라이언트에 반환하지만, **노드 자신의 문제**(플랫폼 라우팅 404 `"Route ... not found"` 등)는 예외로 다음 노드로 넘어간다(P15) — "요청 스코프 문제"와 "노드 스코프 문제"를 구분하는 게 이 시스템 전체를 관통하는 핵심 원칙.
- **관리**: `/etc/systemd/system/opencode-pool.service.d/upstreams.conf`(`POOL_UPSTREAMS`), `timeouts.conf`. 반영은 `systemctl daemon-reload && systemctl restart opencode-pool`. 상태는 `curl localhost:8770/health`.

## 4. opencode-proxy (`api/index.js`) — 정본 코드가 사는 곳과 배포되는 곳

- **정본(canonical) 소스**: `/alist/s3/obsidian/03 - 프로젝트/IT/llm_proxy/OPENCODE_PROXY` (git: `nahdd123uosackr/opencode_proxy`, `main` 브랜치, `138fd40` 현재). `/root/opencode_proxy`는 이 경로로의 **심링크**(공백·한글 경로를 피하고 기존 `REPO=/root/opencode_proxy` 스크립트 호환 유지). `api/index.js`가 정본이고, `vercel/api/index.js`는 항상 이것과 동일하게 동기화해야 함. `deno/main.ts`는 별도 유지(문법이 조금 다름, TS/Deno).
- **핵심 함수**:
  - `museToInput(messages)` + `normalizeMuseContentPart(x,role)` + `sanitizeResponsesInput(input)`: OpenAI Chat Completions 메시지를 muse-spark가 쓰는 Responses API `input[]` 배열로 변환. **여기서 나온 버그가 가장 많았다** — assistant `function_call`이 top-level이 아니라 content 안에 중첩(P9), user 배열 콘텐츠의 `type:"text"`가 `input_text`로 변환 안 됨(P14, 코덱스 CLI의 AGENTS.md 주입), **네이티브 `POST /v1/responses` passthrough가 정규화 없이 `type:text`를 그대로 보내 400(P20)**, system/developer 배열 `String()` 오염·assistant 배열 오염도 P20에서 함께 수정.
  - `anthropicMessagesToOpenAI` / `anthropicContentToOpenAIBlocks` / `anthropicToolsToOpenAI` / `anthropicToolChoiceToOpenAI`: Anthropic `/v1/messages` 호환 레이어. `system` top-level, `content` 내 `tool_use`→`tool_calls`/`tool_result`→별도 `tool` 메시지/`image`→`image_url`, `tools` `input_schema→parameters`, `tool_choice` `auto/any/tool→required/function` 변환. P21 이전엔 `body.messages`만 그대로 전달해 tool/image/system이 침묵 실패.
  - `effortFromClientBody(body)` / `effortFromThinking(thinking)`: P23 — `model:high` 콜론 접미사 외에 클라이언트가 직접 보낸 `reasoning_effort`/`reasoningEffort`/`reasoning.effort`(Codex) 및 Claude `thinking.budget_tokens`(4000→low/12000→medium/그 외 high)도 `effectiveVariant`로 읽도록 fallback. 우선순위 콜론 > thinking > flat reasoning. `responses` muse 분기는 flat과 nested 중복 시 flat을 `delete`해 400 방지(P23 bugfix 138fd40).
  - Kilo Gateway 포워딩(`routeToKilo` 분기): `KILO_BASE + '/chat/completions'`로 클라이언트 요청을 거의 그대로 전달. bifrost가 가끔 `reasoning_effort`와 `reasoning.effort`를 동시에 보내는데 Kilo가 이걸 거부해서(P17), 여기서 방어적으로 구식 필드를 제거함. P23 이후 `responses` muse 분기도 flat 중복 제거로 동일 처리.
  - `isKiloKey`/`isOpenCodeZenKey`/`extractClientKey`: 키 모양(JWT vs `sk-`)으로 provider 식별, 모델 prefix와 불일치하면 400.
  - Circuit breaker(`markKeyFailure`/`isKeyCooling`): 429/402/401 등에 따라 키별로 다른 쿨다운(1분~1시간).
- **배포되는 곳 (총 50개, 자세한 계정/토큰은 `배포.md` 3절)**:
  - Vercel 38 = **V1 9개**(alias: jet/alpha/seven/rho/six/black/three/theta/two, 실제 프로젝트명은 `vercel-opencode-proxy`) + **V2 9개**(alias: v2/v2-blush/chi/xi/one/omega/snowy/murex/rho, 프로젝트명 `vercel-opencode-proxy-v2`) + **v3 10개** + **v4 10개**(`vercel-opencode-proxy-v3`/`-v4`, CLI 업로드 전용).
    - **중요 발견(2026-09-11)**: V1/V2 18개는 별도 계정이 아니라, v3/v4에 이미 쓰는 **10개 계정이 각자 V1/V2 프로젝트도 이미 갖고 있는 것**이었다. `vercel project ls --token=<토큰>` (⚠️ `--yes` 옵션 없음, 붙이면 즉시 에러)으로 확인 가능. 매핑표는 `배포.md` 3.1.1.
    - git 연결이 되어 있을 거라 가정하면 안 된다 — `vercel-opencode-proxy`(jet)는 `link: null`이라 git push가 전혀 안 먹혔다.
  - Deno Deploy 4개 (org: nahdd1234/1235/1236/nahdd123uosackr)
  - 로컬 2개 (오라클1 `192.168.200.1:8769`, 오라클2 `192.168.200.2:8769` — **서로 다른 머신**)
  - Netlify 3개, Northflank/Orkestr/SnapDeploy 각 1개 (git 자동배포 또는 토큰 없음)
  - EdgeOne은 풀에서 **제외**(muse-spark가 중국 리전 차단)

## 5. 배포 — `redeploy.sh`

코드 수정 후 "고쳤다"고 확신하려면 **반드시 실제 50개 주소 전부를 라이브 테스트**해야 한다
(문서상 숫자나 "git push했으니 됐겠지"는 믿지 말 것 — P14/P17에서 여러 번 배신당함).

```bash
# 오라클2에 올려서 실행 (/root/opencode_proxy/redeploy.sh)
./redeploy.sh                  # 전체 44개(Vercel 38 + Deno 4 + 로컬 2) 병렬 배포+검증
./redeploy.sh v1 v2            # V1/V2 그룹만
./redeploy.sh v3 v4            # v3/v4 CLI 그룹만
./redeploy.sh deno             # Deno 4개만
./redeploy.sh oracle1          # 오라클1만 (오라클2→오라클1 SSH 키 2026-09-11 등록 완료)
./redeploy.sh oracle2          # 오라클2만
./redeploy.sh nahdd1234        # 그 계정의 v1/v2/v3/v4 전부 동시에
```
- 계정 토큰/Deno 토큰은 스크립트 상단에 하드코딩(`배포.md` 3.1.2/3.2와 동일).
- v3/v4는 **재배포마다 URL이 바뀐다**(랜덤 해시) — 바뀌면 `upstreams.conf` 수동 반영 필요.
  V1/V2/로컬/Deno는 고정 URL이라 배포만 하면 끝.
- 배포 후 각 노드를 실제 `/v1/models` 요청으로 자동 검증하고 결과 표를 출력한다.
- Vercel 프로젝트는 배포 후 `framework:null`/`ssoProtection:null` PATCH가 필수다 — 안 하면
  `framework`가 `node`로 오감지돼 `vercel.json`의 서버리스 라우팅이 무시되고 **모든 요청이
  404**로 죽는다(P16). `redeploy.sh`는 매 배포마다 자동으로 이 PATCH를 건다.

## 6. 문제 해결 이력 요약 (P0~P24, 상세는 `문제_해결.md`)

| # | 증상 | 원인 한 줄 |
|---|---|---|
| P6 | TEST 콤보 400 | 서버리스 배포판 코드 불일치 |
| P7 | Vercel 스트림 120초 절단 | Edge 절단 아니라 자체 AbortSignal |
| P8 | muse 스트리밍 전멸 | 이중 이스케이프 오염 |
| P9 | `input[N].content did not match any supported type` | museToInput의 assistant function_call이 content 안에 잘못 중첩 |
| P10 | 504 "30000ms 내 시작 안 함" | hold-back의 무기한 무음 구간 |
| P11 | "muse-spark 성공 후 다음 모델로 넘어감" | 리질리언스 스킵 + pool의 동티어 ALT 대체가 겹친 것(정상 동작, 로그 오독 주의) |
| P12 | Kiro `profileArn is required` (별개 시스템: 아래 §7) | Kiro 브랜드 게이트웨이가 profileArn 없는 계정 거부 |
| P13 | muse-spark 전역 마비(전부 ALT로만 성공) | response_format 거부를 모델 영구 결함으로 오판, 블랙리스트 TTL 없음 |
| P14 | P9와 동일 에러, 다른 위치(user 배열 콘텐츠) | museToInput의 user 쪽 `{type:"text"}` 파트 미변환 (코덱스 CLI AGENTS.md 주입) |
| P15 | 노드 하나의 404가 전체 요청을 즉시 종료 | "요청 스코프 vs 노드 스코프" 4xx 오판 |
| P16 | 특정 Vercel 노드 100% 404 | 그 프로젝트만 `framework:"node"`로 오감지 |
| P17 | Kilo `reasoning_effort`/`reasoning.effort` 충돌 400 | bifrost가 둘 다 보냄 → opencode-proxy가 무방비로 전달 |
| P18 | 코덱스가 omni1 호출 시 5회 재시도 후 접속 끊김 | `instance2-direct` 단일장애점(§3) + `server.js`가 SIGTERM 받아도 90초간 안 죽음(server 인스턴스 미보관) — 오라클2 재배포마다 90초 창이 생겨 겹침 |
| P19 | P17/P18 수정 후에도 코덱스 간헐적 실패 지속 | P17의 "조건부 삭제"가 실제 요청 모양(reasoning_effort만 있고 reasoning 객체 없음)에 안 맞아 무효 → 무조건 삭제로 재수정 + P18의 `instance2-direct` 단일장애점 자체를 제거(키 요청도 정상 페일오버) |
| P20 | `input[10].content` 재발 — Codex `wire_api=responses` 네이티브 passthrough 미정규화 | P14는 `chat→responses`만 고쳤고 네이티브 `responses` + `system/developer` 배열 `String()` 오염 미처리 → `sanitizeResponsesInput`+`normalizeMuseContentPart` role-aware로 수정 |
| P21 | Anthropic `/v1/messages` `system`/`tool`/`image` 침묵 실패 | `body.messages`만 전달, `system`·`tool_result`→`tool`·`image`→`image_url`·`input_schema→parameters` 미변환 → `anthropicMessagesToOpenAI` 등 4개 헬퍼로 복원 |
| P23 | `think`/`effort` 무시 및 `responses` `reasoning` 중복 400 | 콜론 외 `reasoning_effort`/`thinking.budget_tokens` 무시(항상 low) + `responses` muse에서 flat+nested 중복 → `effectiveVariant` fallback + flat `delete`로 수정(`138fd40`) |
| P24 | CLIProxyAPI 경유 muse-spark `/res/v1/responses` 400 `Unsupported tool type: image_generation` | CLIProxyAPI codex 실행기가 `tools`에 `{type:"image_generation"}`을 기본 자동 주입, zen이 그 타입 자체를 미지원 → `/res/v1/responses`에서 그 tool 항목만 걸러내고 나머지 바디는 그대로 passthrough |

**교훈 총정리(반복해서 나온 것들)**:
1. 헬스 프로브 성공 ≠ 실제 요청 경로 정상. 회귀 검증은 항상 클라이언트가 실제로 때리는 엔드포인트로.
2. "성공 로그가 전부 ALT/우회 경로로만 찍힌다"는 그 자체로 이상 신호.
3. 만료 없는 블랙리스트/캐시는 오탐 한 번에 영구 장애가 된다 — TTL을 원칙으로.
4. "이 계정 토큰으론 이 프로젝트 접근 못 한다"/"git 연결이라 손 못 댄다"는 실제로 찔러보기 전엔 가정일 뿐.
5. 코드 수정을 "전체 함대에 반영했다"고 확신하려면 실제 살아있는 주소 하나하나를 라이브 테스트할 것 — 문서/스크립트 결과가 아니라.
6. 요청 스코프 문제(재시도해도 똑같이 실패)와 노드 스코프 문제(다른 노드면 성공)를 구분할 것 — 대부분의 "숨겨진" 버그가 이 둘을 혼동한 데서 나왔다.

## 7. 별개 시스템: Kiro/CodeWhisperer (P12)

이 폴더의 주제(zen/Kilo 무료 모델 풀)와는 별개로, OmniRoute의 Kiro(AWS CodeWhisperer) 연동에서
"브랜드 게이트웨이(`runtime.*.kiro.dev`)가 profileArn 없는 Builder ID 계정을 거부"하는 버그를
같은 세션에서 발견·수정했다(업스트림 이슈 [#13192](https://github.com/diegosouzapw/OmniRoute/issues/13192), PR [#13193](https://github.com/diegosouzapw/OmniRoute/pull/13193)). 이건 OmniRoute 저장소
자체의 TypeScript 코드 수정이라 이 폴더의 배포 체계와 무관 — `문제_해결.md` P12 참고.

## 8. 빠른 진단 체크리스트 (새 장애 신고 받았을 때)

1. `curl localhost:8770/health`(오라클2)로 풀 상태·업스트림 개수 확인.
2. bifrost `logs.db`(`/app/data/services/bifrost/logs.db`, `node:sqlite` `DatabaseSync`로 조회)에서 해당 요청의 `error_details`/`params`/`input_history` 원문 확인 — 에러 메시지의 provider 라벨(`"(Console)"` 등)을 곧이곧대로 믿지 말고 `provider` 컬럼으로 실제 어디로 갔는지 확인.
3. `/opt/opencode-pool/pool.log`에서 같은 시각 로그 확인 — `[failover-soft]`/`[empty-stream]`/`[model-blacklist]`/`[err] status=`/`[ok]` 패턴으로 어느 노드가 뭘 했는지.
4. 의심되는 노드에 **직접** 같은 페이로드로 curl — pool을 거치지 않고 재현되는지 먼저 확인(노드 스코프 vs 시스템 전체 문제 구분).
5. 코드 수정이 필요하면: 오라클2 로컬(`/opt/opencode-proxy`, `/opt/opencode-pool`) 먼저 고치고 검증 → `/root/opencode_proxy`(git)에도 반영 → git push(V1/V2 일부만 자동배포, 신뢰 금지) → `redeploy.sh`로 전체 재배포 → 50개 전수 라이브 재검증.
6. `문제_해결.md`에 P-번호로 기록(다음 번호는 파일에서 `grep '^# P'`로 확인).

## 9. 관련 문서 (역사적 배경, 필요할 때만)

- `배포.md` — 배포 절차 전체(플랫폼별, 토큰표, 트러블슈팅), `redeploy.sh` 사용법
- `문제_해결.md` — P0~P19 전체 상세(증상/원인/수정/검증/교훈)
- `10_opencode_pool_아키텍처_및_dispatcher_버그.md (→ 이후 ../../OPENCODE_POOL/docs/00_아키텍처_및_dispatcher_버그.md 로 분리됨)` — pool.js 초기 아키텍처(15업스트림 시절, 숫자는 낡음)
- `09_멀티클라우드_배포_vercel_cf_deno.md` — 서버리스 멀티클라우드 배포 도입 배경
- `00_개요.md`~`08_...md` — LXC 5컨테이너 시절부터의 역사적 진화 과정
- `유의사항.md` — 작업 전 체크리스트(정규식 이스케이프/dispatcher/variant/페일오버/스트리밍/타임아웃/egress)
- [[00_아키텍처_개요|OMNIROUTE_BIFROST/00_아키텍처_개요]] / [[03_운영_트러블슈팅|OMNIROUTE_BIFROST/03_운영_트러블슈팅]] — 이 프록시의 상위 호출자인 OmniRoute·bifrost 자체의 구조와 장애 이력. 이 스킬 문서가 다루는 opencode-proxy/pool 자체 버그와는 층이 다르므로, 증상이 대시보드/프로바이더 등록/bifrost 프로세스 쪽이면 저쪽부터 볼 것.
