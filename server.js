'use strict';
const http = require('http');
const handler = require('./api/index.js');
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = process.env.UPSTREAM || 'https://opencode.ai/zen/v1';

http.createServer((req, res) => {
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
