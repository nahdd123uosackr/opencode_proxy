#!/usr/bin/env bash
# covex 12개 노드의 bearer 키 발급/만료 상태를 조회한다.
# 사용: bash /root/convex-free-ai/scripts/check_covex_keys.sh
# 기록: /alist/s3/obsidian/llm-wiki/Sources/covex-key-issue-expiry-tracker.md
set -uo pipefail

SYNC=/root/workspace/convex_key_sync.txt
[ -r "$SYNC" ] || { echo "missing $SYNC"; exit 1; }
SEC=$(cat "$SYNC")

NODES=(
  precise-pony-340 spotted-owl-715 dashing-leopard-797 kindred-kudu-493
  healthy-toucan-120 frugal-firefly-315 ceaseless-marten-132
  graceful-goat-453 determined-caribou-248 tame-cuttlefish-135
  aromatic-cuttlefish-137 tacit-fennec-438
)

# 2026-11-10 00:09 UTC 발급 시점의 접두 (로테이션 감지 기준)
declare -A BASELINE=(
  [precise-pony-340]=fk_43dc5f1f7 [spotted-owl-715]=fk_ee50be8a2
  [dashing-leopard-797]=fk_8c6f06d72 [kindred-kudu-493]=fk_2500dbc3c
  [healthy-toucan-120]=fk_b9c1e864d [frugal-firefly-315]=fk_198e4eab8
  [ceaseless-marten-132]=fk_243289de8 [graceful-goat-453]=fk_26c4b4147
  [determined-caribou-248]=fk_a152a6010 [tame-cuttlefish-135]=fk_7802a06ab
  [aromatic-cuttlefish-137]=fk_3a45b41ec [tacit-fennec-438]=fk_67152acf1
)

printf '%-24s %-14s %-22s %-9s %s\n' NODE KEY EXPIRES ROTATES VERDICT
for n in "${NODES[@]}"; do
  res=$(curl -s -m 25 -H "x-key-sync-secret: $SEC" "https://$n.convex.site/key")
  key=$(echo "$res" | jq -r '.key // empty')
  exp=$(echo "$res" | jq -r 'if .expiresAt then (.expiresAt/1000|todate) else "-" end')
  rot=$(echo "$res" | jq -r 'if .rotatesInMs then (((.rotatesInMs/86400000)*10|floor)/10|tostring)+"d" else "-" end')
  cnt=$(echo "$res" | jq -r '.activeCount // "-"')
  prefix=${key:0:12}
  if [ -z "$key" ]; then verdict="NO_KEY"
  elif [ "$prefix" = "${BASELINE[$n]}" ]; then verdict="unchanged (active=$cnt)"
  else verdict="ROTATED (active=$cnt)"; fi
  printf '%-24s %-14s %-22s %-9s %s\n' "$n" "$prefix" "$exp" "$rot" "$verdict"
done
