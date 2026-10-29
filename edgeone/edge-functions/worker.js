'use strict';

const UPSTREAM = 'https://opencode.ai/inference/v1';
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
// 2026-10-24: api/index.js(메인)와 동일한 zen 헤더 계약으로 갱신 — 이 파일은 P33 이전
// 코드(Chrome UA + 접두사 없는 hex 세션)라 zen 무료 게이트 자체를 통과 못 했다.
// 세션 id는 UTC 일 단위 고정, 요청 id는 sha256(sessionId + 마지막 user 메시지)로
// 결정론적 생성해 재시도가 같은 id를 공유한다(session 단위 쿼터 집행 대응, 상세 근거는
// api/index.js 주석 참고). Workers WebCrypto 사용.
const ZEN_B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function opencodeIdFromDigest(prefix, digest) {
  let hexPart = '';
  for (const byte of digest.subarray(0, 6)) hexPart += byte.toString(16).padStart(2, '0');
  let b62Part = '';
  for (const byte of digest.subarray(6, 20)) b62Part += ZEN_B62[byte % 62];
  return prefix + hexPart + b62Part;
}
function synthesizeOpencodeId(prefix) {
  return opencodeIdFromDigest(prefix, crypto.getRandomValues(new Uint8Array(32)));
}
// 2026-10-24 (9router PR #4791): zen은 ses_의 hex 12자가 inverted timestamp인지 검사.
// 9router #5218: counter는 1..16 범위에서 순환해야 통과(100 이상은 403).
let zenIdCounter = 0;
function canonicalSessionId() {
  zenIdCounter = (zenIdCounter % 16) + 1;
  const units = BigInt(Date.now()) * 4096n + BigInt(zenIdCounter);
  const inverted = ~units & ((1n << 48n) - 1n);
  const hexPart = inverted.toString(16).padStart(12, '0');
  const digest = crypto.getRandomValues(new Uint8Array(14));
  let b62Part = '';
  for (const byte of digest) b62Part += ZEN_B62[byte % 62];
  return 'ses_' + hexPart + b62Part;
}
let zenAnonSession = null; // { id, day }
async function zenSessionId() {
  const day = new Date().toISOString().slice(0, 10);
  if (!zenAnonSession || zenAnonSession.day !== day) {
    zenAnonSession = { id: canonicalSessionId(), day };
  }
  return zenAnonSession.id;
}
function extractLastUserText(body) {
  const parts = [];
  const collect = (c) => {
    if (typeof c === 'string') { parts.push(c); return; }
    if (Array.isArray(c)) for (const p of c) {
      if (typeof p === 'string') parts.push(p);
      else if (p && typeof p === 'object') parts.push(p.text ?? p.content ?? p.input_text ?? '');
    }
  };
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') { collect(msgs[i].content); return parts.join(''); }
  }
  const input = body && body.input;
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i--) {
      const it = input[i];
      if (it && (it.role === 'user' || it.type === 'message')) { collect(it.content ?? it.text ?? ''); return parts.join(''); }
    }
  }
  return '';
}
// 9router #5218: OpenCode v2 CLI UA & headers
const ZEN_UA = 'opencode/latest/2.2.0/cli';
// async가 됐다 — 호출부에서 await 필요.
async function injectHeaders(headers, upstreamBody) {
  const h = { ...headers };
  const sessionId = await zenSessionId();
  h['User-Agent'] = ZEN_UA;
  h['x-opencode-session-id'] = sessionId;
  h['x-opencode-session'] = sessionId;
  h['x-session-affinity'] = sessionId;
  h['x-session-id'] = sessionId;
  h['x-opencode-client'] = 'cli';
  h['x-opencode-project'] = crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'').slice(0,8);
  delete h['x-opencode-request'];
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
  const headers = await injectHeaders({ 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' }, bodyObj);
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
