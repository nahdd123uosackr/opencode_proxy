#!/bin/bash
# Deploys the WS->TCP relay as a dedicated project (zen-ws-relay) on each Vercel account. Does NOT touch the production proxy projects.
# Secrets (tokens, RELAY_AUTH) are read from /root/opencode_proxy_redeploy.sh and never printed.
set -u
SRC=/opt/opencode-v2/relay-src; OUT=/opt/opencode-v2/relays.json; WORK=$(mktemp -d /tmp/zen-relay-deploy.XXXXXX)
f=/root/opencode_proxy_redeploy.sh
s=$(grep -n '^declare -A VERCEL_TOKENS' $f | cut -d: -f1); e=$(awk -v s=$s 'NR>s && /^\)/{print NR; exit}' $f); eval "$(sed -n "${s},${e}p" $f)"
RELAY_AUTH=$(grep -E '^RELAY_AUTH=' $f | head -1 | cut -d= -f2- | tr -d '"'"'"'')
[ -z "$RELAY_AUTH" ] && { echo "RELAY_AUTH not found in $f"; exit 2; }
ACCOUNTS=${ACCOUNTS:-"nahdd123-6206 nahdd1234 nahdd1235 nahdd1236 nahdd1237 nahdd1239 nhdty ty-recruiter tyinssa"}
NAME=zen-ws-relay

deploy_one() {
  local acct=$1 T="${VERCEL_TOKENS[$1]}" d="$WORK/$1"
  mkdir -p "$d"; cp -r "$SRC/api" "$SRC/package.json" "$SRC/vercel.json" "$d"/
  ( cd "$d" && VERCEL_FORCE_NO_TTY=1 /root/.npm-global/bin/vercel deploy --prod --yes --token="$T" --name="$NAME" -e RELAY_AUTH="$RELAY_AUTH" >"$d/out.txt" 2>"$d/err.txt" )
  local url; url=$(tail -1 "$d/out.txt")
  curl -s -m 30 -o /dev/null -X PATCH "https://api.vercel.com/v9/projects/$NAME" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"framework":null,"ssoProtection":null}'
  # persist the secret as a project env var too, so later redeploys keep working (ignore "already exists")
  curl -s -m 30 -o /dev/null -X POST "https://api.vercel.com/v10/projects/$NAME/env?upsert=true" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
       -d "{\"key\":\"RELAY_AUTH\",\"value\":\"$RELAY_AUTH\",\"type\":\"encrypted\",\"target\":[\"production\"]}"
  # stable production alias (not the per-deployment hash URL)
  local alias; alias=$(curl -s -m 30 -H "Authorization: Bearer $T" "https://api.vercel.com/v9/projects/$NAME" | python3 -I -c 'import sys,json; d=json.load(sys.stdin); a=((d.get("targets") or {}).get("production") or {}).get("alias") or []; print(a[0] if a else "")' 2>/dev/null)
  echo "$acct|$url|$alias" > "$d/result.txt"
}
for a in $ACCOUNTS; do deploy_one "$a" & done
wait
printf '%-16s %-8s %s\n' ACCOUNT STATUS "STABLE-ALIAS / URL-HOST"
for a in $ACCOUNTS; do
  IFS='|' read -r acct url alias < "$WORK/$a/result.txt" 2>/dev/null || { printf '%-16s %-8s %s\n' "$a" FAILED "no result"; continue; }
  if [ -z "$url" ]; then printf '%-16s %-8s %s\n' "$a" FAILED "$(sed -E 's/vcp_[A-Za-z0-9_-]+/vcp_<hidden>/g' $WORK/$a/err.txt | grep -i -E 'error' | head -1 | cut -c1-120)"; else printf '%-16s %-8s %s\n' "$a" deployed "${alias:-${url#https://}}"; fi
done
# write relays.json (mode 640 root:ocv2 later); only accounts that deployed AND have a host
python3 -I - "$WORK" "$RELAY_AUTH" "$OUT.new" $ACCOUNTS <<'PY'
import sys, json, os
work, key, out = sys.argv[1], sys.argv[2], sys.argv[3]
rows = []
for a in sys.argv[4:]:
    p = os.path.join(work, a, 'result.txt')
    if not os.path.exists(p): continue
    acct, url, alias = (open(p).read().strip().split('|') + ['', '', ''])[:3]
    host = alias or (url.replace('https://', '') if url else '')
    if host: rows.append({"name": acct, "url": "wss://%s/api/ws" % host, "key": key})
json.dump(rows, open(out, 'w'), indent=1)
os.chmod(out, 0o600)
print("relays.json.new entries:", len(rows))
PY
rm -rf "$WORK"
