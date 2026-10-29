// WebSocket -> TCP relay, fixed to opencode.ai:443 (and models.opencode.ai). Opaque bytes only: TLS stays end-to-end
// between the genuine client and opencode.ai, so this function never sees plaintext.
// Auth: shared secret in env RELAY_AUTH (the same variable name the redeploy script already sets on every node).
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const ALLOWED = /^(models\.)?opencode\.ai$/;

function keyOk(given) {
  const want = process.env.RELAY_AUTH || '';
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Non-upgrade requests: only an authenticated health probe answers. Sub-paths (e.g. /api/ws/health) are swallowed by the
// project's catch-all rewrite, so the probe lives on /api/ws itself: GET /api/ws?health=1&k=<RELAY_AUTH>.
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('health') === '1' && keyOk(u.searchParams.get('k'))) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, region: process.env.VERCEL_REGION || null, node: process.version }));
      return;
    }
  } catch {}
  res.statusCode = 404; res.end();
});
const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024 * 1024,
  verifyClient: (info, cb) => {
    let ok = false;
    try {
      const u = new URL(info.req.url, 'http://x');
      ok = keyOk(u.searchParams.get('k')) && ALLOWED.test(u.searchParams.get('h') || '');
    } catch {}
    cb(ok, ok ? 200 : 404, ok ? undefined : 'Not Found');
  },
});
wss.on('connection', (ws, req) => {
  const host = new URL(req.url, 'http://x').searchParams.get('h');
  const tcp = net.connect({ host, port: 443 });
  tcp.setNoDelay(true);
  let up = false; const pending = [];
  tcp.on('connect', () => { up = true; for (const b of pending) tcp.write(b); pending.length = 0; });
  tcp.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
  tcp.on('error', () => ws.close(1011, 'tcp error'));
  tcp.on('close', () => { try { ws.close(); } catch {} });
  ws.on('message', (data) => { const b = Buffer.isBuffer(data) ? data : Buffer.from(data); up ? tcp.write(b) : pending.push(b); });
  ws.on('close', () => tcp.destroy());
  ws.on('error', () => tcp.destroy());
});
export default server;
