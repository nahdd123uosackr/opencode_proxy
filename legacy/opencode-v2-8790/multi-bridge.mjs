// Local CONNECT proxy that tunnels CONNECT opencode.ai:443 through one of several WebSocket relays.
// - picks relays round-robin; a relay that fails to open is put on a cooldown and the next one is tried
// - listens on 127.0.0.1 only; refuses any host other than opencode.ai / models.opencode.ai
// Config via env: RELAYS_FILE (JSON: [{"name":"..","url":"wss://../api/ws","key":".."}]) and PORT.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 18790);
const FILE = process.env.RELAYS_FILE;
const ALLOWED = /^(models\.)?opencode\.ai$/;
const OPEN_TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT_MS || 8000);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 60000);
const note = (m) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 23), m);

function loadRelays() {
  const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return list.map((r, i) => ({ ...r, i, coolUntil: 0, opens: 0, fails: 0 }));
}
let relays = loadRelays();
let rr = 0;
const stats = { connects: 0, denied: 0, failedAll: 0 };

function candidates() {
  const now = Date.now();
  const n = relays.length;
  const order = [];
  for (let k = 0; k < n; k++) order.push(relays[(rr + k) % n]);
  rr = (rr + 1) % n;
  const ready = order.filter((r) => r.coolUntil <= now);
  return ready.length ? ready : order; // if everything is cooling down, try anyway
}

function openOne(relay, host) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${relay.url}?h=${host}&k=${encodeURIComponent(relay.key)}`);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('open timeout')); }, OPEN_TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
    ws.onclose = (e) => { clearTimeout(timer); reject(new Error('closed before open ' + e.code)); };
  });
}

async function openAny(host) {
  const tried = [];
  for (const r of candidates()) {
    const t0 = Date.now();
    try {
      const ws = await openOne(r, host);
      r.opens++;
      return { ws, relay: r, ms: Date.now() - t0, tried };
    } catch (e) {
      r.fails++; r.coolUntil = Date.now() + COOLDOWN_MS;
      tried.push(`${r.name}:${e.message}`);
    }
  }
  return { ws: null, tried };
}

const srv = http.createServer((req, res) => {
  if (req.url === '/_stats') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...stats, relays: relays.map((r) => ({ name: r.name, opens: r.opens, fails: r.fails, cooling: Math.max(0, r.coolUntil - Date.now()) })) }));
    return;
  }
  res.writeHead(405); res.end();
});

srv.on('connect', async (req, client, head) => {
  const [host, port] = req.url.split(':');
  if (!ALLOWED.test(host) || port !== '443') { stats.denied++; note(`DENY ${req.url}`); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  stats.connects++;
  client.on('error', () => {});
  const t0 = Date.now();
  const got = await openAny(host);
  if (!got.ws) { stats.failedAll++; note(`FAIL all relays for ${host}: ${got.tried.join(' | ')}`); client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
  const { ws, relay } = got;
  let up = 0, down = 0;
  note(`OPEN  ${host} via ${relay.name} ${got.ms}ms${got.tried.length ? ' (skipped: ' + got.tried.join(' | ') + ')' : ''}`);
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head.length) { ws.send(head); up += head.length; }
  client.on('data', (d) => { up += d.length; if (ws.readyState === 1) ws.send(d); });
  ws.onmessage = (e) => { const b = Buffer.from(e.data); down += b.length; client.write(b); };
  ws.onclose = (e) => { note(`CLOSE ${host} via ${relay.name} code=${e.code} up=${up}B down=${down}B ${Date.now() - t0}ms`); client.destroy(); };
  ws.onerror = () => {};
  client.on('close', () => { try { ws.close(); } catch {} });
});

process.on('SIGHUP', () => { try { relays = loadRelays(); note(`reloaded ${relays.length} relays`); } catch (e) { note('reload failed: ' + e.message); } });
srv.listen(PORT, '127.0.0.1', () => note(`multi-bridge up on 127.0.0.1:${PORT} with ${relays.length} relays: ${relays.map((r) => r.name).join(', ')}`));
