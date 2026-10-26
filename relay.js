'use strict';
// WebSocket -> TCP relay for container nodes (Northflank etc.). Fixed to opencode.ai:443 / models.opencode.ai:443.
// Only opaque bytes are forwarded: TLS stays end-to-end between the client and opencode.ai, so this process
// never sees plaintext. Fail-closed: without RELAY_AUTH every request is refused.
//
//   WebSocket:  wss://<host>/api/ws?h=<opencode.ai|models.opencode.ai>&k=<RELAY_AUTH>
//   Health:     GET https://<host>/api/ws?health=1&k=<RELAY_AUTH>
const net = require('net');
const { timingSafeEqual } = require('crypto');

let WebSocketServer = null;
try { ({ WebSocketServer } = require('ws')); } catch (_) { /* relay disabled, rest of the server unaffected */ }

const ALLOWED = /^(models\.)?opencode\.ai$/;

function keyOk(given) {
  const want = process.env.RELAY_AUTH || '';
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parse(req) {
  try { return new URL(req.url, 'http://x'); } catch (_) { return null; }
}

// Plain HTTP: only the authenticated health probe is answered. Returns true when the request was handled.
function handleHttp(req, res) {
  const u = parse(req);
  if (!u || u.pathname !== '/api/ws') return false;
  if (u.searchParams.get('health') === '1' && keyOk(u.searchParams.get('k'))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, relay: Boolean(WebSocketServer), node: process.version }));
    return true;
  }
  res.writeHead(404); res.end();
  return true;
}

function bridge(ws, host) {
  const tcp = net.connect({ host, port: 443 });
  tcp.setNoDelay(true);
  let up = false;
  const pending = [];
  tcp.on('connect', () => { up = true; for (const b of pending) tcp.write(b); pending.length = 0; });
  tcp.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
  tcp.on('error', () => { try { ws.close(1011, 'tcp error'); } catch (_) {} });
  tcp.on('close', () => { try { ws.close(); } catch (_) {} });
  ws.on('message', (data) => { const b = Buffer.isBuffer(data) ? data : Buffer.from(data); up ? tcp.write(b) : pending.push(b); });
  ws.on('close', () => tcp.destroy());
  ws.on('error', () => tcp.destroy());
}

function attach(server) {
  if (!WebSocketServer) { console.log('[relay] "ws" module not installed; WebSocket relay disabled'); return; }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const u = parse(req);
    const host = u && u.searchParams.get('h');
    const ok = u && u.pathname === '/api/ws' && keyOk(u.searchParams.get('k')) && ALLOWED.test(host || '');
    if (!ok) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, host));
  });
  console.log(`[relay] WebSocket relay enabled at /api/ws (auth ${process.env.RELAY_AUTH ? 'configured' : 'NOT configured -> all requests refused'})`);
}

module.exports = { attach, handleHttp };
