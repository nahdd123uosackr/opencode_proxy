'use strict';
const crypto = require('node:crypto');
const UPSTREAM = process.env.UPSTREAM || 'https://opencode.ai/zen/v1';

// === Key Circuit Breaker & Cooldown Manager ===
const keyStatusMap = new Map(); // keyHash -> { cooldownUntil: number, fails: number, reason: string }

function getKeyHash(key) {
  if (!key) return null;
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

function isKeyCooling(key) {
  const hash = getKeyHash(key);
  if (!hash) return false;
  const stat = keyStatusMap.get(hash);
  if (!stat) return false;
  if (Date.now() < stat.cooldownUntil) {
    return stat;
  }
  return false;
}

function markKeyFailure(key, statusCode, bodyText) {
  const hash = getKeyHash(key);
  if (!hash) return;
  const now = Date.now();
  const stat = keyStatusMap.get(hash) || { fails: 0, cooldownUntil: 0, reason: '' };
  stat.fails += 1;
  
  let cooldownMs = 60 * 1000;
  let reason = 'Rate Limit (429)';

  if (statusCode === 429) {
    cooldownMs = 60 * 1000;
    reason = 'Rate Limit (429)';
  } else if (statusCode === 402 || /quota|insufficient_quota|balance|FreeUsageLimitError/i.test(bodyText || '')) {
    cooldownMs = 30 * 60 * 1000;
    reason = 'Quota Exceeded (402)';
  } else if (statusCode === 401 || statusCode === 403 || /AuthError|Invalid API key/i.test(bodyText || '')) {
    cooldownMs = 60 * 60 * 1000;
    reason = 'Auth Error (401/403)';
  } else if (statusCode >= 500) {
    cooldownMs = 15 * 1000;
    reason = 'Server Error (5xx)';
  } else {
    cooldownMs = Math.min(60000 * Math.pow(2, Math.min(stat.fails - 1, 4)), 1800000);
  }

  stat.cooldownUntil = now + cooldownMs;
  stat.reason = reason;
  keyStatusMap.set(hash, stat);
  console.log(`[CircuitBreaker] Key(${hash}) failed (${statusCode} / ${reason}) -> cooldown ${Math.round(cooldownMs/1000)}s (fails=${stat.fails})`);
}

function markKeySuccess(key) {
  const hash = getKeyHash(key);
  if (!hash) return;
  if (keyStatusMap.has(hash)) {
    keyStatusMap.delete(hash);
  }
}

function checkAndMarkResponse(key, status, bodyText) {
  if (!key) return;
  let isError = !status || status >= 400;
  let errStatus = status || 500;

  if (bodyText && typeof bodyText === 'string') {
    if (/AuthError|Invalid API key/i.test(bodyText)) {
      isError = true;
      errStatus = 401;
    } else if (/Rate limit|FreeUsageLimitError|quota|exceeded/i.test(bodyText)) {
      isError = true;
      errStatus = 429;
    } else if (/"error":/i.test(bodyText) && !/"choices":/i.test(bodyText)) {
      isError = true;
    }
  }

  if (isError) {
    markKeyFailure(key, errStatus, bodyText);
  } else {
    markKeySuccess(key);
  }
}


// === Kilo Gateway 프로바이더 (무료 모델 및 사용자 키 지원) ===
const KILO_BASE = 'https://api.kilo.ai/api/gateway';
let kiloModelsCache = null, kiloModelsCacheTime = 0;

async function getKiloFreeModels() {
  const now = Date.now();
  if (kiloModelsCache && (now - kiloModelsCacheTime) < 300000) return kiloModelsCache;
  try {
    const headers = { 'User-Agent': pickUA() };
    const r = await fetch(KILO_BASE + '/models', { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const zero = x => parseFloat(x) === 0;
    const nowSec = Math.floor(now / 1000);
    const list = [];
    for (const m of j.data || []) {
      const p = m.pricing || {};
      if (!(zero(p.prompt) && zero(p.completion))) continue;
      if (!m.id) continue;
      list.push({ id: 'kilo/' + m.id, object: 'model', created: nowSec, owned_by: 'kilo' });
    }
    kiloModelsCache = list;
    kiloModelsCacheTime = now;
    return list;
  } catch (e) {
    console.error('[kilo models] fail', e.message);
  }
  return kiloModelsCache || [];
}

const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const ZEN_TIMEOUT_MS = parseInt(process.env.ZEN_TIMEOUT_MS || '120000', 10);
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || '10485760', 10); // 10MB
let shuttingDown = false;
process.on('SIGTERM', () => { shuttingDown = true; });
process.on('SIGINT', () => { shuttingDown = true; });

function randomRelay() { return null; }
function pickUA() {
  const pool = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  ];
  return pool[0];
}

// === API Key 분류 및 추출 ===
function extractClientKey(req) {
  const raw = req.headers['authorization'] || req.headers['x-api-key'] || req.headers['x-proxy-key'] || '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

function isKiloKey(key) {
  if (!key) return false;
  // Kilo Gateway 키는 JWT 포맷 (eyJ... 또는 3-segment dot notation)
  return key.startsWith('eyJ') || key.split('.').length === 3;
}

function isOpenCodeZenKey(key) {
  if (!key) return false;
  if (PROXY_API_KEY && key === PROXY_API_KEY) return false;
  if (key === 'sk-dummy' || key === 'sk-proxy-master' || key === '1') return false;
  // OpenCode Zen 키는 sk- 접두사 형태 (JWT가 아님)
  return key.startsWith('sk-') && !isKiloKey(key);
}

function injectHeaders(headers, relay, zenApiKey) {
  const h = { ...headers };
  h['User-Agent'] = pickUA();
  h['x-opencode-session'] = crypto.randomUUID().replace(/-/g, '');
  h['x-opencode-client'] = 'opencode-free-pool-vercel';
  if (zenApiKey) {
    h['Authorization'] = zenApiKey.startsWith('Bearer ') ? zenApiKey : `Bearer ${zenApiKey}`;
  }
  return h;
}

function authOk(req) {
  if (!PROXY_API_KEY) return true;
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.headers['x-proxy-key'];
  return apiKey === PROXY_API_KEY;
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, x-opencode-session' };
}

// reasoning 모델이 작은 max_tokens를 추론에 소진하는 것 방지 (공통)
function applyMinTokens(body) {
  const mmT = parseInt(process.env.MIN_MAX_TOKENS || '1024', 10);
  for (const k of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    if (typeof body[k] === 'number' && body[k] < mmT) body[k] = mmT;
  }
  return body;
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

// P14 fix (2026-09-10): a role:'user' message whose content is ALREADY an
// array (Chat Completions shape, e.g. Codex CLI's AGENTS.md injection --
// [{type:'text', text:'...'}]) was forwarded verbatim with no per-part type
// mapping. The Responses API input schema requires 'input_text' (not
// 'text') for a user/input content part, so this produced
// `input[N].content did not match any supported type` -- same bug class as
// P9 (assistant output_text / top-level function_call), just on the user
// side.
// P20 fix (2026-09-11): Codex wire_api=responses 직접 호출 시 /v1/responses
// 경로가 전혀 정규화 없이 passthrough되어 동일한 400이 재발함. 또한
// system/developer가 배열형 AGENTS.md를 보낼 때 String()으로 망가지는
// 케이스, assistant content가 배열일 때 String() 오염 케이스도 함께 수정.
// 유의사항: 유의사항.md §정규식 "이중 이스케이프 금지", §muse 경로별 variant
// 매핑 누락 주의 — MUSE_EFFORT 6키 유지.
function normalizeMuseContentPart(x, role) {
  // role: 'user' | 'developer' | 'assistant' — 출력 타입 결정에 사용
  const targetRole = role === 'assistant' ? 'assistant' : 'user';
  if (typeof x === 'string') return { type: targetRole === 'assistant' ? 'output_text' : 'input_text', text: x };
  if (x && typeof x === 'object') {
    if (x.type === 'text') return { type: targetRole === 'assistant' ? 'output_text' : 'input_text', text: x.text || '' };
    if (x.type === 'input_text' || x.type === 'output_text' || x.type === 'refusal') return x;
    if (x.type === 'input_image' && x.image_url) return x;
    if (x.type === 'image_url') {
      const url = (x.image_url && x.image_url.url) || x.image_url || x.url;
      if (url) return { type: 'input_image', image_url: url };
      return null;
    }
    // 지원 불가 타입은 텍스트가 있으면 텍스트로 퇴화, 없으면 드랍(400 방지)
    if (typeof x.text === 'string' && x.text) return { type: targetRole === 'assistant' ? 'output_text' : 'input_text', text: String(x.text) };
    if (typeof x.content === 'string' && x.content) return { type: targetRole === 'assistant' ? 'output_text' : 'input_text', text: String(x.content) };
  }
  return null;
}
function museToInput(messages) {
  const input = [];
  const seenCalls = new Set();   // P3 fix (2026-08-25): 중복 function_call 제거
  const seenOutputs = new Set(); // P3 fix (2026-08-25): 중복 function_call_output 제거 (zen 'Duplicate function_call_output' 400 방지)
  for (const m of messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      // P20: system/developer도 배열형 content 대응 (Codex AGENTS.md 등)
      let c;
      if (Array.isArray(m.content)) {
        c = m.content.map(v => normalizeMuseContentPart(v, 'user')).filter(Boolean);
        if (!c.length) c = [{ type: 'input_text', text: '' }];
      } else if (typeof m.content === 'string') {
        c = [{ type: 'input_text', text: m.content }];
      } else {
        c = [{ type: 'input_text', text: JSON.stringify(m.content ?? '') }];
      }
      input.push({ role: 'developer', content: c });
    } else if (m.role === 'user') {
      let c;
      if (Array.isArray(m.content)) {
        c = m.content.map(v => normalizeMuseContentPart(v, 'user')).filter(Boolean);
        if (!c.length) c = [{ type: 'input_text', text: '' }];
      } else if (typeof m.content === 'string') {
        c = [{ type: 'input_text', text: m.content }];
      } else {
        c = [{ type: 'input_text', text: JSON.stringify(m.content ?? '') }];
      }
      input.push({ role: 'user', content: c });
    } else if (m.role === 'assistant') {
      // P9 fix (2026-09-09): function_call/function_call_output must be top-level
      // input items, NOT nested inside a message's content array — the Responses
      // API schema rejects {role:'assistant', content:[{type:'function_call',...}]}
      // with "input[N].content did not match any supported type" once real
      // tool-call history is replayed (missed by earlier single-turn-only tests).
      // Also: assistant text parts must use type 'output_text', not 'text'.
      // P20: 배열형 content 대응 — String() 오염 방지
      if (Array.isArray(m.content)) {
        const c = m.content.map(v => normalizeMuseContentPart(v, 'assistant')).filter(Boolean);
        if (c.length) input.push({ role: 'assistant', content: c });
      } else if (m.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: String(m.content) }] });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const callId = tc.id || '';
          if (callId && seenCalls.has(callId)) continue;
          if (callId) seenCalls.add(callId);
          input.push({ type: 'function_call', call_id: callId, name: tc.function?.name || '', arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}) });
        }
      }
    } else if (m.role === 'tool') {
      const outputId = m.tool_call_id || '';
      if (outputId && seenOutputs.has(outputId)) continue;
      if (outputId) seenOutputs.add(outputId);
      input.push({ type: 'function_call_output', call_id: outputId, output: String(m.content ?? '') });
    }
  }
  return input;
}

// P20: Codex wire_api=responses 네이티브 input sanitizer — /v1/responses passthrough
// 경로의 재발 방지. skill.md §4의 "museToInput 버그가 가장 많았다" 교훈 반영.
function sanitizeResponsesInput(input) {
  if (!Array.isArray(input)) return input;
  const out = [];
  for (const it of input) {
    if (!it || typeof it !== 'object') continue;
    // 1) role 기반 message — content 배열 정규화
    if (it.role) {
      const role = it.role;
      let content = it.content;
      if (typeof content === 'string') {
        content = [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
      } else if (!Array.isArray(content)) {
        // content가 null/object 등 비정상 — 문자열화 후 input_text로
        content = content ? [{ type: 'input_text', text: JSON.stringify(content) }] : [{ type: 'input_text', text: '' }];
      }
      const norm = content.map(c => normalizeMuseContentPart(c, role)).filter(Boolean);
      const finalContent = norm.length ? norm : [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: '' }];
      out.push({ role, content: finalContent });
      continue;
    }
    // 2) top-level function_call / function_call_output — 그대로 유지 (중복은 호출부에서 처리)
    if (it.type === 'function_call' || it.type === 'function_call_output') {
      out.push(it);
      continue;
    }
    // 3) Codex가 간혹 {type:'message', role, content} 형태로 감싸는 케이스
    if (it.type === 'message' && it.role) {
      const role = it.role;
      let content = it.content;
      if (typeof content === 'string') content = [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
      if (!Array.isArray(content)) content = [{ type: 'input_text', text: String(content ?? '') }];
      const norm = content.map(c => normalizeMuseContentPart(c, role)).filter(Boolean);
      out.push({ role, content: norm.length ? norm : [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: '' }] });
      continue;
    }
    // 4) reasoning / 기타 확장 타입 — Zen이 아직 지원 안 하면 드랍하되 로그 남김 (400보다 낫다)
    if (it.type === 'reasoning' || it.type === 'custom_tool_call' || it.type === 'compaction' || it.type === 'item_reference') {
      console.warn('[sanitize] drop unsupported input item type=' + it.type);
      continue;
    }
    console.warn('[sanitize] drop unknown input item ' + JSON.stringify(it).slice(0, 160));
  }
  return out;
}

// P21 fix (2026-09-11): Anthropic /v1/messages → OpenAI /v1/chat/completions 정규화.
// 기존 코드는 body.messages를 그대로 upstream에 전달하여
//  - system이 top-level 문자열/배열인데 무시됨
//  - content: [{type:"tool_use"}, {type:"tool_result"}, {type:"image"}] 가 OpenAI 스키마와 불일치
//  - tools: {input_schema} → {parameters} 미변환, tool_choice 매핑 누락
// 으로 Hermes/Claude Code의 tool/image 요청이 침묵 실패. 유의사항.md §muse 경로별 variant 유지.
function anthropicSystemToMessages(system) {
  if (!system) return [];
  if (typeof system === 'string') return [{ role: 'system', content: system }];
  if (Array.isArray(system)) {
    const text = system.map(b => b.text || b.content || '').filter(Boolean).join('\n');
    return text ? [{ role: 'system', content: text }] : [];
  }
  return [{ role: 'system', content: String(system) }];
}
function anthropicContentToOpenAIBlocks(content, role) {
  // Anthropic array → OpenAI array (text/image) + toolResults 분리
  if (typeof content === 'string') return { blocks: [{ type: 'text', text: content }], toolResults: [] };
  if (!Array.isArray(content)) return { blocks: [{ type: 'text', text: String(content ?? '') }], toolResults: [] };
  const blocks = [];
  const toolResults = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text || '' });
    else if (b.type === 'image') {
      const src = b.source;
      if (src && src.type === 'base64' && src.data) {
        const url = `data:${src.media_type || 'image/png'};base64,${src.data}`;
        blocks.push({ type: 'image_url', image_url: { url } });
      } else if (src && src.type === 'url' && src.url) {
        blocks.push({ type: 'image_url', image_url: { url: src.url } });
      } else if (b.url) {
        blocks.push({ type: 'image_url', image_url: { url: b.url } });
      }
    } else if (b.type === 'tool_result') {
      let c = b.content;
      if (Array.isArray(c)) c = c.map(x => x.text || x.content || '').join('\n');
      else if (c && typeof c === 'object') c = JSON.stringify(c);
      toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id || b.tool_call_id || '', content: String(c ?? '') });
    } else if (b.type === 'tool_use') {
      // assistant의 tool_use는 이 함수가 아니라 anthropicMessagesToOpenAI에서 tool_calls로 분리됨
      // user content에 잘못 섞인 경우 텍스트로 퇴화
      if (b.input) blocks.push({ type: 'text', text: JSON.stringify(b.input) });
    } else if (b.type === 'thinking') {
      // reasoning block — 요청에서는 무시 (응답에서는 thinking으로 변환됨)
      continue;
    } else if (b.type === 'input_text' || b.type === 'output_text') {
      blocks.push({ type: 'text', text: b.text || '' });
    } else if (b.type === 'image_url' && b.image_url) {
      blocks.push(b);
    } else if (typeof b.text === 'string') {
      blocks.push({ type: 'text', text: b.text });
    }
  }
  return { blocks, toolResults };
}
function anthropicMessagesToOpenAI(body) {
  const out = [];
  out.push(...anthropicSystemToMessages(body.system));
  for (const m of body.messages || []) {
    if (m.role === 'user') {
      const { blocks, toolResults } = anthropicContentToOpenAIBlocks(m.content, 'user');
      if (blocks.length) {
        if (blocks.length === 1 && blocks[0].type === 'text' && toolResults.length === 0) {
          out.push({ role: 'user', content: blocks[0].text });
        } else {
          out.push({ role: 'user', content: blocks });
        }
      } else if (toolResults.length === 0) {
        out.push({ role: 'user', content: String(m.content ?? '') });
      }
      for (const tr of toolResults) out.push(tr);
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        out.push({ role: 'assistant', content: m.content });
      } else if (Array.isArray(m.content)) {
        const texts = [];
        const toolCalls = [];
        for (const b of m.content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text') texts.push(b.text || '');
          else if (b.type === 'tool_use') {
            toolCalls.push({ id: b.id || `call_${crypto.randomUUID().slice(0,8)}`, type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) } });
          } else if (b.type === 'thinking') continue;
          else if (typeof b.text === 'string') texts.push(b.text);
        }
        const content = texts.join('\n') || null;
        if (toolCalls.length) out.push({ role: 'assistant', content, tool_calls: toolCalls });
        else out.push({ role: 'assistant', content: content || '' });
      } else {
        out.push({ role: 'assistant', content: String(m.content ?? '') });
      }
    } else if (m.role === 'system') {
      // 이미 system으로 분리했으나, messages 내 system도 허용
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      out.push({ role: 'system', content: text });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id || m.tool_use_id || '', content: String(m.content ?? '') });
    }
  }
  return out;
}
function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map(t => {
    if (t.type === 'function' && t.function) return t;
    return { type: 'function', function: { name: t.name || t.function?.name || '', description: t.description || t.function?.description || '', parameters: t.input_schema || t.parameters || t.function?.parameters || { type: 'object', properties: {} } } };
  });
}
function anthropicToolChoiceToOpenAI(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  if (tc.type === 'function') return tc;
  return tc;
}

function responsesToChatJson(r, model) {
  let content = '';
  const toolCalls = [];
  let reasoning = '';
  for (const it of (r && r.output) || []) {
    if (it.type === 'message' && Array.isArray(it.content)) {
      for (const c of it.content) {
        if (c.type === 'text' || c.type === 'output_text') content += (c.text || '');
        if (c.type === 'reasoning_text') reasoning += (c.text || '');
      }
    } else if (it.type === 'function_call') {
      toolCalls.push({
        id: it.call_id || `call_${crypto.randomUUID().slice(0, 8)}`,
        type: 'function',
        function: { name: it.name || '', arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {}) }
      });
    }
  }
  const u = r.usage || {};
  return {
    id: r.id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {})
      },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop'
    }],
    usage: {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0)
    }
  };
}

function chatChunk(deltaObj) { return 'data: ' + JSON.stringify({ id: 'chatcmpl-muse', object: 'chat.completion.chunk', choices: [{ index: 0, delta: deltaObj }] }) + '\n\n'; }

async function pumpResponsesSSEToChat(body, write) {
  const dec = new TextDecoder(); let buf = ''; let fnIndex = -1;
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
      if (t === 'response.output_text.delta' && ev.delta) write(chatChunk({ content: ev.delta }));
      else if (t === 'response.output_item.added' && ev.item && ev.item.type === 'function_call') {
        fnIndex += 1;
        write(chatChunk({ tool_calls: [{ index: fnIndex, id: ev.item.call_id || ('call_' + fnIndex), type: 'function', function: { name: ev.item.name || '', arguments: '' } }] }));
      }
      else if (t === 'response.function_call_arguments.delta' && ev.delta) write(chatChunk({ tool_calls: [{ index: Math.max(fnIndex, 0), function: { arguments: ev.delta } }] }));
    }
  }
  write('data: [DONE]\n\n');
}

// === /v1/messages 스트리밍용 Anthropic 이벤트 변환 ===
function createAnthropicStreamWriter(write, model, inputTokens) {
  const w = (ev, obj) => write(`event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`);
  let started = false, blockIdx = -1, blockKind = null, outTokens = 0;
  let curToolId = null, curToolName = null;
  const api = {
    ensureStart() {
      if (!started) {
        started = true;
        w('message_start', { type: 'message_start', message: { id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens || 0, output_tokens: 1 } } });
      }
    },
    text(delta) {
      this.ensureStart();
      if (blockKind !== 'text') {
        if (blockKind !== null) w('content_block_stop', { type: 'content_block_stop', index: blockIdx });
        blockIdx += 1; blockKind = 'text';
        w('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } });
      }
      w('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: delta } });
      outTokens += 1;
    },
    thinking(delta) {
      this.ensureStart();
      if (blockKind !== 'thinking') {
        if (blockKind !== null) w('content_block_stop', { type: 'content_block_stop', index: blockIdx });
        blockIdx += 1; blockKind = 'thinking';
        w('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'thinking', thinking: '' } });
      }
      w('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'thinking_delta', thinking: delta } });
      outTokens += 1;
    },
    setTool(id, name) {
      this.ensureStart();
      if (blockKind !== null) w('content_block_stop', { type: 'content_block_stop', index: blockIdx });
      blockIdx += 1; blockKind = 'tool_use'; curToolId = id; curToolName = name;
      w('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id, name, input: {} } });
    },
    toolArgs(delta) {
      if (blockKind !== 'tool_use') return;
      w('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: delta } });
    },
    end(stopReason, outputTokens) {
      this.ensureStart();
      if (blockKind !== null) w('content_block_stop', { type: 'content_block_stop', index: blockIdx });
      w('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens || outTokens || 1 } });
      w('message_stop', { type: 'message_stop' });
    }
  };
  return api;
}

async function pumpChatSSEToAnthropic(body, aw) {
  const dec = new TextDecoder(); let buf = ''; let finished = false;
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let data = null;
      for (const line of raw.split('\n')) { if (line.startsWith('data:')) data = line.slice(5).trim(); }
      if (!data || data === '[DONE]') continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      const ch = (ev.choices && ev.choices[0]) || {};
      const d = ch.delta || {};
      if (d.content) aw.text(d.content);
      if (d.reasoning_content || d.reasoning) aw.thinking(d.reasoning_content || d.reasoning);
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          if (tc.id && tc.function?.name) aw.setTool(tc.id, tc.function.name);
          if (tc.function?.arguments) aw.toolArgs(tc.function.arguments);
        }
      }
      if (ch.finish_reason) { finished = true; aw.end(ch.finish_reason, ev.usage?.completion_tokens); }
    }
  }
  if (!finished) aw.end('stop', null);
}

async function pumpResponsesSSEToAnthropic(body, aw) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:') || !line.slice(5).trim() || line.includes('[DONE]')) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      const t = ev.type || '';
      if (t === 'response.output_text.delta' && ev.delta) aw.text(ev.delta);
      else if ((t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') && ev.delta) aw.thinking(ev.delta);
      else if (t === 'response.output_item.added' && ev.item && ev.item.type === 'function_call') aw.setTool(ev.item.call_id || 'call_0', ev.item.name);
      else if (t === 'response.function_call_arguments.delta' && ev.delta) aw.toolArgs(ev.delta);
      else if (t === 'response.completed') {
        const u = (ev.response || {}).usage || {};
        aw.end('stop', u.output_tokens || 1);
        return;
      }
    }
  }
  aw.end('stop', 1);
}

const KNOWN_FREE_EXTRA = new Set(['big-pickle', 'grok-code']);
let modelsCache = null, modelsCacheTime = 0;
const MODELS_TTL = 60 * 60 * 1000;

async function museViaResponses(upstreamModel, bodyObj, variant, isStream, zenApiKey) {
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
  const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' }, null, zenApiKey);
  return fetch(UPSTREAM + '/responses', { method: 'POST', headers: headers, body: JSON.stringify(rbody) });
}

// === OpenCode Zen 모델 목록 조회 (키가 있을 때 vs 없을 때) ===
async function getZenModelsWithKey(zenApiKey) {
  try {
    const headers = { 'User-Agent': pickUA() };
    if (zenApiKey) headers['Authorization'] = zenApiKey.startsWith('Bearer ') ? zenApiKey : `Bearer ${zenApiKey}`;
    const res = await fetch(UPSTREAM + '/models', { headers });
    const data = await res.json();
    const arr = data && Array.isArray(data.data) ? data.data : [];
    const nowSec = Math.floor(Date.now() / 1000);
    return arr.map(m => {
      const mId = m.id || m;
      return {
        id: mId.startsWith('opencode/') ? mId : `opencode/${mId}`,
        object: 'model',
        created: nowSec,
        owned_by: 'opencode-zen'
      };
    });
  } catch (e) {
    console.error('[zen models with key] fail', e.message);
    return [];
  }
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
  } catch (e) { console.error('[models] upstream fail', e.message); }
  if (!rawIds.length) rawIds = ['muse-spark-1.2-contributor-free', 'hy3-free', 'x-preview-f-free', 'big-pickle', 'grok-code'];
  const freeIds = rawIds.filter(id => id.endsWith('-free') || KNOWN_FREE_EXTRA.has(id));
  const nowSec = Math.floor(now / 1000);
  const expanded = [];
  for (const id of freeIds) {
    expanded.push({ id: `opencode/${id}`, object: 'model', created: nowSec, owned_by: 'opencode' });
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

const MUSE_EFFORT = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high'
};

const handle = async (req, res) => {
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `https://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/health' || pathname === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', upstream: UPSTREAM }));
  }

  if (pathname === '/ip' || pathname === '/v1/ip') {
    try {
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ egress_ip: d.ip, provider: process.env.VERCEL ? 'vercel' : (process.env.DENO_REGION ? 'deno' : 'serverless') }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname.startsWith('/v1/') && !authOk(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid API key' } }));
  }

  if (shuttingDown) { for (const [k,v] of Object.entries(corsHeaders())) res.setHeader(k,v); res.writeHead(503, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ error: 'shutting down' })); }
  const chunks = []; let bodyBytes = 0;
  await new Promise(resolve => {
    req.on('data', c => {
      bodyBytes += c.length;
      if (bodyBytes > MAX_BODY_BYTES) { for (const [k,v] of Object.entries(corsHeaders())) res.setHeader(k,v); res.writeHead(413, {'Content-Type':'application/json'}); res.end(JSON.stringify({ error: 'payload too large' })); req.destroy(); resolve(); return; }
      chunks.push(c);
    });
    req.on('end', () => { const rawBody = Buffer.concat(chunks).toString('utf-8'); resolve(); });
    req.on('error', () => resolve());
  });

  const clientKey = extractClientKey(req);
  const isKilo = isKiloKey(clientKey);
  const isZen = isOpenCodeZenKey(clientKey);

  // ============================================================
  // GET /v1/models (3단 분기: Kilo Key vs Zen Key vs 무료 프록시)
  // ============================================================
  if (req.method === 'GET' && pathname === '/v1/models') {
    try {
      let data = [];
      if (isKilo) {
        // 1. Kilo Key: Kilo 관련 무료 모델만 반환 (upstream은 key 없이 조회)
        data = await getKiloFreeModels();
      } else if (isZen) {
        // 2. OpenCode Zen Key: OpenCode 관련 무료 모델만 반환 (upstream은 key 없이 조회)
        data = await getFreeModelsExpanded();
      } else {
        // 3. 키 없음 / 무료 프록시 모드: 무료 Zen 모델 + 무료 Kilo 모델 결합
        data = await getFreeModelsExpanded();
        try {
          const kilo = await getKiloFreeModels();
          data = data.concat(kilo);
        } catch {}
      }
      data.sort((a, b) => a.id.localeCompare(b.id));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  // ============================================================
  // POST /v1/chat/completions (3단 분기: Kilo vs Zen vs 무료 프록시)
  // ============================================================
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    let body; const rawBody = Buffer.concat(chunks).toString('utf-8'); try { body = JSON.parse(rawBody || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid JSON' } })); }
    applyMinTokens(body);
    if (!body.model) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model required' } })); }

    const modelStr = String(body.model || '');
    const hasKiloPrefix = /^kilo\//i.test(modelStr);
    const hasZenPrefix = /^opencode\//i.test(modelStr);

    // --- Key 타입과 모델 불일치 차단 가드 ---
    if (isKilo && hasZenPrefix) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Kilo API key can only be used with kilo models, requested: ${modelStr}` } }));
    }
    if (isZen && hasKiloPrefix) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `OpenCode Zen API key can only be used with opencode/zen models, requested: ${modelStr}` } }));
    }

    const routeToKilo = hasKiloPrefix || (isKilo && !hasZenPrefix);

    // --- 1. Kilo Gateway 요청 처리 ---
    if (routeToKilo) {
      const realModel = modelStr.replace(/^kilo\//i, '');
      let msgs = Array.isArray(body.messages) ? body.messages : [];
      if (!msgs.length && Array.isArray(body.input)) {
        msgs = body.input.map(i => ({ role: i.role || 'user', content: typeof i.content === 'string' ? i.content : Array.isArray(i.content) ? i.content.map(c => c.text || '').join('') : '' }));
      }
      // P17 fix (2026-09-11, corrected): confirmed via live diagnostic
      // logging that the real failing requests carry ONLY the legacy scalar
      // `reasoning_effort` -- `reasoning` (the structured object) is absent
      // entirely. So this is not a client-side duplicate-field problem;
      // Kilo's own backend assigns its own internal `reasoning.effort` for
      // the model kilo-auto routes to, and that conflicts with whatever
      // `reasoning_effort` the client also sent. The original conditional
      // delete (only when BOTH fields were present) never fired for this
      // real shape. Match the already-correct sibling fix in deno/main.ts's
      // /v1/messages Kilo branch: unconditionally strip both spellings.
      delete body.reasoning_effort;
      delete body.reasoningEffort;
      const kHeaders = { 'Content-Type': 'application/json', 'Accept': body.stream ? 'text/event-stream' : 'application/json' };
      if (isKilo) {
        kHeaders['Authorization'] = `Bearer ${clientKey}`;
      } else if (req.headers.authorization && !isOpenCodeZenKey(clientKey)) {
        kHeaders['Authorization'] = req.headers.authorization;
      }
      try {
              // Fast Circuit Breaker Check
      if (clientKey) {
        const cooling = isKeyCooling(clientKey);
        if (cooling) {
          const remainingSec = Math.ceil((cooling.cooldownUntil - Date.now()) / 1000);
          console.log(`[FastFail] Key ${getKeyHash(clientKey)} cooling (${cooling.reason}), remaining ${remainingSec}s`);
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(remainingSec) });
          return res.end(JSON.stringify({ error: { message: `Key is in cooldown (${cooling.reason}), retry in ${remainingSec}s`, type: 'rate_limit_exceeded' } }));
        }
      }
      const fr = await fetch(KILO_BASE + '/chat/completions', {
          method: 'POST',
          headers: kHeaders,
          body: JSON.stringify({ ...body, model: realModel, messages: msgs }),
          signal: AbortSignal.timeout(parseInt(process.env.KILO_STREAM_TIMEOUT_MS || '300000', 10))
        });
        if (body.stream && fr.ok) {
          res.writeHead(200, { 'Content-Type': fr.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' });
          const reader = fr.body.getReader(); const dec = new TextDecoder();
          try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); } } catch {}
          return res.end();
        }
        const t = await fr.text();
        res.writeHead(fr.status === 200 ? 200 : fr.status, { 'Content-Type': fr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
        return res.end(t);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: e.message } }));
      }
    }

    // --- 2 & 3. OpenCode Zen 요청 처리 (Zen Key 또는 무료 익명 풀) ---
    const zenApiKey = isZen ? clientKey : null;
    const { upstreamModel, variant } = parseModel(body.model);

    if (Array.isArray(body.input) && !Array.isArray(body.messages)) {
      const conv = [];
      for (const it of body.input) {
        if (it && it.type === 'message' && Array.isArray(it.content)) {
          const t = it.content.map(c => c.text || '').join('');
          conv.push({ role: it.role || 'user', content: t });
        } else if (it && it.type === 'function_call') {
          conv.push({ role: 'assistant', tool_calls: [{ id: it.call_id || '', type: 'function', function: { name: it.name || '', arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {}) } }] });
        } else if (it && it.type === 'function_call_output') {
          conv.push({ role: 'tool', tool_call_id: it.call_id || '', content: String(it.output ?? '') });
        } else if (it && it.role) {
          conv.push({ role: it.role, content: typeof it.content === 'string' ? it.content : Array.isArray(it.content) ? it.content.map(c => c.text || '').join('') : '' });
        }
      }
      const pre = typeof body.instructions === 'string' && body.instructions ? [{ role: 'system', content: body.instructions }] : [];
      let mb = applyVariant(applyMuseDefaults({ ...body, model: upstreamModel, messages: [...pre, ...conv] }, 'chat'), variant);
      delete mb.input; delete mb.instructions;
      const headersC = injectHeaders({ 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json' }, null, zenApiKey);
      try {
        const fr = await fetch(UPSTREAM + '/chat/completions', { method: 'POST', headers: headersC, body: JSON.stringify(mb), signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
        res.writeHead(fr.status === 200 ? 200 : fr.status, { 'Content-Type': fr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
        return res.end(await fr.text());
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: e.message } }));
      }
    }

        // Fast Circuit Breaker Check for Zen Key
    if (zenApiKey) {
      const cooling = isKeyCooling(zenApiKey);
      if (cooling) {
        const remainingSec = Math.ceil((cooling.cooldownUntil - Date.now()) / 1000);
        console.log(`[FastFail] ZenKey ${getKeyHash(zenApiKey)} cooling (${cooling.reason}), remaining ${remainingSec}s`);
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(remainingSec) });
        return res.end(JSON.stringify({ error: { message: `Zen Key is in cooldown (${cooling.reason}), retry in ${remainingSec}s`, type: 'rate_limit_exceeded' } }));
      }
    }
    let ub = applyMuseDefaults({ ...body, model: upstreamModel }, 'responses');
    if (/muse/i.test(upstreamModel)) ub.metadata = Object.assign({}, ub.metadata, { _nonce: crypto.randomUUID().slice(0, 12) });
    if (!/muse/i.test(upstreamModel)) ub = applyVariant(ub, variant);

    const upstreamBody = applyVariant(applyMuseDefaults({ ...body, model: upstreamModel }, 'chat'), variant);
    if (variant && /muse/i.test(upstreamModel)) delete upstreamBody.reasoning_effort, upstreamBody.reasoning = { effort: variant === 'minimal' ? 'low' : variant };

    const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': body.stream ? 'text/event-stream' : 'application/json' }, null, zenApiKey);
    headers['Cache-Control'] = 'no-store';

    try {
      let fetchRes;
      if (/muse/i.test(upstreamModel)) {
        fetchRes = await museViaResponses(upstreamModel, upstreamBody, variant, !!body.stream, zenApiKey);
        if (fetchRes.ok && body.stream) {
          if (zenApiKey) markKeySuccess(zenApiKey);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          if (res.flushHeaders) res.flushHeaders();
          await pumpResponsesSSEToChat(fetchRes.body, c => res.write(c));
          return res.end();
        }
        if (fetchRes.ok) {
          const cj = responsesToChatJson(await fetchRes.json(), upstreamModel);
          if (zenApiKey) markKeySuccess(zenApiKey);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(cj));
        }
      } else {
        fetchRes = await fetch(UPSTREAM + '/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
      }
      const bodyText = await fetchRes.text();
      let isErrPayload = !fetchRes.ok || (/"error":/i.test(bodyText) && !/"choices":/i.test(bodyText));

      if (zenApiKey) {
        checkAndMarkResponse(zenApiKey, fetchRes.status, bodyText);
      }

      // If Zen Key failed (AuthError or RateLimit) and we can transparently fallback to free anonymous session:
      if (isErrPayload && zenApiKey && (/AuthError|Invalid API key|FreeUsageLimitError|Rate limit/i.test(bodyText))) {
        console.log(`[Failover] ZenKey failed (${bodyText.slice(0, 80)}), transparently falling back to anonymous session...`);
        const anonHeaders = injectHeaders({ 'Content-Type': 'application/json', 'Accept': body.stream ? 'text/event-stream' : 'application/json' }, null, null);
        anonHeaders['Cache-Control'] = 'no-store';
        const anonRes = await fetch(UPSTREAM + '/chat/completions', { method: 'POST', headers: anonHeaders, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
        const anonText = await anonRes.text();
        res.writeHead(anonRes.status === 200 ? 200 : anonRes.status, { 'Content-Type': anonRes.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
        return res.end(anonText);
      }

      if (isErrPayload && fetchRes.status === 200) {
        const mappedStatus = /AuthError|Invalid API key/i.test(bodyText) ? 401 : /Rate limit|limit/i.test(bodyText) ? 429 : 500;
        res.writeHead(mappedStatus, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(bodyText);
      }

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        return res.end(bodyText);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(bodyText);
      }
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  // ============================================================
  // POST /v1/messages (Anthropic API 형식 3단 분기)
  // ============================================================
  if (req.method === 'POST' && pathname === '/v1/messages') {
    let body; const rawBody = Buffer.concat(chunks).toString('utf-8'); try { body = JSON.parse(rawBody || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } })); }
    applyMinTokens(body);
    if (!body.model) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'model required' } })); }
    
    const zenApiKey = isZen ? clientKey : null;
    const { upstreamModel, variant } = parseModel(body.model);
    // P21: Anthropic → OpenAI 정규화 (system/tool/image/tool_result)
    const anthMessages = anthropicMessagesToOpenAI(body);
    const anthTools = anthropicToolsToOpenAI(body.tools);
    const anthToolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);
    let openReq = {
      model: upstreamModel,
      messages: anthMessages,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: !!body.stream,
      stop: body.stop_sequences,
      ...(anthTools ? { tools: anthTools } : {}),
      ...(anthToolChoice ? { tool_choice: anthToolChoice } : {})
    };
    openReq = applyVariant(applyMuseDefaults(openReq, 'chat'), variant);
    const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': body.stream ? 'text/event-stream' : 'application/json' }, null, zenApiKey);
    
    try {
      let fetchRes;
      if (/muse/i.test(upstreamModel)) {
        const mfr = await museViaResponses(upstreamModel, openReq, variant, !!body.stream, zenApiKey);
        if (!mfr.ok) { const t = await mfr.text(); res.writeHead(mfr.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: t.slice(0, 500) } })); }
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          if (res.flushHeaders) res.flushHeaders();
          const aw = createAnthropicStreamWriter(c => res.write(c), upstreamModel, 0);
          await pumpResponsesSSEToAnthropic(mfr.body, aw);
          return res.end();
        }
        const cj = responsesToChatJson(await mfr.json(), upstreamModel);
        const choice = (cj.choices && cj.choices[0]) || {};
        const msg = choice.message || {};
        const contentBlocks = [];
        if (msg.reasoning_content) contentBlocks.push({ type: 'thinking', thinking: msg.reasoning_content });
        if (msg.content) contentBlocks.push({ type: 'text', text: msg.content });
        const anthRes = {
          id: cj.id?.replace('chatcmpl-', 'msg_') || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'message', role: 'assistant', model: upstreamModel,
          content: contentBlocks.length ? contentBlocks : [{ type: 'text', text: '' }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: cj.usage?.prompt_tokens || 0, output_tokens: cj.usage?.completion_tokens || 0 }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(anthRes));
      }

      fetchRes = await fetch(UPSTREAM + '/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(openReq), signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
      if (!fetchRes.ok) { const t = await fetchRes.text(); res.writeHead(fetchRes.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: t.slice(0, 500) } })); }

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        if (res.flushHeaders) res.flushHeaders();
        const aw = createAnthropicStreamWriter(c => res.write(c), upstreamModel, 0);
        await pumpChatSSEToAnthropic(fetchRes.body, aw);
        return res.end();
      }

      const openJson = await fetchRes.json();
      const choice = (openJson.choices && openJson.choices[0]) || {};
      const msg = choice.message || {};
      const contentBlocks = [];
      if (msg.reasoning_content) contentBlocks.push({ type: 'thinking', thinking: msg.reasoning_content });
      if (msg.content) contentBlocks.push({ type: 'text', text: msg.content });
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let parsedInput = {}; try { parsedInput = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          contentBlocks.push({ type: 'tool_use', id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`, name: tc.function?.name || '', input: parsedInput });
        }
      }
      const anthRes = {
        id: openJson.id?.replace('gen-', 'msg_') || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'message', role: 'assistant', model: openJson.model || upstreamModel,
        content: contentBlocks.length ? contentBlocks : [{ type: 'text', text: '' }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: openJson.usage?.prompt_tokens || 0, output_tokens: openJson.usage?.completion_tokens || 0 }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(anthRes));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }));
    }
  }

  // ============================================================
  // POST /v1/responses (OpenCode 독자 규격 Responses API)
  // ============================================================
  if (req.method === 'POST' && pathname === '/v1/responses') {
    let body; const rawBody = Buffer.concat(chunks).toString('utf-8'); try { body = JSON.parse(rawBody || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid JSON' } })); }
    if (/^kilo\//i.test(String(body.model || ''))) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'kilo models do not support the Responses API. Use /v1/chat/completions.' } })); }
    
    applyMinTokens(body);
    if (!body.model) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model required' } })); }
    
    const zenApiKey = isZen ? clientKey : null;
    const { upstreamModel, variant } = parseModel(body.model);
    let upstreamBody = applyMuseDefaults({ ...body, model: upstreamModel }, 'responses');
    if (/muse/i.test(upstreamModel)) {
      upstreamBody.metadata = Object.assign({}, upstreamBody.metadata, { _nonce: crypto.randomUUID().slice(0, 12) });
      if (variant) upstreamBody.reasoning = { effort: MUSE_EFFORT[variant] || 'high', summary: 'auto' };
    } else {
      upstreamBody = applyVariant(upstreamBody, variant);
    }
    // P20: /v1/responses passthrough 정규화 — Codex wire_api=responses 직접 호출 시
    // type:'text' 등이 그대로 가면 Zen이 input[N].content 400을 냄. skill.md §4 교훈.
    if (Array.isArray(upstreamBody.input)) upstreamBody.input = sanitizeResponsesInput(upstreamBody.input);
    if (Array.isArray(upstreamBody.instructions) && typeof upstreamBody.instructions === 'string') {
      // instructions는 문자열 그대로 유지 — 배열이면 이미 input으로 처리됨
    }

    const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': body.stream ? 'text/event-stream' : 'application/json' }, null, zenApiKey);
    try {
      const fr = await fetch(UPSTREAM + '/responses', { method: 'POST', headers: headers, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
      res.writeHead(fr.status === 200 ? 200 : fr.status, { 'Content-Type': fr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
      return res.end(await fr.text());
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Route ${req.method} ${pathname} not found` } }));
};

// === Netlify / AWS Lambda Handler Adapter ===
module.exports = handle;
module.exports.default = handle;
module.exports.handler = async function(event, context) {
  const http = require('http');
  const { EventEmitter } = require('events');

  // Netlify event -> Node req 어댑터
  const req = new EventEmitter();
  req.method = event.httpMethod || 'GET';
  const rawPath = event.rawUrl ? new URL(event.rawUrl).pathname : (event.path || '/');
  const qs = event.rawQuery ? `?${event.rawQuery}` : '';
  req.url = rawPath + qs;
  req.headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );

  return new Promise(resolve => {
    let resHeaders = {};
    let statusCode = 200;
    const bodyChunks = [];

    // Node res 어댑터
    const res = {
      headersSent: false,
      writeHead(code, headers = {}) {
        statusCode = code;
        resHeaders = { ...resHeaders, ...headers };
        this.headersSent = true;
      },
      setHeader(name, val) {
        resHeaders[name.toLowerCase()] = val;
      },
      getHeader(name) {
        return resHeaders[name.toLowerCase()];
      },
      write(chunk) {
        if (chunk) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      },
      end(chunk) {
        if (chunk) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const finalBody = Buffer.concat(bodyChunks).toString('utf-8');
        resolve({
          statusCode: statusCode,
          headers: resHeaders,
          body: finalBody
        });
      }
    };

    // 핸들러 실행
    Promise.resolve(handle(req, res)).catch(err => {
      resolve({
        statusCode: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: err.message } })
      });
    });

    // body 주입
    if (event.body) {
      const payload = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body);
      req.emit('data', payload);
    }
    req.emit('end');
  });
};