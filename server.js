'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// --- uTLS Bun BoringSSL Bridge Integration ---
let utlsChild = null;
const UTLS_PORT = process.env.UTLS_PORT || '18791';
const utlsCandidates = [
  path.join(__dirname, 'utls_bridge', 'utls_bridge'),
  path.join(__dirname, 'utls_bridge'),
  '/opt/opencode-proxy/utls_bridge',
  '/usr/local/bin/utls_bridge'
];

const utlsBin = utlsCandidates.find(p => {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (_) { return false; }
});

if (utlsBin && !process.env.DISABLE_UTLS) {
  try {
    utlsChild = spawn(utlsBin, ['-port', UTLS_PORT], {
      stdio: ['ignore', 'inherit', 'inherit']
    });
    console.log(`[uTLS] spawned Bun BoringSSL bridge (${utlsBin}) on port ${UTLS_PORT}`);
    process.env.UPSTREAM = `http://127.0.0.1:${UTLS_PORT}/inference/v1`;
    process.env.UTLS_BRIDGE_ACTIVE = '1';
  } catch (e) {
    console.error(`[uTLS] failed to spawn bridge: ${e.message}`);
  }
}

const handler = require('./api/index.js');
let relay = null;
try { relay = require('./relay.js'); } catch (_) {}
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = process.env.UPSTREAM || 'https://opencode.ai/inference/v1';

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // WebSocket relay health/guard (only /api/ws; everything else falls through)
  if (relay && relay.handleHttp && relay.handleHttp(req, res)) return;

  // Health check
  if (url === '/health' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      upstream: process.env.UPSTREAM || UPSTREAM,
      utls_bridge: Boolean(utlsChild),
      provider: process.env.PROVIDER || 'container'
    }));
  }

  // Egress IP Check endpoint
  if (url === '/ip') {
    return fetch('https://api.ipify.org?format=json')
      .then(r => r.json())
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ egress_ip: data.ip }));
      })
      .catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
  }

  Promise.resolve(handler(req, res)).catch(e => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  });
}).listen(PORT, HOST, () => {
  console.log(`opencode-proxy listening on ${HOST}:${PORT}, upstream=${process.env.UPSTREAM || UPSTREAM}`);
});

if (relay && relay.attach) relay.attach(server);

function gracefulShutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing server`);
  if (utlsChild && !utlsChild.killed) {
    try { utlsChild.kill('SIGTERM'); } catch (_) {}
  }
  server.close(() => {
    console.log('[shutdown] server closed cleanly, exiting');
    process.exit(0);
  });
  setTimeout(() => {
    console.log('[shutdown] force exit after grace period');
    if (utlsChild && !utlsChild.killed) {
      try { utlsChild.kill('SIGKILL'); } catch (_) {}
    }
    process.exit(0);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
