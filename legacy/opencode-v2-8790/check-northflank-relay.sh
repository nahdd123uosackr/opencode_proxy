#!/bin/bash
# Verifies the Northflank WS relay without printing the shared secret.
#   check-northflank-relay.sh          -> health + WebSocket end-to-end test only
#   check-northflank-relay.sh --add    -> if the test passes, also add the node to /opt/opencode-v2/relays.json and reload the bridge
set -u
U=https://p01--opencode-proxy--vrjr6d2bxlz4.code.run
K=$(grep -E '^RELAY_AUTH=' /root/opencode_proxy_redeploy.sh | head -1 | cut -d= -f2- | tr -d "\"'")
[ -z "$K" ] && { echo "RELAY_AUTH not found in the redeploy script"; exit 2; }

echo "1) health (authenticated)"
code=$(curl -s -m 20 -o /tmp/nfh.json -w '%{http_code}' "$U/api/ws?health=1&k=$K")
echo "   http=$code $(head -c 100 /tmp/nfh.json)"; rm -f /tmp/nfh.json
if [ "$code" != "200" ]; then
  echo "   -> relay is CLOSED. RELAY_AUTH is not set (or not yet applied) in the Northflank service's Runtime variables."
  exit 1
fi

echo "2) WebSocket upgrade + TLS end-to-end through a temporary bridge"
T=$(mktemp -d /tmp/nf-check.XXXXXX); chmod 700 $T
printf '[{"name":"northflank","url":"wss://%s/api/ws","key":"%s"}]' "${U#https://}" "$K" > $T/r.json; chmod 600 $T/r.json
( RELAYS_FILE=$T/r.json PORT=18895 OPEN_TIMEOUT_MS=15000 setsid node /opt/opencode-v2/multi-bridge.mjs > $T/b.log 2>&1 & ); sleep 1.2
BP=$(ss -ltnp | grep ':18895 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
ok=0
for i in 1 2 3; do
  r=$(curl -s -m 40 --proxy http://127.0.0.1:18895 -o /dev/null -H 'Connection: close' -w 'http=%{http_code} verify=%{ssl_verify_result}' https://opencode.ai/inference/v1/models)
  echo "   req$i: $r"; case "$r" in *http=200*verify=0*) ok=$((ok+1));; esac
done
cut -c1-120 $T/b.log | grep -E 'OPEN|CLOSE|FAIL' | tail -3 | sed 's/^/   bridge: /'
[ -n "$BP" ] && case "$(tr '\0' ' ' < /proc/$BP/cmdline)" in *multi-bridge.mjs*) kill $BP;; esac
rm -rf $T
echo "   passed $ok/3"
[ "$ok" -lt 3 ] && { echo "   -> relay answers health but the WebSocket path does not work end-to-end (gateway may not pass WS upgrades)."; exit 1; }

if [ "${1:-}" = "--add" ]; then
  python3 -I - "$K" "${U#https://}" <<'PY'
import json, sys, os, shutil, time
key, host = sys.argv[1], sys.argv[2]
p = '/opt/opencode-v2/relays.json'
rows = json.load(open(p))
if any(r.get('name') == 'northflank' for r in rows):
    print('   relays.json already has northflank; leaving it unchanged')
else:
    shutil.copy2(p, p + '.bak-%d' % int(time.time()))
    rows.append({'name': 'northflank', 'url': 'wss://%s/api/ws' % host, 'key': key})
    json.dump(rows, open(p, 'w'), indent=1)
    os.chmod(p, 0o640)
    shutil.chown(p, 'root', 'ocv2')
    print('   added northflank to relays.json (now %d relays)' % len(rows))
PY
  systemctl reload-or-restart opencode-relay-bridge.service 2>/dev/null || systemctl restart opencode-relay-bridge.service
  sleep 2
  echo "   bridge: $(systemctl is-active opencode-relay-bridge.service); $(curl -s -m 5 http://127.0.0.1:18790/_stats | python3 -I -c 'import sys,json; d=json.load(sys.stdin); print(len(d["relays"]), "relays:", ",".join(r["name"] for r in d["relays"]))')"
fi
echo "OK"
