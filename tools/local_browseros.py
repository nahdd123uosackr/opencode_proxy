#!/usr/bin/env python3
"""
Local BrowserOS neo on-demand lifecycle manager.
- Launches Xvfb & BrowserOS neo on local machine
- Provides MCP endpoint at http://127.0.0.1:9010/mcp
- Automatically cleans up and shuts down processes upon exit
"""
import subprocess
import time
import os
import signal
import urllib.request
import json
import atexit

class LocalBrowserOS:
    def __init__(self, port=9010, display=":99"):
        self.port = port
        self.display = display
        self.profile = f"/tmp/browseros_ondemand_{port}"
        self.proc = None
        self.xvfb = None

    def start(self, timeout=15):
        # 1. Clean old remnants
        os.system(f"rm -rf {self.profile} && mkdir -p {self.profile}")
        
        # 2. Start Xvfb cleanly
        disp_num = self.display.replace(':', '')
        x11_sock = f"/tmp/.X11-unix/X{disp_num}"
        os.system(f"rm -f {x11_sock} /tmp/.X{disp_num}-lock 2>/dev/null || true")
        self.xvfb = subprocess.Popen(
            ['Xvfb', self.display, '-screen', '0', '1280x800x24', '-ac', '+extension', 'GLX', '+render', '-noreset'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid
        )
        for _ in range(40):
            if os.path.exists(x11_sock):
                break
            time.sleep(0.05)

        # 3. Launch browserclaw
        env = os.environ.copy()
        env['DISPLAY'] = self.display
        cmd = [
            '/usr/bin/browserclaw',
            '--no-sandbox',
            f'--user-data-dir={self.profile}',
            '--no-first-run',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            'about:blank'
        ]
        self.proc = subprocess.Popen(
            cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid
        )

        # 4. Wait for MCP readiness
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None:
                raise RuntimeError(f"BrowserOS exited prematurely with code {self.proc.returncode}")
            try:
                req = urllib.request.Request(
                    f'http://127.0.0.1:{self.port}/mcp',
                    data=json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}).encode(),
                    headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
                )
                with urllib.request.urlopen(req, timeout=1.5) as resp:
                    if resp.status == 200:
                        return True
            except Exception:
                pass
            time.sleep(0.3)

        self.stop()
        raise TimeoutError(f"BrowserOS MCP failed to ready on port {self.port} within {timeout}s")

    def stop(self):
        if self.proc:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
                self.proc.wait(timeout=2)
            except Exception:
                try: os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except Exception: pass
            self.proc = None

        if self.xvfb:
            try:
                os.killpg(os.getpgid(self.xvfb.pid), signal.SIGTERM)
                self.xvfb.wait(timeout=1)
            except Exception:
                try: os.killpg(os.getpgid(self.xvfb.pid), signal.SIGKILL)
                except Exception: pass
            self.xvfb = None

        # Clean profile and child processes
        os.system(f"pkill -9 -f 'user-data-dir={self.profile}' 2>/dev/null || true")
        os.system(f"rm -rf {self.profile} 2>/dev/null || true")

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()

if __name__ == "__main__":
    print("Testing on-demand Local BrowserOS lifecycle...")
    t0 = time.time()
    with LocalBrowserOS() as bos:
        start_dur = round(time.time() - t0, 2)
        print(f"🚀 BrowserOS neo started and MCP ready in {start_dur}s!")
        
        # Test MCP interaction
        req = urllib.request.Request(
            'http://127.0.0.1:9010/mcp',
            data=json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test-client","version":"1"}}}).encode(),
            headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            sid = resp.headers.get('mcp-session-id')
            print(f"🔗 MCP Session Established: {sid}")

        tools_req = urllib.request.Request(
            'http://127.0.0.1:9010/mcp',
            data=json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/list"}).encode(),
            headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sid}
        )
        with urllib.request.urlopen(tools_req, timeout=3) as resp:
            data = resp.read().decode('utf-8', 'ignore')
            tools_cnt = data.count('"name":')
            print(f"🛠️ Tools Retrieved via MCP: {tools_cnt} tools active")

    total_dur = round(time.time() - t0, 2)
    print(f"🛑 BrowserOS neo cleanly terminated and resources released (total {total_dur}s).")
