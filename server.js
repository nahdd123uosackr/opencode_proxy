'use strict';
const http = require('http');
const handler = require('./api/index.js');
const PORT = parseInt(process.env.PORT || '8769', 10);
const HOST = process.env.HOST || '0.0.0.0';
http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch(e => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  });
}).listen(PORT, HOST, () => console.log(`opencode-proxy (serverless-format) listening on ${HOST}:${PORT}, upstream=${process.env.UPSTREAM || 'https://opencode.ai/zen/v1'}`));
