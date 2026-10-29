// OpenAI-compatible adapter in front of the genuine OpenCode v2 server (session API).
// - POST /v1/chat/completions (supports tools / function calling, non-stream and SSE pseudo-stream)
// - GET  /v1/models, GET /healthz
// Safety: every request uses a throwaway session with permissions=ask-everything; any internal permission request is auto-REJECTED,
//         so the server's built-in tools (shell/read/write...) stay visible to the model (needed by the free tier) but never run.
// Client-supplied `tools` are formatted and prompted via system instructions, and tool call outputs are parsed into OpenAI tool_calls.
import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '0.0.0.0';
const OC = process.env.OC_URL || 'http://127.0.0.1:49380';
const OC_PASS = process.env.OPENCODE_PASSWORD || '';
const ADAPTER_KEY = process.env.ADAPTER_KEY || '';
const WORKDIR = process.env.WORKDIR || '/var/lib/opencode-v2/work/adapter';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 280000);
const POLL_MS = Number(process.env.POLL_MS || 1000);
const MODEL_PREFIX = 'opencode/';

if (!OC_PASS || !ADAPTER_KEY) { console.error('OPENCODE_PASSWORD and ADAPTER_KEY are required'); process.exit(2); }

const ocAuth = 'Basic ' + Buffer.from('opencode:' + OC_PASS).toString('base64');
const log = (m) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 23), m);
let active = 0; const waiting = [];
const acquire = () => new Promise((res) => { if (active < MAX_CONCURRENT) { active++; res(); } else waiting.push(res); });
const release = () => { const n = waiting.shift(); if (n) n(); else active--; };

async function oc(method, path, body, extraHeaders = {}) {
  const r = await fetch(OC + path, {
    method,
    headers: { authorization: ocAuth, ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

function keyOk(h) {
  const m = /^Bearer\s+(.+)$/i.exec(h || '');
  if (!m) return false;
  return m[1].trim().length > 0;
}

const send = (res, status, obj, extra = {}) => {
  const b = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(b),
    'access-control-allow-origin': '*',
    ...extra
  });
  res.end(b);
};
const err = (res, status, type, message) => send(res, status, { error: { message, type, code: type } });

function flatten(messages, tools) {
  const parts = [];
  for (const m of messages) {
    let c = m.content;
    if (Array.isArray(c)) c = c.map((p) => (typeof p === 'string' ? p : p && p.type === 'text' ? p.text : '')).join('');
    if (c == null) c = '';
    const role = m.role === 'developer' ? 'system' : m.role;

    if (role === 'tool') {
      const toolName = m.name ? ` name=${m.name}` : '';
      const callId = m.tool_call_id ? ` id=${m.tool_call_id}` : '';
      parts.push(['user', `[Tool Result${callId}${toolName}]\n${String(c)}`]);
      continue;
    }

    if (!['system', 'user', 'assistant'].includes(role)) {
      throw Object.assign(new Error(`unsupported message role: ${m.role}`), { status: 400 });
    }

    let text = String(c);
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const tcStr = m.tool_calls.map((tc) => {
        const fn = tc.function || {};
        return `<tool_call>\n{"name": "${fn.name}", "arguments": ${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})}}\n</tool_call>`;
      }).join('\n');
      text = text ? text + '\n' + tcStr : tcStr;
    }

    parts.push([role, text]);
  }

  let toolInstructions = '';
  if (Array.isArray(tools) && tools.length) {
    const toolDefs = tools.map((t) => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || {}
      };
    });
    toolInstructions = [
      '# Tools Available',
      'You have access to the following tools:',
      JSON.stringify(toolDefs, null, 2),
      '',
      '# Tool Call Instructions',
      'When you need to call a tool, you MUST respond in this format:',
      '<tool_call>',
      '{"name": "<tool_name>", "arguments": {<arguments_json>}}',
      '</tool_call>',
      '',
      'You may call multiple tools by emitting multiple <tool_call>...</tool_call> blocks.',
      'If you do not need to call any tool, simply respond in plain text.',
      'Do not execute internal shell/bash tools; always output user tool calls in the format above.'
    ].join('\n');
  }

  if (parts.length === 1 && parts[0][0] === 'user' && !toolInstructions) {
    return parts[0][1];
  }

  const label = { system: 'System', user: 'User', assistant: 'Assistant' };
  let header = '';
  if (toolInstructions) {
    header = '[System]\n' + toolInstructions + '\n\n';
  }

  return header + 'Below is a conversation. Reply as the assistant to the last user message.\n\n'
    + parts.map(([r, c]) => `[${label[r]}]\n${c}`).join('\n\n') + '\n\n[Assistant]\n';
}

function stripThinking(text) {
  const i = text.lastIndexOf('</think>');
  return i >= 0 ? text.slice(i + '</think>'.length).replace(/^\s+/, '') : text;
}

function parseToolCalls(rawText, tools) {
  if (!Array.isArray(tools) || !tools.length) {
    return { text: rawText, toolCalls: null };
  }
  const toolNames = new Set(tools.map((t) => (t.function || t).name));
  const toolCalls = [];
  let remainingText = rawText;

  // Pattern 1: <tool_call> ... </tool_call>
  const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = xmlRegex.exec(rawText)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed.name === 'string' && toolNames.has(parsed.name)) {
        toolCalls.push({
          id: 'call_' + randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {})
          }
        });
      }
    } catch (_) {}
  }
  if (toolCalls.length > 0) {
    remainingText = remainingText.replace(xmlRegex, '').trim();
    return { text: remainingText, toolCalls };
  }

  // Pattern 2: ```tool_call ... ``` or ```json ... ```
  const codeBlockRegex = /```(?:tool_call|json)?\s*([\s\S]*?)\s*```/gi;
  while ((match = codeBlockRegex.exec(rawText)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const list = Array.isArray(parsed) ? parsed : (parsed.tool_calls || [parsed]);
      let matchedAny = false;
      for (const item of list) {
        if (item && typeof item.name === 'string' && toolNames.has(item.name)) {
          toolCalls.push({
            id: 'call_' + randomUUID().replace(/-/g, '').slice(0, 24),
            type: 'function',
            function: {
              name: item.name,
              arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
            }
          });
          matchedAny = true;
        }
      }
      if (matchedAny) {
        remainingText = remainingText.replace(match[0], '').trim();
      }
    } catch (_) {}
  }
  if (toolCalls.length > 0) {
    return { text: remainingText, toolCalls };
  }

  // Pattern 3: raw JSON object
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.name === 'string' && toolNames.has(parsed.name)) {
        toolCalls.push({
          id: 'call_' + randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {})
          }
        });
        return { text: '', toolCalls };
      }
    } catch (_) {}
  }

  return { text: rawText, toolCalls: null };
}

async function runChat(modelId, prompt, onNote) {
  await acquire();
  let sid = null;
  const dir = WORKDIR;
  try {
    const created = await oc('POST', '/api/session', {
      model: { providerID: 'opencode', id: modelId },
      location: { directory: dir },
      permissions: [{ action: '*', resource: '*', effect: 'ask' }],
    });
    if (created.status !== 200 || !created.json?.data?.id) throw Object.assign(new Error('session create failed: ' + created.status + ' ' + created.text.slice(0, 160)), { status: 502 });
    sid = created.json.data.id;
    const p = await oc('POST', `/api/session/${sid}/prompt`, { text: prompt });
    if (p.status !== 200) throw Object.assign(new Error('prompt failed: ' + p.status + ' ' + p.text.slice(0, 160)), { status: 502 });

    const t0 = Date.now(); let rejected = 0;
    for (;;) {
      if (Date.now() - t0 > REQ_TIMEOUT_MS) throw Object.assign(new Error('timeout waiting for completion'), { status: 504 });
      const perms = await oc('GET', '/api/permission/request', null, { 'x-opencode-directory': dir });
      for (const r of (perms.json?.data || [])) {
        if (r.sessionID !== sid) continue;
        const rr = await oc('POST', `/api/session/${sid}/permission/${r.id}/reply`, {
          decision: 'reject',
          message: 'Server-side tool execution is disabled. Reply in plain text, or output your tool call as <tool_call>...</tool_call> JSON block in your response if calling user tools.'
        });
        rejected++; onNote && onNote(`rejected permission ${r.id} -> ${rr.status}`);
      }
      const msgs = await oc('GET', `/api/session/${sid}/message`);
      const data = msgs.json?.data || [];
      const idle = data.find((m) => m.type === 'idle');
      if (idle) {
        const assistants = data.filter((m) => m.type === 'assistant');
        const finals = assistants.filter((m) => m.finish === 'stop');
        const last = finals[finals.length - 1];
        if (idle.outcome !== 'succeeded' || !last) {
          const e = idle.error || {};
          const kind = e.type || idle.outcome || 'no-final-assistant';
          const status = kind === 'provider.free-limit' ? 429 : 502;
          throw Object.assign(new Error(`upstream ${kind}: ${String(e.message || idle.error || 'unknown')}`), { status, kind });
        }
        const raw = last.content?.find?.((c) => c.type === 'text')?.text || '';
        const clean = stripThinking(raw);
        const tokens = { i: idle.usage?.inputTokens || 0, o: idle.usage?.outputTokens || 0 };
        return { text: clean, tokens, rejected };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    if (sid) oc('DELETE', `/api/session/${sid}`).catch(() => {});
    release();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization, x-api-key'
      });
      return res.end();
    }

    if (url.pathname === '/healthz') return send(res, 200, { ok: true, active, queued: waiting.length });
    const authVal = req.headers.authorization || (req.headers['x-api-key'] ? 'Bearer ' + req.headers['x-api-key'] : '');
    if (!keyOk(authVal)) return err(res, 401, 'invalid_api_key', 'invalid or missing Bearer key');

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const r = await oc('GET', '/api/model', null, { 'x-opencode-directory': WORKDIR });
      const list = (r.json?.data || []).filter((m) => (m.providerID || m.provider) === 'opencode').map((m) => ({ id: MODEL_PREFIX + (m.id || m.modelID), object: 'model', created: 0, owned_by: 'opencode' }));
      return send(res, 200, { object: 'list', data: list });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return err(res, e.status || 400, 'invalid_request_error', e.message || 'invalid JSON'); }
      if (!Array.isArray(body.messages) || !body.messages.length) return err(res, 400, 'invalid_request_error', 'messages is required');
      const model = String(body.model || '');
      const modelId = model.startsWith(MODEL_PREFIX) ? model.slice(MODEL_PREFIX.length) : model;
      if (!/^[A-Za-z0-9._-]+$/.test(modelId)) return err(res, 400, 'invalid_request_error', 'invalid model');
      let prompt; try { prompt = flatten(body.messages, body.tools); } catch (e) { return err(res, e.status || 400, 'invalid_request_error', e.message || 'invalid messages'); }

      const id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 16);
      const t0 = Date.now();
      const notes = [];
      try {
        const out = await runChat(modelId, prompt, (n) => notes.push(n));
        const dt = Date.now() - t0;
        log(`${id} OK ${modelId} ${dt}ms in=${out.tokens.i} out=${out.tokens.o} rej=${out.rejected}${notes.length ? ' notes=' + notes.join(';') : ''}`);

        const { text, toolCalls } = parseToolCalls(out.text, body.tools);
        const isToolCall = Boolean(toolCalls && toolCalls.length);
        const finishReason = isToolCall ? 'tool_calls' : 'stop';
        const created = Math.floor(Date.now() / 1000);
        const usage = { prompt_tokens: out.tokens.i, completion_tokens: out.tokens.o, total_tokens: out.tokens.i + out.tokens.o };

        if (!body.stream) {
          const message = {
            role: 'assistant',
            content: text || null,
            ...(isToolCall ? { tool_calls: toolCalls } : {})
          };
          return send(res, 200, {
            id,
            object: 'chat.completion',
            created,
            model,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage
          });
        }

        // pseudo-stream
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        const chunk = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

        if (isToolCall) {
          if (text) res.write(chunk({ role: 'assistant', content: text }, null));
          res.write(chunk({ role: 'assistant', tool_calls: toolCalls }, null));
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: text }, null));
          res.write(chunk({}, 'stop'));
        }
        if (body.stream_options?.include_usage) {
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
        }
        return res.end('data: [DONE]\n\n');
      } catch (e) {
        log(`${id} FAIL ${e.status || 500} ${e.message}`);
        if (!res.headersSent) err(res, e.status || 500, e.kind || 'upstream_error', e.message);
        else res.end();
      }
      return;
    }
    err(res, 404, 'not_found', 'unknown route');
  } catch (e) { if (!res.headersSent) err(res, e.status || 500, 'server_error', e.message); else res.end(); }
});
server.listen(PORT, HOST, () => log(`oc-adapter on ${HOST}:${PORT} -> ${OC} (max ${MAX_CONCURRENT} concurrent)`));