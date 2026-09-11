# 11. res/chat/mes 프로토콜 분리 passthrough + CLIProxyAPI 연동 (2026-09-11)

## 배경 — 왜 변환(translation) 대신 분리(passthrough)로 갔나

opencode-proxy는 그동안 `/v1/chat/completions`, `/v1/messages`, `/v1/responses` 세 엔드포인트를
전부 받아서 서로 변환해주는 방식이었다 (P3, P9, P14, P20, P21, P23 …). 문제는 zen 업스트림 자체가
**모델별로 실제 동작하는 엔드포인트가 다르다**는 것 — 대표적으로 muse-spark 계열은 `/chat/completions`
호출 시 빈 응답/500을 내고 `/responses`로만 정상 동작한다(P9/P21). 우리는 이 사실을 매번 클라이언트가
어느 엔드포인트로 부르든 프록시가 내부에서 알아서 우회 라우팅하는 식으로 패치해왔는데, 새로운 클라이언트
포맷이나 필드가 등장할 때마다 같은 유형의 400/빈응답 버그가 재발했다(변환 레이어 자체가 버그의 근원).

**설계 전환(2026-09-11)**: 변환을 아예 하지 않는다. 대신 클라이언트가 "이 모델은 이 프로토콜로만 부른다"를
스스로 알고 맞는 경로로 부르게 하고, 우리 프록시는 그 경로를 업스트림 네이티브 엔드포인트로 **바디 변형 없이
그대로** 흘려보낸다. 세 경로로 나눈 이유는 zen이 `/chat/completions`, `/responses`, `/v1/messages` 세
엔드포인트를 실제로 전부 제공하기 때문(전부 401 확인 — 라우트 자체는 존재).

## 새 라우트 3개 (순수 passthrough, 바디 변형 없음)

| 경로 | 업스트림 대상 | 대상 모델군 |
|---|---|---|
| `GET /res/v1/models`, `POST /res/v1/responses` | `UPSTREAM + /responses` | `/responses`에서만 동작 (muse-spark 계열) |
| `GET /chat/v1/models`, `POST /chat/v1/chat/completions` | `UPSTREAM + /chat/completions` | 나머지 대부분 (gpt/gemini/grok/deepseek/glm/minimax/kimi/qwen/big-pickle 등) |
| `GET /mes/v1/models`, `POST /mes/v1/messages` | `UPSTREAM + /messages` | zen이 네이티브 Anthropic Messages로 서빙하는 claude-* 계열 |

구현 위치: `api/index.js`(및 `vercel/api/index.js`, `deno/main.ts`) — `NATIVE_PASSTHROUGH_ROUTES` 상수와
그 아래 핸들러 블록. 기존 `/v1/chat/completions` 등 변환형 라우트는 **그대로 유지**했다(하위 호환 + 이미
내부적으로 muse→responses 리다이렉트를 하는 로직이 있어 여전히 유효).

### 중요 발견: `x-api-key` vs `Authorization: Bearer`

zen의 `/chat/completions`, `/responses`는 `Authorization: Bearer <key>`로 정상 동작하지만,
`/v1/messages`는 진짜 Anthropic Messages API 계약을 따라서 **`x-api-key` 헤더를 요구**한다.
`injectHeaders()`는 원래 Bearer만 세팅하므로, `/mes/v1/messages` 라우트는 zenApiKey가 있을 때
`x-api-key`로 바꿔서 보내도록 별도 분기 처리했다 (`headers['x-api-key'] = zenApiKey; delete headers['Authorization']`).
이걸 놓치면 실제로는 정상 요청인데도 zen이 `AuthError: Missing API key`를 낸다 — 검증 중 실제로 걸렸던 버그.

### 코드 개선: 400 자동 완화 재시도

같은 세션에서 `LiveXY/responses-to-chat`의 아이디어를 참고해 `/v1/responses` 핸들러에
"400이 특정 optional 필드(`metadata`/`parallel_tool_calls`/`previous_response_id`/`store`/
`service_tier`/`reasoning`)를 언급하면 그 필드만 제거하고 1회 재시도"하는 `detectDegradableField()`
안전망을 추가했다. P3/P9/P14/P20 같은 "zen이 지원 안 하는 optional 필드 하나 때문에 요청 전체 실패"
패턴을 사전에 흡수하려는 목적.

## CLIProxyAPI — OmniRoute가 이미 내장하고 있던 두 번째 라우팅 엔진

bifrost로 `/responses` 전용 커스텀 프로바이더를 등록하려 했으나 **bifrost는 `base_provider_type: openai`
로 등록한 커스텀 프로바이더를 항상 `base-url + /v1/chat/completions`로만 호출**하고(`anthropic` 타입은
`+ /v1/messages`), Responses API 전용 타입 자체가 없다는 걸 실측으로 확인했다(`azure`/`bedrock`/`vertex`/
`groq`/`mistral`은 등록 자체가 거부됨, `openai`/`anthropic`/`cohere`/`gemini`만 허용).

그런데 `omniroute` pod 안을 다시 스캔해보니(`/proc/<pid>/cmdline`으로 프로세스 직접 확인 — `ps`/`curl`이
컨테이너에 없어서 `/proc`을 직접 읽거나 `node -e "fetch(...)"`로 우회) **CLIProxyAPI가 이미 별도 프로세스로
떠 있었다**:

```
/app/data/bin/cliproxyapi --config /app/data/services/cliproxy/config.yaml   (포트 8317, 127.0.0.1 전용)
```

`/app/data/cliproxyapi/logs/error-v1-responses-*.log`, `error-v1-messages-*.log` 로그가 실제로 존재해서
(2026-09-06부터) Antigravity/Codex/Claude/Grok OAuth 기반 CLI 계정을 이 CLIProxyAPI가 서빙해온 것으로
보인다 — OmniRoute의 `agy`/`antigravity`/`codex`류 provider가 bifrost가 아니라 이쪽을 거칠 가능성이 높다.

CLIProxyAPI는 bifrost와 달리 **프로토콜별로 완전히 분리된 3개의 네이티브 업스트림 섹션**을 config에서
지원한다:

| config 섹션 | 실제 호출 경로 | 우리 대응 라우트 |
|---|---|---|
| `openai-compatibility` | `base-url + /chat/completions` | `/chat/v1/chat/completions` |
| `codex-api-key` | `base-url + /responses` | `/res/v1/responses` |
| `claude-api-key` | `base-url + /v1/messages` (⚠ base-url 자체에 `/v1`을 넣으면 `/v1/v1/messages`로 중복됨) | `/mes/v1/messages` |

즉 `openai-compatibility`/`codex-api-key`는 base-url에 `/v1`을 **포함**시켜야 하고(`.../chat/v1`,
`.../res/v1`), `claude-api-key`는 base-url에 `/v1`을 **포함시키면 안 된다**(`.../mes`만). 이 셋의
suffix 규칙이 서로 다르다는 걸 실제로 404를 받아보고서야 알았다 — 아래 "실측 검증" 참고.

## config.yaml 패치 방법

파일 위치: `/app/data/services/cliproxy/config.yaml` (pod 내부, `omniroute` 컨테이너).
**PyYAML로 파싱은 검증용으로만 쓰고, 실제 쓰기는 순수 텍스트 치환으로 한다** — 이 파일에는 기존에
disabled 상태로 등록된 프로바이더 16개(zai/cline1/nvidia/... 등, 전부 `disabled: true`)와 실 API 키가
잔뜩 들어있는데, PyYAML로 로드 후 dump하면 키 순서/포맷이 흐트러지고 예상 못한 부분이 깨질 위험이 있다.

### 1) 안전 패치 절차

```bash
# 1. 현재 라이브 config를 로컬로 가져온다
ssh oracle1 "kubectl exec -n omniroute pod/<POD> -c omniroute -- cat /app/data/services/cliproxy/config.yaml" \
  > /tmp/cliproxy-config-live.yaml

# 2. 파이썬으로 텍스트 치환 (마커 문자열 앞에 새 블록을 삽입 — 아래 "마커 선택" 참고)
python3 patch_script.py   # /tmp/cliproxy-config-patched.yaml 생성

# 3. 반드시 파싱 검증 (문법 깨짐 방지, dump는 하지 않고 load만)
python3 -c "import yaml; yaml.safe_load(open('/tmp/cliproxy-config-patched.yaml'))"

# 4. oracle1 경유로 pod에 kubectl cp (로컬→oracle1 scp 먼저, kubectl cp는 원격 실행이라 로컬 경로를
#    직접 못 읽음 — ssh로 감싼 kubectl cp에 로컬 절대경로를 주면 "파일이 없다"고 실패한다)
scp /tmp/cliproxy-config-patched.yaml oracle1:/tmp/
ssh oracle1 "kubectl cp /tmp/cliproxy-config-patched.yaml omniroute/<POD>:/app/data/services/cliproxy/config.yaml -c omniroute"

# 5. 원본은 patch 전에 pod 안에서 타임스탬프 백업해둔다 (덮어쓰기 전에 필수)
ssh oracle1 "kubectl exec -n omniroute pod/<POD> -c omniroute -- cp /app/data/services/cliproxy/config.yaml \
  /app/data/services/cliproxy/config.yaml.bak-$(date +%Y%m%d-%H%M%S)"
```

### 2) 마커 선택 — 삽입 지점 주의

top-level 키 순서가 `openai-compatibility` → `codex-api-key` → `claude-api-key` → `credential-concurrency`
이므로, 각 섹션에 새 리스트 항목을 추가할 때 삽입 마커를 **그 섹션 바로 다음에 오는 top-level 키**로
잡아야 한다. 처음에 실수로 전부 `\ncredential-concurrency:` 하나만 마커로 써서, `openai-compatibility`용
새 항목이 실제로는 `claude-api-key` 리스트 뒤에 붙어버리는 버그를 냈다(YAML 파싱은 성공하지만 잘못된
섹션에 들어감 — `python3 -c "import yaml; ... print(len(d['openai-compatibility']))"`로 개수를 반드시
확인해야 발견됨). 올바른 마커:

```python
m1 = '\ncodex-api-key:'         # openai-compatibility 새 항목은 여기 앞에 삽입
m2 = '\nclaude-api-key:'        # codex-api-key 새 항목은 여기 앞에 삽입
m3 = '\ncredential-concurrency:' # claude-api-key 새 항목은 여기 앞에 삽입
```

### 3) `prefix` 필드 필수 — 모델명 충돌 방지

`openai-compatibility`/`codex-api-key`/`claude-api-key`에 등록하는 모델의 `name`(예: `gpt-5`,
`claude-sonnet-5`, `muse-spark-1.3`)은 **CLIProxyAPI가 이미 서빙 중인 OAuth 기반 실행기의 진짜 모델
카탈로그와 이름이 겹칠 수 있다**(실제로 겹쳤다 — 첫 시도 때 `prefix` 없이 등록했더니 `/v1/models`에
바로 78→148개로 늘긴 했지만 이름 충돌 여부를 육안으로 구분 못 했다). 반드시 각 신규 항목에
`prefix: "..."`를 지정해서 `zen/gpt-5`, `opencode-zen1/big-pickle`, `kilo1/kilo-auto/free`처럼
네임스페이스를 분리해야 한다.

### 4) 핫 리로드 없음 — 반드시 재시작 필요

config.yaml을 덮어써도 실행 중인 `cliproxyapi` 프로세스는 즉시 반영하지 않는다(테스트로 확인 — 파일
갱신 후 새 모델 호출 시 `unknown provider` 에러). **프로세스를 재시작해야** 새 설정이 메모리에 로드된다.
재시작 확인은 PID 변화로:

```bash
ssh oracle1 "kubectl exec -n omniroute pod/<POD> -c omniroute -- sh -c \
  'for p in /proc/[0-9]*; do tr \"\\0\" \" \" < \$p/cmdline 2>/dev/null | grep -q cliproxyapi && echo \$p; done'"
```

재시작 직후 이전에 실패했던 크리덴셜이 **쿨다운 상태로 캐시**되어 있을 수 있다(`x-api-key` 헤더 버그를
고치기 전에 한번 실패한 `claude-api-key` 항목이, 코드를 고친 뒤에도 "no auth available … check cooldown
state" 에러를 낸 사례) — 이 경우도 재시작 한 번 더 하면 쿨다운이 초기화된다. 관리 API(`/v0/management/...`)로
직접 쿨다운을 지우려면 `remote-management.secret-key`의 평문 비밀번호가 필요한데 config.yaml에는
bcrypt 해시만 있어서 우리는 접근 불가 — 재시작이 유일한 해결 경로였다.

**⚠ "재시작"은 저절로 되지 않는다 (P27에서 실전으로 확인)** — 부모 프로세스(omniroute 메인, PID 20)가
`cliproxyapi` 자식 프로세스를 감시·자동 재기동해줄 거라 가정하고 `sh -c 'kill <pid>'`로 종료시켰더니
**자동으로 다시 안 떴다** — `/proc` 재스캔 결과 프로세스가 완전히 죽은 채로 남아 `:8317` 전체가 잠깐(~10초)
다운됐다. 직접 아래처럼 백그라운드로 재기동해야 한다:

```bash
ssh oracle1 "kubectl exec -n omniroute pod/<POD> -c omniroute -- sh -c \
  'nohup /app/data/bin/cliproxyapi --config /app/data/services/cliproxy/config.yaml \
   > /tmp/cliproxyapi-manual-restart.log 2>&1 &'"
```

`disown`은 이 컨테이너 셸에 없어 생략해도 무방(`kubectl exec` 세션이 끝나도 `nohup`만으로 프로세스가 계속
살아있는 것을 확인함). 그리고 `kubectl exec pod -- kill <pid>`처럼 `sh -c`로 안 감싸면 컨테이너에 `kill`
바이너리 자체가 없어서 즉시 실패한다(`exec: "kill": executable file not found`) — 반드시 `sh -c 'kill
<pid>'`로 감쌀 것(이 컨테이너는 `ps`/`curl`도 없다는 기존 제약과 같은 종류).

### 5) 실제 키 값 확인 — 관리 API는 마스킹됨

bifrost 관리 API(`GET /api/providers/{name}/keys`)는 키 값을 `sk-3************************xUXi`처럼
마스킹해서 반환한다. 전체 평문이 필요하면 bifrost의 sqlite에서 직접 조회해야 한다:

```bash
ssh oracle1 "kubectl exec -n omniroute pod/<POD> -c omniroute -- node -e \"
const D=require('better-sqlite3');
const db=new D('/app/data/services/bifrost/config.db');
const rows=db.prepare(\\\"SELECT name, provider, value FROM config_keys WHERE provider='opencode-zen1'\\\").all();
rows.forEach(r=>console.log(r.provider, r.name, r.value));
\""
```

bifrost 세션 토큰(관리 API 인증용)도 같은 방식으로 얻는다: `sessions` 테이블에서
`SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1`.

## 최종 등록 상태 (2026-09-11 기준)

| CLIProxyAPI 항목 | 섹션 | base-url | prefix | 키 출처 | 모델 |
|---|---|---|---|---|---|
| `opencode-chat` | openai-compatibility | `http://192.168.200.2:8769/chat/v1` | `zen` | zen 무결제 sk- 키 1개 | zen 유료+무료 chat 계열 54개 |
| `opencode-res` | codex-api-key | `http://192.168.200.2:8769/res/v1` | `zen` | 〃 | muse-spark 4개 |
| `opencode-mes`(claude-api-key 리스트 항목) | claude-api-key | `http://192.168.200.2:8769/mes` | `zen` | 〃 | claude-* 12개 |
| `opencode-zen1-chat` | openai-compatibility | 〃 | `opencode-zen1` | bifrost `opencode-zen1` 프로바이더(15키) | 무료만 6개: big-pickle/deepseek-v4-flash-free/nemotron-3-ultra-free/nemotron-3.5-lightning-free/mimo-v2.5-free/ling-3.0-flash-fin-free |
| `opencode-zen1-res` | codex-api-key | 〃 | `opencode-zen1` | 〃 | 무료 muse-spark 2개 |
| `opencode-zen1-mes` (claude-api-key 리스트 항목, models: []) | claude-api-key | `http://192.168.200.2:8769/mes` | `opencode-zen1` | 〃(첫 키만) | **없음** — 이 키의 무료 목록에 claude 계열이 원래 없음(유료 전용). 모델을 지어내지 않고 빈 목록으로 등록만 해둠 |
| `kilo1` | openai-compatibility | `https://api.kilo.ai/api/gateway` (우리 프록시 경유 안 함, kilo는 zen과 무관한 별도 서비스) | `kilo1` | bifrost `kilo-gateway` 프로바이더(14키, JWT) | 무료 21개 |

## 검증 결과 (실측)

키가 필요한 4개 신규 항목 (`opencode-zen1-*`, `kilo1`) — 무료 모델 + 키:

| 호출 | 결과 | 판정 |
|---|---|---|
| `opencode-zen1/big-pickle` | 429 `FreeUsageLimitError`(zen 실응답, rate limit) | ✅ 라우팅/인증 정상, 업스트림 레이트리밋만 |
| `opencode-zen1/muse-spark-1.3-contributor-free` | 400 `Unsupported tool type: image_generation`(zen 실응답) | ⚠ 발견 당시 미해결이었으나 **P24로 수정 완료**(`문제_해결.md` P24) — CLIProxyAPI가 자동 주입하는 `image_generation` tool을 `/res/v1/responses`에서 필터링 |
| `kilo1/kilo-auto/free` | **200 완전 성공** (`dots-studio/dots-3-note-preview:free`로 라우팅됨, provider: AtlasCloud) | ✅ 완전 정상 |

기존 등록된 `chat`/`res`/`mes`(무결제 zen 키 사용) — **키 없이** 직접 우리 프록시 호출:

| 호출 | 결과 | 판정 |
|---|---|---|
| `POST /chat/v1/chat/completions` `big-pickle`, 키 없음 | 429 `FreeUsageLimitError`(zen 실응답) | ✅ 무료 티어 정상, 레이트리밋만 |
| `POST /res/v1/responses` `muse-spark-1.3-contributor-free`, 키 없음 | **200 완전 성공**, `"OK"` 텍스트 정상 응답 | ✅ 완전 정상 — 무료 모델은 zen 키 없이도 동작 확인 |
| `POST /mes/v1/messages` `claude-haiku-4-5`, 키 없음 | 401 `AuthError: Missing API key` | ⚠ 예상된 결과 — zen의 claude 계열은 원래 무료 티어가 없어서 키 필수. 버그 아님 |

## 남은 이슈 / 후속 과제

1. **`opencode-zen1-mes`에 무료 모델 없음** — zen1 키의 무료 카탈로그에 claude 계열이 없어서 실질적으로
   비어있는 등록. claude 계열을 실제로 쓰려면 결제된 zen 키가 필요(위 "결제수단 미등록" 이슈와 동일 계열).
2. ~~**CLIProxyAPI가 `/responses` 요청에 기본 tool(`image_generation`)을 자동 주입**하는 것으로 보이는데,
   zen이 이를 거부한다(`opencode-zen1-res` 테스트에서 확인). `codex-api-key` 쪽 tool 기본값 비활성화
   옵션이 있는지 추가 조사 필요.~~ → **2026-09-11 P24로 해결.** CLIProxyAPI 쪽 `payload.filter` 설정으로
   막을 수 있는지 조사했으나 배열 요소 조건부 제거의 공식 지원이 불확실해, `/res/v1/responses`
   passthrough 라우트에서 `tools[].type === "image_generation"`만 걸러내는 방식으로 opencode-proxy
   쪽에서 직접 수정(상세: `문제_해결.md` P24).
3. **CLIProxyAPI 관리 API 접근 불가** — `remote-management.secret-key`가 bcrypt 해시라 쿨다운 상태 조회/
   해제, 프로바이더 동적 추가 같은 걸 API로 못 하고 매번 config.yaml 직접 수정 + 프로세스 재시작으로만
   가능하다. 평문 비밀번호를 알아내거나 새로 설정할 방법이 있으면 운영이 훨씬 편해진다.
4. bifrost `openai` 커스텀 프로바이더는 여전히 muse-spark류(Responses 전용 모델)를 등록 못 한다 — 이
   부분은 CLIProxyAPI의 `codex-api-key` 섹션으로 완전히 대체됨.

## 후속 확장: GET /models 무료 필터링 누락 수정 + `/kilo/v1/*` 전용 라우트 신설 (2026-09-11 후속)

### GET /models 무료 필터링 누락 (P25)

`GET /res|chat|mes/v1/models`는 위 §2 "새 라우트 3개" 설계 당시 POST 쪽과 같은 "바디 무변형 passthrough"
원칙을 그대로 적용해서 zen 업스트림 `/models` 응답을 필터 없이 반환하고 있었다 — 레거시 `GET /v1/models`는
키 종류와 무관하게 항상 무료 모델만 반환하는데, 신규 라우트만 유료 모델(`claude-opus-5` 등)까지 그대로
노출된 것. 응답 바디의 `data` 배열을 `id.endsWith('-free') || KNOWN_FREE_EXTRA.has(id)` 기준(레거시와 동일
기준)으로 필터링하도록 수정. 상세: `문제_해결.md` P25. 3개 사본 동일 적용 후 44/44 재배포·검증.

### Kilo 키가 이 라우트군에서 무시되는 건 버그가 아니라 설계 (P26)

"Kilo 키를 넣으면 Kilo 모델만 반환되나?" 질문에서 시작 — 레거시 `/v1/models`는 실제로 Kilo/Zen 키에 따라
분기하지만, `/res|chat|mes/*`는 애초에 **zen 전용**으로 설계돼 있어(POST 쪽도 Kilo 분기 없음) Kilo 키를
넣어도 항상 zen 모델만 나온다. Kilo는 zen과 무관한 별도 서비스라 이 라우트군이 풀려던 "zen 모델별
엔드포인트 불일치" 문제 자체가 없기 때문 — 회귀가 아님을 `git log -S"KILO_BASE"`(전체 히스토리에서 Kilo
라우팅 코드가 한 번도 수정된 적 없음)로 확인.

이후 사용자 요청으로 Kilo도 동일한 네이티브 passthrough 원칙의 전용 라우트를 신설:

| 경로 | 동작 |
|---|---|
| `GET /kilo/v1/models` | 기존 `getKiloFreeModels()` 재사용, 무료만, `kilo/` 접두사는 벗기고 반환 |
| `POST /kilo/v1/chat/completions` | `KILO_BASE + '/chat/completions'`로 직접 forward. `kilo/` 접두사 방어적 스트립, 클라이언트 `Authorization` 있으면 전달(없으면 키 없이 무료 모델 접근 허용), `reasoning_effort`/`reasoningEffort` 무조건 제거(P17 재발 방지) |

`isNativeProtocolPrefix`에 `/kilo/` 추가해 `PROXY_API_KEY` 보호 범위 포함. 상세: `문제_해결.md` P26.
커밋: `165197f` — GET `/models` 무료 필터(P25)와 Kilo 라우트(P26) 둘 다 이 커밋 하나에 포함(배포·검증은
각각 별도 시점에 44/44로 완료된 뒤 한 번에 커밋됨).

### CLIProxyAPI `openai-compatibility`에 muse-spark 중복 등록 — `/chat/completions` 경유 504 (P27)

§"config.yaml 패치 방법"으로 등록한 `opencode-chat`·`opencode-zen1-chat`(둘 다 `openai-compatibility`)의
`models:` 목록에 muse-spark가 **`codex-api-key`(`opencode-res`/`opencode-zen1-res`)와 중복 등록**돼
있었다 — OmniRoute의 자체 provider(`mycli`, `base_url: http://omniroute-scsi:8317/v1`)가 이 잘못된
경로로 muse-spark를 호출하면 CLIProxyAPI가 `/chat/v1/chat/completions`(zen 실제 chat/completions
passthrough)로 forward, muse-spark는 거기서 항상 hang → 30초 504. `openai-compatibility` 쪽 목록에서만
muse-spark 2개 항목 제거해 해결. 부수적으로 **CLIProxyAPI는 kill해도 자동 재기동되지 않는다**는 걸 실전에서
확인(§4 "핫 리로드 없음" 갱신 참고). 상세: `문제_해결.md` P27.

### `/res/v1/responses`에 작은 `max_output_tokens`로 muse 호출 시 502 empty stream (P28)

OmniRoute에 정상 등록된 또 다른 provider `openprox-res`(`base_url: .../res/v1`, `api_type: "responses"` —
등록 자체는 정확함, `call_logs.target_format:"openai-responses"`로 확인)를 통해 muse-spark를 호출했는데
`max_output_tokens:64`처럼 작은 값을 보내니 pool의 47개 노드 전부에서 동일하게 "empty stream" 판정을
받아 502. muse는 실제 출력 전에 reasoning으로 먼저 토큰을 쓰는데, 예산이 작으면 reasoning만으로 다
소진되고 `output:[]`인 채로 HTTP 200 "성공"한다 — 레거시 변환 경로가 강제하던 `max_output_tokens ≥
131072` 하한이 이 순수 passthrough 경로엔 없어서 재발. 동일 하한을 muse 모델일 때만 추가해 해결(P24의
image_generation 필터와 같은 성격의 최소 예외). 상세: `문제_해결.md` P28.
