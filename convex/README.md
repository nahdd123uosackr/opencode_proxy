# Convex Free AI Gateway

Convex HTTP Actions로 무료(`:free`) AI 모델만 프록시하는 OpenAI 호환 엔드포인트.

- Base (production): `https://amiable-quail-167.ap-southeast-2.convex.site`
- Deployment: `amiable-quail-167` (prod)
- Bearer key: `/root/workspace/convex_key.txt` (0600, `fk_` + 48 hex)

## 인증 (필수)

`/v1/*` 와 `/debug` 는 `Authorization: Bearer <FREE_AI_KEY>` 또는 `x-api-key: <FREE_AI_KEY>` 를 요구한다.
`FREE_AI_KEY` 가 설정되지 않은 배포는 fail-closed 로 503 을 반환하며 공개 릴레이가 되지 않는다.
`GET /health` 만 무인증으로 열려 있다.

```bash
KEY=$(cat /root/workspace/convex_key.txt)
curl -H "Authorization: Bearer $KEY" https://amiable-quail-167.ap-southeast-2.convex.site/v1/models
```

## 엔드포인트

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/health` | 상태/upstream/클라이언트 키 필요 여부 |
| GET | `/debug` | upstream 접근 단계별 진단 (서비스 토큰 상태 포함) |
| GET | `/v1/models` | 무료 모델 카탈로그만 반환 (5분 캐시) |
| POST | `/v1/chat/completions` | 무료 모델 chat, `stream: true` SSE 지원 |
| POST | `/v1/embeddings` | 무료 모델 임베딩 |

## 무료 판별 규칙

모델 id가 `:free` / `/free` / `-free`로 끝나거나 `openrouter/free`인 경우만 허용.
그 외 모델은 `403 model_not_free`로 거부한다.

## Upstream 설정

Convex AI Gateway(`getServiceToken("ai-gateway")`)는 **유료 플랜 전용**이라 이 팀에서는 사용할 수 없다
(`The Convex AI gateway is not enabled for your team`). 따라서 정적 upstream으로 전환했다.

```bash
npx convex env set --deployment cheerful-setter-130 UPSTREAM_BASE_URL 'https://9r.nhd.us.to'
npx convex env set --deployment cheerful-setter-130 UPSTREAM_API_KEY 'sk-...'
# 필수: 미설정 시 /v1/* 는 503 (fail-closed)
npx convex env set --prod FREE_AI_KEY "$(cat /root/workspace/convex_key.txt)"
```

`UPSTREAM_BASE_URL`이 없으면 코드는 자동으로 Convex AI Gateway를 사용한다
(`https://ai-gateway.convex.dev`). 팀 플랜이 업그레이드되면 env만 지우면 된다.

## 배포

```bash
export CONVEX_DEPLOY_KEY='prod:amiable-quail-167|...'
npx convex deploy --yes
```

## 호출 예시

```bash
KEY=$(cat /root/workspace/convex_key.txt)
curl -X POST https://amiable-quail-167.ap-southeast-2.convex.site/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"openrouter/recursive/flint-v1.0:free","messages":[{"role":"user","content":"hi"}]}'
```

## 알려진 제약

- 무료 모델 자체의 rate limit(429)은 upstream 응답을 그대로 반환한다.
- `_generated`는 배포 시 재생성된다. 로컬 `codegen`은 dev deployment 로그인이 필요하다.