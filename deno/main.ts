'use strict';

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

function applyMuseDefaults(body, api) {
  if (/muse/i.test(String(body.model || ''))) {
    const reqMax = Math.max(body.max_tokens || 0, body.max_output_tokens || 0);
    const forced = Math.max(131072, reqMax);
    delete body.max_tokens;
    delete body.max_output_tokens;
    if (api === 'responses') body.max_output_tokens = forced;
    else body.max_tokens = forced;
    body.reasoning = body.reasoning || { effort: 'low' };
  }
  return body;
}

let modelsCache = null, modelsCacheTime = 0;
const MODELS_TTL = 60 * 60 * 1000;

// === Kilo Gateway 프로바이더 (무료 모델만, 인증 불필요) ===
const KILO_BASE = 'https://api.kilo.ai/api/gateway';
let kiloModelsCache = null;
let kiloModelsCacheTime = 0;
async function getKiloFreeModels() {
  const now = Date.now();
  if (kiloModelsCache && (now - kiloModelsCacheTime) < 300000) return kiloModelsCache;
  try {
    const r = await fetch(KILO_BASE + '/models', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const zero = x => parseFloat(String(x)) === 0;
    const nowSec = Math.floor(now / 1000);
    const list = [];
    for (const m of j.data || []) {
      const p = m.pricing || {};
      if (!(zero(p.prompt) && zero(p.completion))) continue;
      if (!m.id) continue;
      list.push({ id: 'kilo/' + m.id, object: 'model', created: nowSec, owned_by: 'kilo' });
    }
    kiloModelsCache = list; kiloModelsCacheTime = now;
  } catch (e) { console.error('[kilo models] fail', String(e).slice(0, 80)); }
  return kiloModelsCache || [];
}

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
    // think variation(:high 등)은 더 이상 별도 모델로 노출하지 않음 — 호출 시 파라미터로 처리

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

// P14 fix (2026-09-10): the existing .map() below only normalized a raw
// STRING content part to input_text -- an object part shaped {type:'text',
// text:'...'} (Chat Completions array-content, e.g. Codex CLI's AGENTS.md
// injection) passed through untouched, and the Responses API input schema
// rejects 'text' as a user/input part type with
// `input[N].content did not match any supported type`.
function normalizeMuseContentPart(x) {
  if (typeof x === 'string') return { type: 'input_text', text: x };
  if (x && typeof x === 'object') {
    if (x.type === 'text') return { type: 'input_text', text: x.text || '' };
    if (x.type === 'image_url') {
      const url = (x.image_url && x.image_url.url) || x.image_url;
      return { type: 'input_image', image_url: url };
    }
  }
  return x;
}
function museToInput(messages) {
  const input = [];
  const seenCalls = new Set();   // P3 fix: duplicate function_call guard
  const seenOutputs = new Set(); // P3 fix: duplicate function_call_output guard
  for (const m of messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      input.push({ role: 'developer', content: [{ type: 'input_text', text: String(m.content) }] });
    } else if (m.role === 'user') {
      const c = Array.isArray(m.content) ? m.content : [{ type: 'input_text', text: String(m.content ?? '') }];
      input.push({ role: 'user', content: c.map(normalizeMuseContentPart) });
    } else if (m.role === 'assistant') {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.id) { if (seenCalls.has(tc.id)) continue; seenCalls.add(tc.id); }
          let args = tc.function?.arguments ?? '{}';
          try { JSON.parse(args); } catch { args = '{}'; }
          input.push({ type: 'function_call', name: tc.function.name, call_id: tc.id, arguments: String(args) });
        }
        if (m.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      } else {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content || '' }] });
      }
    } else if (m.role === 'tool') {
      const oid0 = m.tool_call_id ?? '';
      if (oid0 && seenOutputs.has(oid0)) continue;
      if (oid0) seenOutputs.add(oid0);
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    }
  }
  return input;
}

const MUSE_EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

function responsesToChatJson(json, model) {
  let text = ''; const toolCalls = [];
  for (const o of json.output || []) {
    if (o.type === 'message') { for (const c of o.content || []) { if (c.type === 'output_text') text += c.text; } }
    else if (o.type === 'function_call') { toolCalls.push({ id: o.call_id || ('call_' + crypto.randomUUID().slice(0, 8)), type: 'function', function: { name: o.name, arguments: o.arguments || '{}' } }); }
  }
  const msg = { role: 'assistant', content: text };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return { id: 'chatcmpl-' + String(json.id || crypto.randomUUID()).slice(0, 24), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: msg, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage: json.usage ? { prompt_tokens: json.usage.input_tokens || 0, completion_tokens: json.usage.output_tokens || 0 } : undefined };
}

function chatChunk(deltaObj) { return 'data: ' + JSON.stringify({ id: 'chatcmpl-muse', object: 'chat.completion.chunk', choices: [{ index: 0, delta: deltaObj }] }) + '\n\n'; }

function responsesSSEToChatStream(body) {
  const dec = new TextDecoder(); let buf = ''; let fnIndex = -1;
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of body) {
          buf += dec.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
            let data = null;
            for (const line of raw.split('\n')) { if (line.startsWith('data:')) data = line.slice(5).trim(); }
            if (!data || data === '[DONE]') continue;
            let ev; try { ev = JSON.parse(data); } catch { continue; }
            const t = ev.type || '';
            if (t === 'response.output_text.delta' && ev.delta) controller.enqueue(enc.encode(chatChunk({ content: ev.delta })));
            else if (t === 'response.output_item.added' && ev.item && ev.item.type === 'function_call') {
              fnIndex += 1;
              controller.enqueue(enc.encode(chatChunk({ tool_calls: [{ index: fnIndex, id: ev.item.call_id || ('call_' + fnIndex), type: 'function', function: { name: ev.item.name || '', arguments: '' } }] })));
            }
            else if (t === 'response.function_call_arguments.delta' && ev.delta) controller.enqueue(enc.encode(chatChunk({ tool_calls: [{ index: Math.max(fnIndex, 0), function: { arguments: ev.delta } }] })));
          }
        }
      } catch (_) {}
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

async function museChatResponse(upstreamModel, bodyObj, variant, isStream) {
  const reqMax = Math.max(bodyObj.max_tokens || 0, bodyObj.max_output_tokens || 0);
  const rbody = {
    model: upstreamModel,
    input: museToInput(bodyObj.messages),
    tools: (bodyObj.tools || []).map(t => t && t.type === 'function' && t.function ? { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters } : t).filter(Boolean),
    tool_choice: bodyObj.tool_choice,
    max_output_tokens: Math.max(131072, reqMax || 0),
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: variant ? (MUSE_EFFORT[variant] || 'high') : 'low', summary: 'auto' },
    stream: !!isStream,
    metadata: { _nonce: crypto.randomUUID().slice(0, 12) },
  };
  const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' });
  const r = await fetch(UPSTREAM + '/responses', { method: 'POST', headers, body: JSON.stringify(rbody) });
  if (!r.ok) return forwardStreamOrJson(r, false);
  if (isStream) return new Response(responsesSSEToChatStream(r.body), { status: 200, headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  return json(responsesToChatJson(await r.json(), upstreamModel));
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
        let data = await getFreeModelsExpanded();
        try { data = data.concat(await getKiloFreeModels()); data.sort((a, b) => a.id.localeCompare(b.id)); } catch {}
        return json({ object: 'list', data });
      } catch (e) { return json({ error: { message: e.message } }, 500); }
    }

    if (request.method !== 'POST') return json({ error: { message: `Not found: ${request.method} ${pathname}` } }, 404);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: { message: 'Invalid JSON' } }, 400); }
    if (!body.model) return json({ error: { message: 'model required' } }, 400);
    {
      // reasoning 모델이 작은 max_tokens를 추론에 소진하는 것 방지
      const mmT = parseInt(process.env.MIN_MAX_TOKENS || '1024', 10);
      for (const k of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
        if (typeof body[k] === 'number' && body[k] < mmT) body[k] = mmT;
      }
    }

    const { upstreamModel, variant } = parseModel(body.model);
    const isMuse = /muse/i.test(upstreamModel);
    const isStream = !!body.stream;

    try {
      // === Kilo Gateway 모델 (kilo/ 접두사) — zen 로직 우회, 직접 포워드 ===
      if (/^kilo\//i.test(String(body.model || ''))) {
        const realModel = String(body.model).replace(/^kilo\//i, '');
        let msgs = Array.isArray(body.messages) ? body.messages : [];
        if (!msgs.length && Array.isArray(body.input)) {
          msgs = body.input.map(i => ({ role: i.role || 'user', content: typeof i.content === 'string' ? i.content : Array.isArray(i.content) ? i.content.map(c => c.text || '').join('') : '' }));
        }
        const kHeaders = { 'Content-Type': 'application/json', Accept: isStream ? 'text/event-stream' : 'application/json' };
        const clientAuth = request.headers.get('authorization');
        if (clientAuth) kHeaders.Authorization = clientAuth;
        // P17 fix (2026-09-11, corrected): live diagnostic logging on oracle2
        // showed the real failing requests carry ONLY reasoning_effort --
        // reasoning (the structured object) is absent entirely. So this is
        // Kilo's own backend assigning its own internal reasoning.effort for
        // whatever model kilo-auto routes to, conflicting with the client's
        // reasoning_effort -- not a client-side duplicate. Unconditionally
        // strip both spellings, matching the /v1/messages kilo branch below.
        const kiloBody = { ...body, model: realModel, messages: msgs };
        delete kiloBody.reasoning_effort;
        delete kiloBody.reasoningEffort;
        const kr = await fetch(KILO_BASE + '/chat/completions', { method: 'POST', headers: kHeaders, body: JSON.stringify(kiloBody) });
        if (isStream && kr.ok) {
          return new Response(kr.body, { status: 200, headers: { ...CORS, 'Content-Type': kr.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' } });
        }
        return new Response(await kr.text(), { status: kr.status, headers: { ...CORS, 'Content-Type': kr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (pathname === '/v1/chat/completions') {
        // fix400 v2 (2026-08-26): Responses 형식 요청 처리
        // - muse: zen /responses 패스스루 (zen이 responses를 지원하는 유일 계열)
        // - non-muse: input->messages 변환 후 /chat/completions 포워드
        if (!Array.isArray(body.messages) && Array.isArray(body.input)) {
          if (!isMuse) {
            const conv = [];
            for (const it of body.input) {
              if (it && it.type === 'function_call') {
                conv.push({ role: 'assistant', content: null, tool_calls: [{ id: it.call_id || 'call_0', type: 'function', function: { name: it.name || '', arguments: it.arguments || '{}' } }] });
              } else if (it && it.type === 'function_call_output') {
                conv.push({ role: 'tool', tool_call_id: it.call_id || '', content: String(it.output ?? '') });
              } else if (it && it.role) {
                conv.push({ role: it.role, content: typeof it.content === 'string' ? it.content : Array.isArray(it.content) ? it.content.map(c => c.text || '').join('') : '' });
              }
            }
            const pre = typeof body.instructions === 'string' && body.instructions ? [{ role: 'system', content: body.instructions }] : [];
            let mb = applyVariant(applyMuseDefaults({ ...body, model: upstreamModel, messages: [...pre, ...conv] }, 'chat'), variant);
            delete mb.input; delete mb.instructions;
            const r3 = await forward('/chat/completions', mb, isStream);
            return forwardStreamOrJson(r3, isStream);
          }
          let ub = applyMuseDefaults({ ...body, model: upstreamModel }, 'responses');
          ub.metadata = Object.assign({}, ub.metadata, { _nonce: crypto.randomUUID().slice(0, 12) });
          const r2 = await fetch(UPSTREAM + '/responses', { method: 'POST', headers: injectHeaders({ 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' }), body: JSON.stringify(ub) });
          if (isStream && r2.ok) return new Response(r2.body, { status: 200, headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Cache-Control': 'no-store' } });
          return new Response(await r2.text(), { status: r2.status, headers: { ...CORS, 'Content-Type': r2.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
        }
        if (isMuse) return await museChatResponse(upstreamModel, body, variant, isStream);
        const upstreamBody = applyVariant(applyMuseDefaults({ ...body, model: upstreamModel }, 'chat'), variant);
        const r = await forward('/chat/completions', upstreamBody, isStream);
        return forwardStreamOrJson(r, isStream);
      }

      if (pathname === '/v1/responses') {
        if (/^kilo\//i.test(String(body.model || ''))) return json({ error: { message: 'kilo models do not support the Responses API. Use /v1/chat/completions.' } }, 400);
        let upstreamBody = applyMuseDefaults({ ...body, model: upstreamModel }, 'responses');
        if (isMuse) upstreamBody.metadata = Object.assign({}, upstreamBody.metadata, { _nonce: crypto.randomUUID().slice(0, 12) });
        if (!isMuse) upstreamBody = applyVariant(upstreamBody, variant);
        else if (variant) upstreamBody.reasoning = Object.assign({}, upstreamBody.reasoning, { effort: variant === 'minimal' ? 'low' : (['low', 'medium', 'high'].includes(variant) ? variant : 'high'), summary: (upstreamBody.reasoning || {}).summary || 'auto' });
        const r = await forward('/responses', upstreamBody, isStream);
        return forwardStreamOrJson(r, isStream);
      }

      if (pathname === '/v1/messages') {
        const openReq = { model: upstreamModel, messages: body.messages || [], max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p, stream: !!body.stream, stop: body.stop_sequences };
        const full = applyVariant(applyMuseDefaults(openReq, 'chat'), variant);
        if (variant && isMuse) full.reasoning = { effort: variant === 'minimal' ? 'low' : (['low', 'medium', 'high'].includes(variant) ? variant : 'high') };
        let r;
        if (/^kilo\//i.test(String(full.model || ''))) {
          const kBody = { ...full, model: String(full.model).replace(/^kilo\//i, '') };
          delete kBody.reasoning_effort; delete kBody.reasoningEffort;
          if (variant && !String(kBody.model).includes(':')) kBody.model += ':' + variant;
          const kr = await fetch(KILO_BASE + '/chat/completions', { method: 'POST', headers: injectHeaders({ 'Content-Type': 'application/json', Accept: isStream ? 'text/event-stream' : 'application/json' }), body: JSON.stringify(kBody) });
          r = new Response(await kr.text(), { status: kr.status, headers: { 'Content-Type': kr.headers.get('content-type') || 'application/json' } });
        } else {
          r = await forward('/chat/completions', full, isStream);
        }
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
