'use strict';
const http = require('http');
const handler = require('./api/index.js');
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = process.env.UPSTREAM || 'https://opencode.ai/zen/v1';

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Health check
  if (url === '/health' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', upstream: UPSTREAM, provider: process.env.PROVIDER || 'container' }));
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
  console.log(`opencode-proxy listening on ${HOST}:${PORT}, upstream=${UPSTREAM}`);
});

// 2026-09-11: server.js never kept a reference to the server, so the SIGTERM
// handler in api/index.js (shuttingDown=true only) had no way to actually
// close the server or exit the process -- the container/VM's orchestrator
// (systemd TimeoutStopSec, Docker stop grace period, etc.) would hang for its
// full grace window before force-killing. Same fix as the local systemd
// variant of server.js.
function gracefulShutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing server (in-flight requests get to finish)`);
  server.close(() => {
    console.log('[shutdown] server closed cleanly, exiting');
    process.exit(0);
  });
  setTimeout(() => {
    console.log('[shutdown] force exit after grace period');
    process.exit(0);
  }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
