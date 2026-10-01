"""server.js(Node 프록시)를 자식 프로세스로 띄우고, Streamlit 포트로 들어온 API 경로를 그대로 넘겨주는 브리지."""
from __future__ import annotations

import asyncio
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

ROOT = Path(__file__).resolve().parent
PREFIXES = ("v1", "res", "chat", "mes", "kilo", "uncloseai", "dahl")
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
SKIP_REQUEST = {"host", "content-length", "accept-encoding", "connection", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer"}
SKIP_RESPONSE = {"content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer"}
MIN_NODE_MAJOR = 18
READY_TIMEOUT_S = 30


def _node_major(path: str) -> int:
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        return int(out.lstrip("v").split(".")[0])
    except Exception:
        return 0


def find_node() -> str:
    candidates = [shutil.which("node")]
    try:
        import nodejs_wheel.executable as ex
        candidates.append(str(Path(ex.ROOT_DIR) / "bin" / "node"))
    except Exception:
        pass
    for c in candidates:
        if c and os.path.exists(c) and _node_major(c) >= MIN_NODE_MAJOR:
            return c
    raise RuntimeError(f"Node.js >= {MIN_NODE_MAJOR} not found (checked: {[c for c in candidates if c]})")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class NodeBackend:
    def __init__(self) -> None:
        self.proc: asyncio.subprocess.Process | None = None
        self.port: int | None = None
        self.client: httpx.AsyncClient | None = None
        self.error: str | None = None

    async def start(self) -> None:
        try:
            node = find_node()
            self.port = _free_port()
            env = {**os.environ, "PORT": str(self.port), "HOST": "127.0.0.1", "PROVIDER": "streamlit"}
            self.proc = await asyncio.create_subprocess_exec(node, str(ROOT / "server.js"), cwd=str(ROOT), env=env)
            self.client = httpx.AsyncClient(
                timeout=httpx.Timeout(connect=5.0, read=None, write=60.0, pool=None),
                limits=httpx.Limits(max_connections=200),
            )
            await self._wait_ready()
            print(f"[bridge] node backend ready on 127.0.0.1:{self.port} ({node})", file=sys.stderr, flush=True)
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
            print(f"[bridge] backend start failed: {self.error}", file=sys.stderr, flush=True)

    async def _wait_ready(self) -> None:
        assert self.client and self.proc and self.port
        for _ in range(READY_TIMEOUT_S * 5):
            if self.proc.returncode is not None:
                raise RuntimeError(f"node exited early with code {self.proc.returncode}")
            try:
                r = await self.client.get(f"http://127.0.0.1:{self.port}/health", timeout=2.0)
                if r.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.2)
        raise RuntimeError("node backend did not become ready in time")

    async def stop(self) -> None:
        if self.client:
            await self.client.aclose()
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=12)
            except asyncio.TimeoutError:
                self.proc.kill()

    async def forward(self, request: Request) -> Response:
        if self.error or not self.client or not self.port:
            return JSONResponse({"error": {"message": f"backend unavailable: {self.error or 'not started'}"}}, status_code=503)
        if self.proc and self.proc.returncode is not None:
            return JSONResponse({"error": {"message": f"backend exited with code {self.proc.returncode}"}}, status_code=503)
        url = f"http://127.0.0.1:{self.port}{request.url.path}"
        if request.url.query:
            url += "?" + request.url.query
        headers = [(k, v) for k, v in request.headers.items() if k.lower() not in SKIP_REQUEST]
        req = self.client.build_request(request.method, url, headers=headers, content=await request.body())
        try:
            upstream = await self.client.send(req, stream=True)
        except httpx.HTTPError as e:
            return JSONResponse({"error": {"message": f"backend request failed: {type(e).__name__}: {e}"}}, status_code=502)
        out = {k: v for k, v in upstream.headers.items() if k.lower() not in SKIP_RESPONSE}

        async def body():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(body(), status_code=upstream.status_code, headers=out)


def make_routes(backend: NodeBackend) -> list[Route]:
    routes = [Route("/health", backend.forward, methods=["GET"]), Route("/ip", backend.forward, methods=["GET"])]
    routes += [Route(f"/{p}/{{path:path}}", backend.forward, methods=METHODS) for p in PREFIXES]
    return routes
