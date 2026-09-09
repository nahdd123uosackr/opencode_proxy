export const handleRequest = async 'use strict';

const UPSTREAM = 'https://opencode.ai/zen/v1';
const PROXY_API_KEY = ''; // set via wrangler secret PROXY_API_KEY if needed

const KNOWN_FREE_EXTRA = new Set(['big-pickle', 'grok-code']);
const VARIANT_MAP = {
  'hy3-free': ['low', 'medium', 'high'],
  'muse-spark-1.2-contributor-free': ['minimal', 'low', 'medium', 'high', 'xhigh'],
  'x-preview-f-free': ['low', 'high', 'max'],
};

function pickUA() {
  const pool = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  ];
  return pool[0];
}
function injectHeaders(headers) {
  const h = { ...headers };
  h['User-Agent'] = pickUA();
  h['x-opencode-session'] = crypto.randomUUID().replace(/-/g, '');
  h['x-opencode-client'] = 'opencode-free-pool-cf';
  return h;
}
function authOk(request, env) {
  const key = env.PROXY_API_KEY || PROXY_API_KEY;
  if (!key) return true;
  const apiKey = request.headers.get('x-api-key') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || request.headers.get('x-proxy-key');
  return apiKey === key;
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, x-opencode-session',
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function applyMuseDefaults(body) {
  if (/muse/i.test(String(body.model || ''))) {
    if ('max_tokens' in body || !('max_output_tokens' in body)) body.max_tokens = 131072;
    body.max_output_tokens = 131072;
    body.reasoning = body.reasoning || { effort: 'low' };
  }
  return body;
}

let modelsCache = null, modelsCacheTime = 0;
const MODELS_TTL = 60 * 60 * 1000;

async function getFreeModelsExpanded() {
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTime) < MODELS_TTL) return modelsCache;
  let rawIds = [];
  try {
    const res = await fetch(UPSTREAM + '/models', { headers: { 'User-Agent': pickUA() } });
    const data = await res.json();
    const arr = data && Array.isArray(data.data) ? data.data : [];
    rawIds = arr.map(m => m.id).filter(Boolean);
  } catch (e) {}
  if (!rawIds.length) rawIds = ['muse-spark-1.2-contributor-free', 'hy3-free', 'x-preview-f-free', 'big-pickle', 'grok-code'];
  const freeIds = rawIds.filter(id => id.endsWith('-free') || KNOWN_FREE_EXTRA.has(id));
  const nowSec = Math.floor(now / 1000);
  const expanded = [];
  for (const id of freeIds) {
    expanded.push({ id: `opencode/${id}`, object: 'model', created: nowSec, owned_by: 'opencode' });
    for (const v of (VARIANT_MAP[id] || [])) {
      expanded.push({ id: `opencode/${id}:${v}`, object: 'model', created: nowSec, owned_by: 'opencode' });
    }
  }
  expanded.sort((a, b) => a.id.localeCompare(b.id));
  modelsCache = expanded; modelsCacheTime = now;
  return expanded;
}

function parseModel(requested) {
  let m = String(requested || '');
  let variant = null;
  if (m.includes(':')) {
    const parts = m.split(':');
    variant = parts[parts.length - 1];
    m = parts.slice(0, -1).join(':');
  }
  m = m.replace(/^opencode\//, '');
  return { upstreamModel: m, variant };
}

function applyVariant(upstreamBody, variant) {
  if (!variant) return upstreamBody;
  upstreamBody.reasoning_effort = variant;
  upstreamBody.reasoningEffort = variant;
  return upstreamBody;
}

async function forward(path, bodyObj, isStream) {
  const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' });
  return fetch(UPSTREAM + path, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
}
async function forwardStreamOrJson(upstreamRes, isStream) {
  if (isStream) {
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  }
  const text = await upstreamRes.text();
  return new Response(text, { status: upstreamRes.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/health' || pathname === '/v1/health') {
      return json({ status: 'ok', upstream: UPSTREAM });
    }
    if (pathname.startsWith('/v1/') && !authOk(request, env)) {
      return json({ error: { type: 'authentication_error', message: 'Invalid API key' } }, 401);
    }

    if (request.method === 'GET' && pathname === '/v1/models') {
      try {
        const data = await getFreeModelsExpanded();
        return json({ object: 'list', data });
      } catch (e) { return json({ error: { message: e.message } }, 500); }
    }

    if (request.method !== 'POST') return json({ error: { message: `Not found: ${request.method} ${pathname}` } }, 404);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: { message: 'Invalid JSON' } }, 400); }
    if (!body.model) return json({ error: { message: 'model required' } }, 400);

    const { upstreamModel, variant } = parseModel(body.model);
    const isMuse = /muse/i.test(upstreamModel);
    const isStream = !!body.stream;

    try {
      if (pathname === '/v1/chat/completions') {
        const upstreamBody = applyVariant(applyMuseDefaults({ ...body, model: upstreamModel }), variant);
        if (variant && isMuse) upstreamBody.reasoning = { effort: variant === 'minimal' ? 'low' : (['low', 'medium', 'high'].includes(variant) ? variant : 'high') };
        const r = await forward('/chat/completions', upstreamBody, isStream);
        return forwardStreamOrJson(r, isStream);
      }

      if (pathname === '/v1/responses') {
        let upstreamBody = applyVariant(applyMuseDefaults({ ...body, model: upstreamModel }), variant);
        if (variant && isMuse) upstreamBody.reasoning = { effort: variant === 'minimal' ? 'low' : (['low', 'medium', 'high'].includes(variant) ? variant : 'high') };
        const r = await forward('/responses', upstreamBody, isStream);
        return forwardStreamOrJson(r, isStream);
      }

      if (pathname === '/v1/messages') {
        const openReq = { model: upstreamModel, messages: body.messages || [], max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p, stream: !!body.stream, stop: body.stop_sequences };
        const full = applyVariant(applyMuseDefaults(openReq), variant);
        if (variant && isMuse) full.reasoning = { effort: variant === 'minimal' ? 'low' : (['low', 'medium', 'high'].includes(variant) ? variant : 'high') };
        const r = await forward('/chat/completions', full, isStream);
        if (isStream) return forwardStreamOrJson(r, true);
        const text = await r.text();
        if (!r.ok) return json({ type: 'error', error: { type: 'api_error', message: text.slice(0, 500) } }, r.status);
        let openJson; try { openJson = JSON.parse(text); } catch (e) { return json({ type: 'error', error: { type: 'api_error', message: 'invalid upstream json' } }, 502); }
        const choice = openJson.choices?.[0];
        const msg = choice?.message || {};
        const contentBlocks = [];
        if (msg.content) contentBlocks.push({ type: 'text', text: msg.content });
        const anthRes = {
          id: openJson.id?.replace('gen-', 'msg_') || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'message', role: 'assistant', model: openJson.model || upstreamModel,
          content: contentBlocks.length ? contentBlocks : [{ type: 'text', text: '' }],
          stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn', stop_sequence: null,
          usage: { input_tokens: openJson.usage?.prompt_tokens || 0, output_tokens: openJson.usage?.completion_tokens || 0 }
        };
        return json(anthRes);
      }
    } catch (e) {
      return json({ error: { message: e.message } }, 502);
    }

    return json({ error: { message: `Not found: ${request.method} ${pathname}` } }, 404);
  }
};
export { handleRequest };
