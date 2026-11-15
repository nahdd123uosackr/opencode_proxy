#!/bin/bash
# =============================================================================
# opencode_proxy 전체 함대 재배포 스크립트
# =============================================================================
# 실행 위치: 반드시 오라클2(oracle2)에서 실행할 것.
#   - Vercel/Deno CLI, 계정 토큰, 오라클1 SSH 접근이 전부 여기 있음.
#   - 최초 1회: scp로 오라클2의 아무 디렉토리(예: /root/opencode_proxy/)에 올린 뒤
#     chmod +x redeploy.sh 하면 됨. 이 위키 폴더의 사본은 문서/버전관리용 원본이고,
#     실제 실행은 오라클2에 올려서 한다.
#
# 사용법:
#   ./redeploy.sh                    전체(Vercel 38 + Deno 4 + 로컬 2) 병렬 재배포
#   ./redeploy.sh all                위와 동일
#   ./redeploy.sh vercel             Vercel 38개만 (v1+v2+v3+v4)
#   ./redeploy.sh v1                 V1 그룹 9개만 (jet/alpha/seven/rho/six/black/three/theta/two)
#   ./redeploy.sh v2                 V2 그룹 9개만 (v2/v2-blush/chi/xi/one/omega/snowy/murex/rho)
#   ./redeploy.sh v3                 v3 CLI 10개만
#   ./redeploy.sh v4                 v4 CLI 10개만
#   ./redeploy.sh deno               Deno 4개만
#   ./redeploy.sh oracle1            오라클1 로컬 서비스만
#   ./redeploy.sh oracle2            오라클2 로컬 서비스만
#   ./redeploy.sh local              oracle1 + oracle2
#   ./redeploy.sh clever             Clever Cloud (Node 12) Git push 자동 배포
#   ./redeploy.sh github             GitHub main push (Render Node 11 + Deplexo Node 13 자동 빌드 트리거)
#   ./redeploy.sh containers         clever + github (신규 컨테이너 노드 전체)
#   ./redeploy.sh convex             Convex 12개 배포 (c1~c12, conv/proxy) npx convex deploy
#   ./redeploy.sh convex 3           Convex 3번째 배포(dashing-leopard-797)만
#   ./redeploy.sh nahdd1234          그 계정의 v1/v2/v3/v4 전부 (있는 것만)
#   ./redeploy.sh deno oracle1 v3    여러 타겟 동시 지정 가능 (공백으로 구분)
#
# 모든 대상은 동시에(병렬 백그라운드 잡으로) 배포되고, 끝나면 각각 실제 요청으로
# 라이브 검증한 뒤 결과 표를 출력한다.
#
# 계정 ↔ 토큰, alias ↔ 프로젝트명 매핑은 배포.md 3.1.1/3.1.2/3.2 참고
# (2026-09-11 P17 사고로 V1/V2도 이미 있는 10개 계정 소유임이 밝혀짐 — 새 토큰 불필요).
# =============================================================================

set -uo pipefail

VERCEL=/root/.npm-global/bin/vercel
DENO=/root/.deno/bin/deno
REPO=/root/llm_proxy/opencode_proxy
SRC_VERCEL="$REPO/vercel"
SRC_LOCAL="$REPO/api/index.js"
# convex 프로젝트 원본: 이 저장소의 opencode_proxy/convex/ (opencode_proxy 사본이 없으면
# 기존 개발 위치 /root/convex-free-ai 로 폴백).
CONVEX_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/convex"
[ -f "$CONVEX_REPO/package.json" ] || CONVEX_REPO=/root/convex-free-ai
NPX="${NPX:-npx}"
NODE="${NODE:-node}"
WORKDIR="/tmp/redeploy-$$"
RESULTS="/tmp/redeploy-results-$(date +%Y%m%d-%H%M%S).txt"
mkdir -p "$WORKDIR"
: > "$RESULTS"

# --- 자격증명 로딩 ---
# 모든 배포 키는 /share/opencode_proxy_key.txt 한 곳에서 읽는다(저장소에 시크릿 금지).
# 파일 포맷:
#   VERCEL_TOKENS
#       [acct]="vcp_..."
#   DENO_TOKENS
#       [org]="ddo_..."
#   CONVEX_TOKENS
#       prod:<name>|<deploy-key>
KEY_FILE="${OPENCODE_PROXY_KEY_FILE:-/share/opencode_proxy_key.txt}"
if [ ! -r "$KEY_FILE" ]; then
  echo "FATAL: 자격증명 파일 없음: $KEY_FILE" >&2
  exit 1
fi

declare -A VERCEL_TOKENS=()
declare -A DENO_TOKENS=()
CONVEX_CR_FILE="$WORKDIR/convex_cr.txt"
: > "$CONVEX_CR_FILE"

_section=""
while IFS= read -r _line || [ -n "$_line" ]; do
  _line="${_line%$'\r'}"
  case "$_line" in
    ''|'#'*) continue ;;
    VERCEL_TOKENS|DENO_TOKENS|CONVEX_TOKENS) _section="$_line"; continue ;;
  esac
  case "$_section" in
    VERCEL_TOKENS)
      if [[ "$_line" =~ ^[[:space:]]*\[([^]]+)\]=\"([^\"]*)\" ]]; then
        VERCEL_TOKENS["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
      fi
      ;;
    DENO_TOKENS)
      if [[ "$_line" =~ ^[[:space:]]*\[([^]]+)\]=\"([^\"]*)\" ]]; then
        DENO_TOKENS["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
      fi
      ;;
    CONVEX_TOKENS)
      if [[ "$_line" =~ ^[[:space:]]*(prod:.+\|.+)$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}" >> "$CONVEX_CR_FILE"
      fi
      ;;
  esac
done < "$KEY_FILE"

if [ ${#VERCEL_TOKENS[@]} -eq 0 ]; then
  echo "FATAL: $KEY_FILE 에서 VERCEL_TOKENS 를 읽지 못했습니다" >&2
  exit 1
fi

# nahdd1238은 최근 별도 팀으로 재배정된 계정이라 v1/v2 프로젝트가 없음 (v3/v4만)
V1V2_ACCOUNTS=(nahdd123-6206 nahdd1234 nahdd1235 nahdd1236 nahdd1237 nahdd1239 tyinssa ty-recruiter nhdty)
ALL_VERCEL_ACCOUNTS=("${!VERCEL_TOKENS[@]}")

TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(all)

# 타겟에 all/vercel/local/deno 같은 그룹, 특정 그룹명(v1..v4), 또는 계정명이 있는지 확인
target_has() {
  local needle="$1"
  local t
  for t in "${TARGETS[@]}"; do
    [ "$t" = "$needle" ] && return 0
  done
  return 1
}

# 이 계정의 이 그룹(v1/v2/v3/v4)을 배포해야 하는지
want_group_for_account() {
  local acct="$1" grp="$2"
  local t
  for t in "${TARGETS[@]}"; do
    case "$t" in
      all|vercel) return 0 ;;
      "$grp") return 0 ;;
      "$acct") return 0 ;;
    esac
  done
  return 1
}

echo "=== 대상: ${TARGETS[*]} ==="

deploy_vercel() {
  local acct="$1" name="$2" label="$3"
  local token="${VERCEL_TOKENS[$acct]}"
  local td="$WORKDIR/${acct}-${name}"
  rm -rf "$td"; cp -r "$SRC_VERCEL" "$td"; rm -rf "$td/.vercel"
  local raw_out url
  raw_out=$(cd "$td" && VERCEL_FORCE_NO_TTY=1 "$VERCEL" deploy --prod --yes --token="$token" --name="$name" 2>"$WORKDIR/log-${acct}-${name}.log")
  url=$(echo "$raw_out" | grep -o 'https://[^" ]*\.vercel\.app' | head -n 1)
  [ -z "$url" ] && url=$(echo "$raw_out" | grep -o 'https://[^" ]*' | head -n 1)
  curl -s -X PATCH "https://api.vercel.com/v9/projects/${name}" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d '{"framework":null,"ssoProtection":null}' -o /dev/null
  local ok=FAIL
  if [ -n "$url" ]; then
    local hs
    hs=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://${url#https://}/v1/models" 2>/dev/null)
    [ "$hs" = "200" ] && ok=OK
  fi
  echo "${label}|${acct}|${url}|${ok}" >> "$RESULTS"
}

deploy_deno() {
  local org="$1"
  local token="${DENO_TOKENS[$org]}"
  ( cd "$REPO/deno" && "$DENO" deploy --token="$token" --org="$org" --app=opencode-proxy --prod --json --non-interactive \
      > "$WORKDIR/deno-${org}.json" 2>&1 )
  local url="https://opencode-proxy.${org}.deno.net"
  local hs
  hs=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$url/v1/models" 2>/dev/null)
  local ok=FAIL; [ "$hs" = "200" ] && ok=OK
  echo "deno|${org}|${url}|${ok}" >> "$RESULTS"
}

deploy_local() {
  local host="$1"   # oracle1 | oracle2
  local remote_path=/opt/opencode-proxy/api/index.js
  local svc=opencode-proxy

  ( cd "$REPO/utls_bridge" && go build -o utls_bridge . )

  if [ "$host" = "oracle2" ]; then
    cp "$remote_path" "${remote_path}.bak-$(date +%Y%m%d-%H%M%S)-pre-redeploy" >/dev/null 2>&1
    {
      node --check "$SRC_LOCAL" \
        && node --check "$REPO/server.js" \
        && cp "$SRC_LOCAL" "$remote_path" \
        && cp "$REPO/server.js" /opt/opencode-proxy/server.js \
        && cp "$REPO/utls_bridge/utls_bridge" /opt/opencode-proxy/utls_bridge \
        && chmod +x /opt/opencode-proxy/utls_bridge \
        && systemctl restart "$svc" \
        && sleep 2 \
        && systemctl is-active "$svc"
    } > "$WORKDIR/local-${host}.log" 2>&1
  else
    ssh -o ConnectTimeout=8 oracle1 "cp $remote_path ${remote_path}.bak-\$(date +%Y%m%d-%H%M%S)-pre-redeploy" >/dev/null 2>&1
    scp -o ConnectTimeout=8 "$SRC_LOCAL" "oracle1:/tmp/index.check.js" >/dev/null 2>&1
    scp -o ConnectTimeout=8 "$REPO/server.js" "oracle1:/opt/opencode-proxy/server.js" >/dev/null 2>&1
    scp -o ConnectTimeout=8 "$REPO/utls_bridge/utls_bridge" "oracle1:/opt/opencode-proxy/utls_bridge" >/dev/null 2>&1
    ssh -o ConnectTimeout=8 oracle1 "chmod +x /opt/opencode-proxy/utls_bridge && node --check /tmp/index.check.js && cp /tmp/index.check.js $remote_path && systemctl restart $svc && sleep 2 && systemctl is-active $svc" \
      > "$WORKDIR/local-${host}.log" 2>&1
  fi

  local ok=FAIL
  grep -q '^active$' "$WORKDIR/local-${host}.log" && ok=OK
  echo "local|${host}|-|${ok}" >> "$RESULTS"
}

deploy_clever() {
  local remote="clever"
  local url="https://app-66ffa726-7e8c-4adb-b6a8-fa11e9f43427.cleverapps.io"
  local log="$WORKDIR/clever.log"
  local ok=FAIL
  (
    cd "$REPO"
    git push "$remote" main:master --force > "$log" 2>&1
  )
  if [ $? -eq 0 ] || grep -qE "SUCCESS|The application has successfully been queued|Everything up-to-date" "$log" 2>/dev/null; then
    ok=OK
  fi
  echo "clever|clever-cloud|${url}|${ok}" >> "$RESULTS"
}

deploy_github() {
  local log="$WORKDIR/github.log"
  local ok=FAIL
  (
    cd "$REPO"
    git push origin main > "$log" 2>&1
  )
  if [ $? -eq 0 ] || grep -qE "Everything up-to-date" "$log" 2>/dev/null; then
    ok=OK
  fi
  echo "github|render+deplexo|https://github.com/nahdd123uosackr/opencode_proxy|${ok}" >> "$RESULTS"
}

# convex 12개 배포(c1~c12): 각 배포를 npx convex deploy 로 푸시하고 /health 로 검증.
# 인자 없으면 전체, 숫자 i 를 주면 i번째(cr 파일 정렬 순서 = dahl 슬롯 번호)만 배포.
deploy_convex() {
  local only="${1:-}"
  if [ ! -r "$CONVEX_CR_FILE" ]; then
    echo "convex|ALL|-|FAIL"; echo "  (누락: $CONVEX_CR_FILE — prod:<name>|<deploy-key> 12줄)" >&2
    return
  fi
  local idx=0 line name keylog
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    idx=$((idx + 1))
    if [ -n "$only" ] && [ "$only" != "$idx" ]; then continue; fi
    name="${line%%|*}"
    keylog="$WORKDIR/convex-${idx}.log"
    local runner=("$NODE" "$CONVEX_REPO/node_modules/convex/bin/main.js")
    [ -f "$CONVEX_REPO/node_modules/convex/bin/main.js" ] || runner=("$NPX" convex)
    (
      cd "$CONVEX_REPO" \
        && CONVEX_DEPLOY_KEY="$line" "${runner[@]}" deploy --yes > "$keylog" 2>&1
    )
    local ok=FAIL
    if grep -q 'Deployed Convex functions to' "$keylog" 2>/dev/null; then
      local hs
      hs=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://${name#prod:}.convex.site/health" 2>/dev/null)
      [ "$hs" = "200" ] && ok=OK
    fi
    echo "convex|${name#prod:}|https://${name#prod:}.convex.site|${ok}" >> "$RESULTS"
  done < "$CONVEX_CR_FILE"
}

PIDS=()

# Vercel 배포: v1만 배포 (v2, v3, v4는 전면 폐기)
for acct in "${V1V2_ACCOUNTS[@]}"; do
  if want_group_for_account "$acct" v1; then
    deploy_vercel "$acct" vercel-opencode-proxy v1 & PIDS+=("$!")
  fi
done

if target_has all || target_has deno; then
  for org in "${!DENO_TOKENS[@]}"; do
    deploy_deno "$org" & PIDS+=("$!")
  done
fi

if target_has all || target_has local || target_has oracle1; then
  deploy_local oracle1 & PIDS+=("$!")
fi
if target_has all || target_has local || target_has oracle2; then
  deploy_local oracle2 & PIDS+=("$!")
fi

if target_has all || target_has containers || target_has clever; then
  deploy_clever & PIDS+=("$!")
fi

if target_has all || target_has containers || target_has github; then
  deploy_github & PIDS+=("$!")
fi

if target_has all || target_has convex; then
  CONVEX_ONLY=""
  for t in "${TARGETS[@]}"; do
    case "$t" in
      ''|*[!0-9]*) ;;
      *) CONVEX_ONLY="$t" ;;
    esac
  done
  deploy_convex "$CONVEX_ONLY" & PIDS+=("$!")
fi

echo "총 ${#PIDS[@]}개 작업 병렬 실행 중... (완료까지 최대 1~2분)"
for pid in "${PIDS[@]}"; do
  wait "$pid" 2>/dev/null
done

echo
echo "=== 결과 (${RESULTS}) ==="
if command -v column >/dev/null 2>&1; then
  column -t -s'|' "$RESULTS"
else
  cat "$RESULTS"
fi

fail_count=$(grep -c '|FAIL$' "$RESULTS" || true)
echo
echo "성공 $(grep -c '|OK$' "$RESULTS" || true) / 실패 ${fail_count}"

if grep -qE '^v[34]\|.*\|OK$' "$RESULTS"; then
  echo
  echo "⚠️  v3/v4는 재배포마다 URL이 바뀝니다(v1/v2/로컬/deno는 고정 URL)."
  echo "   위 표의 새 URL을 /etc/systemd/system/opencode-pool.service.d/upstreams.conf 에"
  echo "   수동으로 반영하고 'systemctl daemon-reload && systemctl restart opencode-pool' 하세요."
  echo "   (풀 URL이 안 바뀌었어도, 방금 재배포로 코드는 이미 최신으로 교체됨)"
fi


# --- auto-sync pool upstreams.conf v3/v4 URLs from this run's results (added 2026-10-14) ---
SYNC=/opt/opencode-pool/sync-upstreams.sh
if [ -x "$SYNC" ] && grep -qE '^v[34]\|.*\|OK$' "$RESULTS"; then
  echo
  echo "=== pool upstreams.conf 자동 동기화 (v3/v4 URL 갱신) ==="
  bash "$SYNC" "$RESULTS" || echo "[sync] WARNING: sync-upstreams.sh returned non-zero (see above)"
else
  echo "(sync-upstreams: skipped — no v3/v4 OK results or script missing)"
fi

rm -rf "$WORKDIR"

# =============================================================================
# 신규 PaaS 컨테이너 노드 재배포 가이드 (Node 11, 12, 13)
# =============================================================================
# 1. Render (Node 11):
#    - GitHub nahdd123uosackr/opencode_proxy 연결되어 있으므로 main 브랜치 git push 시 자동 빌드/재배포됨.
#    - 수동 트리거: Render 대시보드 -> Manual Deploy -> Deploy latest commit
# 2. Clever Cloud (Node 12):
#    - Git push 배포: git push git+ssh://git@push-par-clevercloud-customers.services.clever-cloud.com/app_66ffa726-7e8c-4adb-b6a8-fa11e9f43427.git main
# 3. Deplexo (Node 13):
#    - GitHub nahdd123uosackr/opencode_proxy 연결되어 있으므로 main 브랜치 git push 시 자동 빌드/재배포됨.
#    - 수동 트리거: Deplexo 대시보드 -> Re-deploy
# =============================================================================
