#!/usr/bin/env python3
"""Probe every free model exposed by the Convex free-AI gateway."""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request
import urllib.error

BASE = "https://amiable-quail-167.ap-southeast-2.convex.site"
KEY = open("/root/workspace/convex_key.txt").read().strip()
MODELS_FILE = "/tmp/free_models.json"
OUT_FILE = "/root/convex-free-ai/test-results.json"
CONCURRENCY = int(os.environ.get("CONCURRENCY", "8"))
TIMEOUT = int(os.environ.get("TIMEOUT", "50"))
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "8"))


def classify(model_id: str) -> str:
    m = model_id.lower()
    if "embed" in m:
        return "embed"
    if "rerank" in m:
        return "rerank"
    if any(k in m for k in ("flux", "dall", "sdxl", "banana", "image", "imagine", "t2v", "i2v")):
        return "image"
    if any(k in m for k in ("tts", "voice", "speech", "asr", "whisper", "audio")):
        return "audio"
    return "chat"


def post(path: str, payload: dict, timeout: int) -> tuple[int, str, float]:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=body,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            text = res.read(4000).decode("utf-8", "replace")
            return res.status, text, time.time() - started
    except urllib.error.HTTPError as e:
        text = e.read(4000).decode("utf-8", "replace")
        return e.code, text, time.time() - started
    except Exception as e:  # timeout / connection reset
        return 0, f"{type(e).__name__}: {e}", time.time() - started


def probe(model_id: str) -> dict:
    kind = classify(model_id)
    if kind in ("image", "audio", "rerank"):
        return {"id": model_id, "kind": kind, "status": "unsupported", "ms": 0, "detail": "endpoint not implemented"}
    if kind == "embed":
        status, text, ms = post("/v1/embeddings", {"model": model_id, "input": "ping"}, TIMEOUT)
        ok_body = '"embedding"' in text
        return {"id": model_id, "kind": kind, "status": "ok" if status == 200 and ok_body else status, "ms": round(ms), "detail": text[:250]}
    status, text, ms = post(
        "/v1/chat/completions",
        {"model": model_id, "messages": [{"role": "user", "content": "Reply with: OK"}], "max_tokens": MAX_TOKENS},
        TIMEOUT,
    )
    return {"id": model_id, "kind": kind, "status": status, "ms": round(ms), "detail": text[:250]}


def main() -> None:
    models = [m["id"] for m in json.load(open(MODELS_FILE))["data"]]
    print(f"probing {len(models)} models (concurrency={CONCURRENCY}, timeout={TIMEOUT}s)", flush=True)
    results = []
    started = time.time()
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(probe, m): m for m in models}
        done = 0
        for fut in as_completed(futures):
            results.append(fut.result())
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(models)} ({time.time()-started:.0f}s)", flush=True)
    results.sort(key=lambda r: (str(r["kind"]), str(r["status"]), r["id"]))
    payload = {"base": BASE, "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "total": len(results), "elapsedSec": round(time.time() - started), "results": results}
    json.dump(payload, open(OUT_FILE, "w"), indent=2, ensure_ascii=False)
    print(f"done in {payload['elapsedSec']}s -> {OUT_FILE}", flush=True)


if __name__ == "__main__":
    sys.exit(main())