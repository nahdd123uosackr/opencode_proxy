#!/usr/bin/env python3
"""
quota-monitor.py
Periodically tests the OpenCode adapter (which rotates across Vercel WS relays)
vs. direct execution (local and oracle1) to detect the exact moment free-tier quota is exhausted,
and measures whether each egress has an independent quota bucket.
"""
import time
import json
import urllib.request
import urllib.error
import subprocess
import os

LOG_FILE = "/var/log/opencode-quota-monitor.log"
STATE_FILE = "/opt/opencode-v2/quota-state.json"

def get_adapter_key():
    with open("/etc/opencode-adapter.env") as f:
        for line in f:
            if line.startswith("ADAPTER_KEY="):
                return line.strip().split("=", 1)[1].strip('"\'')
    return ""

def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    entry = f"[{ts} UTC] {msg}"
    print(entry)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(entry + "\n")
    except Exception:
        pass

def probe_adapter(key):
    url = "http://127.0.0.1:8790/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json"
    }
    data = json.dumps({
        "model": "opencode/big-pickle",
        "messages": [{"role": "user", "content": "Reply OK"}]
    }).encode("utf-8")
    
    req = urllib.request.Request(url, data=data, headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            elapsed = time.time() - t0
            body = json.loads(res.read().decode())
            text = body.get("choices", [{}])[0].get("message", {}).get("content", "")
            return {"status": res.status, "elapsed": round(elapsed, 2), "text": text.strip()}
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        err_body = e.read().decode("utf-8", "replace")
        return {"status": e.code, "elapsed": round(elapsed, 2), "error": err_body[:200]}
    except Exception as e:
        elapsed = time.time() - t0
        return {"status": 0, "elapsed": round(elapsed, 2), "error": str(e)[:100]}

def probe_bridge_stats():
    try:
        with urllib.request.urlopen("http://127.0.0.1:18790/_stats", timeout=5) as res:
            return json.loads(res.read().decode())
    except Exception as e:
        return {"error": str(e)}

def run_once():
    key = get_adapter_key()
    res = probe_adapter(key)
    stats = probe_bridge_stats()
    
    status_str = f"status={res['status']} ({res['elapsed']}s)"
    if res['status'] == 200:
        status_str += f" ok='{res.get('text', '')}'"
    else:
        status_str += f" err={res.get('error', '')}"
        
    connects = stats.get('connects', '?')
    log(f"PROBE ADAPTER -> {status_str} | bridge_connects={connects}")
    
    state = {
        "last_probe": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "status": res['status'],
        "details": res,
        "bridge_stats": stats
    }
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass

if __name__ == "__main__":
    run_once()
