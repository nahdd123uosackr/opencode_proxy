'use strict';
const http = require('http');
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = process.env.UPSTREAM || 'https://opencode.ai/zen/v1';

// Cloudflare Worker export handler 호환 레이어
const cfHandler = require('./src/index.js');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', upstream: UPSTREAM, provider: 'orkestr-eu' }));
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }

      const request = new Request(url.toString(), {
        method: req.method,
        headers: headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        duplex: 'half'
      });

      const env = {
        UPSTREAM: UPSTREAM,
        ...process.env
      };

      const workerResponse = await cfHandler.default.fetch(request, env, {});

      res.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers.entries()));
      if (workerResponse.body) {
        const reader = workerResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    });
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`opencode-proxy listening on ${HOST}:${PORT}, upstream=${UPSTREAM}`);
});
