'use strict';

const UPSTREAM = 'https://opencode.ai/zen/v1';
const PROXY_API_KEY = ''; // set via wrangler secret PROXY_API_KEY if needed

const KNOWN_FREE_EXTRA = new Set(['big-pickle', 'grok-code']);
// P29/P30 (2026-09-12): zen /models 응답 자체엔 엔드포인트 호환성 메타데이터가 없다(id/object/created/
// owned_by뿐). 처음엔 "claude-*=messages, muse-spark*=responses, 나머지=chat" 이름 패턴으로 분류했는데,
// opencode 공식 문서(zen.mdx의 "Endpoints" 표)를 실제로 대조해보니 qwen*도 messages 전용이고 gemini-*는
// 셋 중 어디에도 안 속하는 별도 포맷(`/v1/models/{id}`, Google 네이티브)이었다 — 이 프로젝트가 가진 키는
// 전부 무결제라 qwen/gemini(둘 다 유료 전용, free 버전 없음)는 애초에 무료 필터에서 걸러져 이 오분류가
// 실사용엔 영향 없었지만, 정확한 근거로 바꾼다. zen.mdx 원본(마크다운 파이프 테이블, JS 렌더링 불필요)을
// fetch해서 파싱하고, 표에 없는 새 모델(문서가 API보다 며칠 뒤처질 수 있음 — 실제로 이 표엔
// muse-spark-1.2-contributor-free/deepseek-v4-flash-free가 빠져 있었다)에 한해서만 기존 이름 패턴
// 휴리스틱으로 폴백한다. 문서 fetch/파싱 자체가 실패하면 전부 휴리스틱으로 폴백.
const ZEN_DOCS_URL = 'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx';
const ZEN_ENDPOINT_MAP_TTL = 6 * 60 * 60 * 1000; // 문서는 자주 안 바뀌므로 6시간
let zenEndpointMapCache: Record<string, string> | null = null;
let zenEndpointMapCacheTime = 0;

async function getZenEndpointMap(): Promise<Record<string, string> | null> {
  const now = Date.now();
  if (zenEndpointMapCache && (now - zenEndpointMapCacheTime) < ZEN_ENDPOINT_MAP_TTL) return zenEndpointMapCache;
  try {
    const r = await fetch(ZEN_DOCS_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('zen.mdx fetch failed: HTTP ' + r.status);
    const text = await r.text();
    const m = text.match(/## Endpoints\n[\s\S]*?\n\| *Model[^\n]*\n\|[-\s|]+\n([\s\S]*?)\n\n/);
    if (!m) throw new Error('endpoint table not found in zen.mdx (markup changed?)');
    const map: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.length < 3 || !cells[1]) continue;
      const id = cells[1];
      const endpointUrl = cells[2].replace(/`/g, '');
      if (endpointUrl.endsWith('/v1/responses')) map[id] = 'responses';
      else if (endpointUrl.endsWith('/v1/chat/completions')) map[id] = 'chat';
      else if (endpointUrl.endsWith('/v1/messages')) map[id] = 'messages';
      else if (/\/v1\/models\//.test(endpointUrl)) map[id] = 'gemini-native';
    }
    if (Object.keys(map).length < 10) throw new Error('parsed suspiciously few rows (' + Object.keys(map).length + ')');
    zenEndpointMapCache = map;
    zenEndpointMapCacheTime = now;
    return map;
  } catch (e) {
    console.warn('[zen-endpoint-map] fetch/parse failed, falling back to name-pattern heuristic for all models:', (e as Error).message);
    return null;
  }
}

const MUSE_MODEL_RE = /^muse-spark/i;
const CLAUDE_MODEL_RE = /^claude-/i;
function classifyZenModelProtocol(id: string, endpointMap: Record<string, string> | null): string {
  const fromDocs = endpointMap && endpointMap[id];
  if (fromDocs) return fromDocs;
  if (MUSE_MODEL_RE.test(id)) return 'responses';
  if (CLAUDE_MODEL_RE.test(id)) return 'messages';
  return 'chat';
}
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

// === UncloseAI 프로바이더 (완전 무인증, OmniRoute registry authType:"optional"로 확인) ===
// 클라이언트가 어떤 키를 보내든(zen/kilo/없음) 무관하게 항상 사용 가능 — 업스트림이 키 자체를
// 요구하지 않는다(2026-09-12 실측: 키 없이 /v1/models·/v1/chat/completions 둘 다 200).
const UNCLOSEAI_BASE = 'https://hermes.ai.unturf.com';
let uncloseaiModelsCache = null;
let uncloseaiModelsCacheTime = 0;
async function getUncloseaiModels() {
  const now = Date.now();
  if (uncloseaiModelsCache && (now - uncloseaiModelsCacheTime) < 300000) return uncloseaiModelsCache;
  try {
    const r = await fetch(UNCLOSEAI_BASE + '/v1/models', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const nowSec = Math.floor(now / 1000);
    const list = (j.data || []).filter((m) => m && m.id).map((m) => ({ id: 'uncloseai/' + m.id, object: 'model', created: nowSec, owned_by: 'uncloseai' }));
    uncloseaiModelsCache = list; uncloseaiModelsCacheTime = now;
  } catch (e) { console.error('[uncloseai models] fail', String(e).slice(0, 80)); }
  return uncloseaiModelsCache || [];
}

// === Dahl 프로바이더 (managedAccount — 우리 프록시가 직접 토큰을 자체 발급/관리) ===
// dahl은 키를 미리 등록해두는 방식이 아니라, 아무 인증 없이 POST /tokens 한 번이면
// 즉시 토큰이 발급된다(가입/이메일 불필요, 2026-09-12 실측: available_tokens는 발급마다
// 동일한 100000000 고정값 — 실사용량 추적용이 아니라 사실상 무제한 표시로 보임). 그래서
// 각 노드(Vercel/Deno/로컬 인스턴스 하나하나)가 부팅 후 처음 요청이 왔을 때 스스로 토큰을
// 발급받아 메모리에 캐시해두면 되고, 우리 쪽에서 API 키를 미리 발급받아 env로 배포할 필요가
// 전혀 없다 — 노드가 완전히 자체관리한다. 토큰이 (아직 관찰되진 않았지만) 언젠가 무효화될
// 경우를 대비해, 실제 호출이 401/403을 받으면 캐시를 비우고 1회 재발급 후 재시도한다.
const DAHL_BASE = 'https://inference.dahl.global';
let dahlTokenCache = null;
let dahlTokenCacheTime = 0;
let dahlModelsCache = null;
let dahlModelsCacheTime = 0;
const DAHL_TOKEN_TTL = 6 * 60 * 60 * 1000; // 만료 정책이 불명이라 보수적으로 6시간마다 갱신
async function mintDahlToken() {
  const r = await fetch(DAHL_BASE + '/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('dahl token mint failed: HTTP ' + r.status);
  const j = await r.json();
  if (!j.token) throw new Error('dahl token mint returned no token');
  return j.token;
}
async function getDahlToken(forceNew) {
  const now = Date.now();
  if (!forceNew && dahlTokenCache && (now - dahlTokenCacheTime) < DAHL_TOKEN_TTL) return dahlTokenCache;
  const token = await mintDahlToken();
  dahlTokenCache = token; dahlTokenCacheTime = now;
  return token;
}
async function getDahlModels() {
  const now = Date.now();
  if (dahlModelsCache && (now - dahlModelsCacheTime) < 300000) return dahlModelsCache;
  try {
    const r = await fetch(DAHL_BASE + '/v1/models', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const nowSec = Math.floor(now / 1000);
    const list = (j.data || []).filter((m) => m && m.id).map((m) => ({ id: 'dahl/' + m.id, object: 'model', created: nowSec, owned_by: 'dahl' }));
    dahlModelsCache = list; dahlModelsCacheTime = now;
  } catch (e) { console.error('[dahl models] fail', String(e).slice(0, 80)); }
  return dahlModelsCache || [];
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
// P20 fix (2026-09-11): Codex wire_api=responses 직접 호출 시 /v1/responses
// passthrough 미정규화 + system/developer 배열형 AGENTS.md String 오염 +
// assistant 배열형 content 오염 함께 수정.
function normalizeMuseContentPart(x, role) {
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
    if (typeof x.text === 'string' && x.text) return { type: targetRole === 'assistant' ? 'output_text' : 'input_text', text: String(x.text) };
    if (typeof x.content === 'string' && x.content) return { type: targetRole === 'assistant' ? 'output_text' : 'input_text', text: String(x.content) };
  }
  return null;
}
function museToInput(messages) {
  const input = [];
  const seenCalls = new Set();   // P3 fix: duplicate function_call guard
  const seenOutputs = new Set(); // P3 fix: duplicate function_call_output guard
  for (const m of messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
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
      if (Array.isArray(m.content)) {
        const c = m.content.map(v => normalizeMuseContentPart(v, 'assistant')).filter(Boolean);
        if (c.length) input.push({ role: 'assistant', content: c });
      } else if (m.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: String(m.content) }] });
      } else if (!m.tool_calls) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: '' }] });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.id) { if (seenCalls.has(tc.id)) continue; seenCalls.add(tc.id); }
          let args = tc.function?.arguments ?? '{}';
          try { JSON.parse(args); } catch { args = '{}'; }
          input.push({ type: 'function_call', name: tc.function.name, call_id: tc.id, arguments: String(args) });
        }
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

function sanitizeResponsesInput(input) {
  if (!Array.isArray(input)) return input;
  const out = [];
  for (const it of input) {
    if (!it || typeof it !== 'object') continue;
    if (it.role) {
      const role = it.role;
      let content = it.content;
      if (typeof content === 'string') content = [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
      else if (!Array.isArray(content)) content = content ? [{ type: 'input_text', text: JSON.stringify(content) }] : [{ type: 'input_text', text: '' }];
      const norm = content.map(c => normalizeMuseContentPart(c, role)).filter(Boolean);
      const finalContent = norm.length ? norm : [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: '' }];
      out.push({ role, content: finalContent });
      continue;
    }
    if (it.type === 'function_call' || it.type === 'function_call_output') { out.push(it); continue; }
    if (it.type === 'message' && it.role) {
      const role = it.role;
      let content = it.content;
      if (typeof content === 'string') content = [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
      if (!Array.isArray(content)) content = [{ type: 'input_text', text: String(content ?? '') }];
      const norm = content.map(c => normalizeMuseContentPart(c, role)).filter(Boolean);
      out.push({ role, content: norm.length ? norm : [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: '' }] });
      continue;
    }
    if (it.type === 'reasoning' || it.type === 'custom_tool_call' || it.type === 'compaction' || it.type === 'item_reference') {
      console.warn('[sanitize] drop unsupported input item type=' + it.type);
      continue;
    }
    console.warn('[sanitize] drop unknown input item ' + JSON.stringify(it).slice(0, 160));
  }
  return out;
}

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
      if (b.input) blocks.push({ type: 'text', text: JSON.stringify(b.input) });
    } else if (b.type === 'thinking') continue;
    else if (b.type === 'input_text' || b.type === 'output_text') blocks.push({ type: 'text', text: b.text || '' });
    else if (b.type === 'image_url' && b.image_url) blocks.push(b);
    else if (typeof b.text === 'string') blocks.push({ type: 'text', text: b.text });
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
        if (blocks.length === 1 && blocks[0].type === 'text' && toolResults.length === 0) out.push({ role: 'user', content: blocks[0].text });
        else out.push({ role: 'user', content: blocks });
      } else if (toolResults.length === 0) out.push({ role: 'user', content: String(m.content ?? '') });
      for (const tr of toolResults) out.push(tr);
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') out.push({ role: 'assistant', content: m.content });
      else if (Array.isArray(m.content)) {
        const texts = [];
        const toolCalls = [];
        for (const b of m.content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text') texts.push(b.text || '');
          else if (b.type === 'tool_use') toolCalls.push({ id: b.id || `call_${crypto.randomUUID().slice(0,8)}`, type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) } });
          else if (b.type === 'thinking') continue;
          else if (typeof b.text === 'string') texts.push(b.text);
        }
        const content = texts.join('\n') || null;
        if (toolCalls.length) out.push({ role: 'assistant', content, tool_calls: toolCalls });
        else out.push({ role: 'assistant', content: content || '' });
      } else out.push({ role: 'assistant', content: String(m.content ?? '') });
    } else if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      out.push({ role: 'system', content: text });
    } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.tool_call_id || m.tool_use_id || '', content: String(m.content ?? '') });
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

const MUSE_EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

// P23 fix (2026-09-11): 콜론 접미사(":high") 없이 클라이언트가 실제로 보낸
// reasoning_effort/reasoning.effort/thinking을 muse 경로가 전부 무시하고 무조건
// 'low'로 깔던 문제. api/index.js와 동일 로직 이식.
function effortFromClientBody(body) {
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort) return body.reasoning_effort;
  if (typeof body.reasoningEffort === 'string' && body.reasoningEffort) return body.reasoningEffort;
  if (body.reasoning && typeof body.reasoning.effort === 'string' && body.reasoning.effort) return body.reasoning.effort;
  return null;
}
function estimateTokens(str) { return Math.ceil(String(str || '').length / 4); }
function totalPromptTokensForMessages(messages, instructions) {
  let t = 0;
  if (instructions) t += estimateTokens(instructions);
  for (const m of messages || []) {
    t += estimateTokens(JSON.stringify(m.content || '')) + estimateTokens(m.role || '') + 10;
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) t += estimateTokens(JSON.stringify(tc)) + 10;
  }
  return t;
}
function totalPromptTokensForInput(input, instructions) {
  let t = 0;
  if (instructions) t += estimateTokens(instructions);
  for (const it of input || []) {
    if (it.role) t += estimateTokens(JSON.stringify(it.content || '')) + 10;
    else if (it.type === 'function_call' || it.type === 'function_call_output') t += estimateTokens(JSON.stringify(it)) + 10;
    else t += estimateTokens(JSON.stringify(it)) + 10;
  }
  return t;
}
function truncateMessagesIfNeeded(messages, instructions, maxTokens) {
  const MAX = maxTokens || parseInt(process.env.PROMPT_MAX_TOKENS || '700000', 10);
  if (!Array.isArray(messages) || !messages.length) return messages;
  let total = totalPromptTokensForMessages(messages, instructions);
  if (total <= MAX) return messages;
  const systemMsgs = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const otherMsgs = messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  const keptOther = [];
  let keptTokens = totalPromptTokensForMessages(systemMsgs, instructions);
  for (let i = otherMsgs.length - 1; i >= 0; i--) {
    const cand = otherMsgs[i];
    const candTokens = estimateTokens(JSON.stringify(cand.content || '')) + 10 + (Array.isArray(cand.tool_calls) ? estimateTokens(JSON.stringify(cand.tool_calls)) : 0);
    if (keptTokens + candTokens > MAX) {
      if (cand.role === 'tool') {
        const hasPair = keptOther.some(k => k.role === 'assistant' && Array.isArray(k.tool_calls) && k.tool_calls.some(tc => tc.id === cand.tool_call_id));
        if (!hasPair) continue;
      }
      if (keptTokens + candTokens > MAX) continue;
    }
    keptOther.unshift(cand);
    keptTokens += candTokens;
    if (keptTokens >= MAX) break;
  }
  const truncated = [...systemMsgs, ...keptOther];
  console.log(`[truncate] messages ${messages.length}→${truncated.length} tokens ${total}→${keptTokens} (max ${MAX})`);
  return truncated;
}
function truncateInputIfNeeded(input, instructions, maxTokens) {
  const MAX = maxTokens || parseInt(process.env.PROMPT_MAX_TOKENS || '700000', 10);
  if (!Array.isArray(input) || !input.length) return input;
  let total = totalPromptTokensForInput(input, instructions);
  if (total <= MAX) return input;
  const devItems = input.filter(it => it.role === 'developer');
  const otherItems = input.filter(it => it.role !== 'developer');
  const keptOther = [];
  let keptTokens = totalPromptTokensForInput(devItems, instructions);
  for (let i = otherItems.length - 1; i >= 0; i--) {
    const cand = otherItems[i];
    const candTokens = estimateTokens(JSON.stringify(cand)) + 10;
    if (keptTokens + candTokens > MAX) continue;
    keptOther.unshift(cand);
    keptTokens += candTokens;
  }
  const truncated = [...devItems, ...keptOther];
  console.log(`[truncate] input ${input.length}→${truncated.length} tokens ${total}→${keptTokens} (max ${MAX})`);
  return truncated;
}

function effortFromThinking(thinking) {
  if (!thinking || thinking.type !== 'enabled') return null;
  const bt = Number(thinking.budget_tokens) || 0;
  if (bt <= 4000) return 'low';
  if (bt <= 12000) return 'medium';
  return 'high';
}

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
    const isNativeProtocolPrefix = pathname.startsWith('/res/') || pathname.startsWith('/chat/') || pathname.startsWith('/mes/') || pathname.startsWith('/kilo/');
    if ((pathname.startsWith('/v1/') || isNativeProtocolPrefix) && !authOk(request, env)) {
      return json({ error: { type: 'authentication_error', message: 'Invalid API key' } }, 401);
    }

    // 2026-09-11 설계 전환 (api/index.js와 동일): 프로토콜 변환 대신 모델이 실제로
    // 지원하는 네이티브 엔드포인트로만 라우팅한다. bifrost에 res/chat/mes 세
    // 프로바이더로 등록해서 모델별로 동작하는 엔드포인트만 쓰도록 강제 — 바디를
    // 건드리지 않는 순수 passthrough라 변환 버그(P3/P9/P14/P20/P21/P23) 계열이
    // 구조적으로 발생할 수 없다.
    if (request.method === 'GET' && (pathname === '/res/v1/models' || pathname === '/chat/v1/models' || pathname === '/mes/v1/models')) {
      try {
        const headers = injectHeaders({ 'Content-Type': 'application/json' });
        const fr = await fetch(UPSTREAM + '/models', { method: 'GET', headers });
        if (!fr.ok) {
          const text = await fr.text();
          return new Response(text, { status: fr.status, headers: { ...CORS, 'Content-Type': fr.headers.get('content-type') || 'application/json' } });
        }
        // 나머지 프록시 전체가 무료 모델만 노출하는 것과 맞춰(getFreeModelsExpanded와 동일 기준),
        // 이 native passthrough GET /models도 응답 바디에서 유료 모델을 걸러내고 반환한다. id는
        // CLIProxyAPI 등이 그대로 참조하는 zen 네이티브 id라 opencode/ 접두사는 붙이지 않는다.
        // P29/P30: 추가로 이 경로가 실제 지원하는 프로토콜에 맞는 모델만 남긴다(res→responses 전용,
        // mes→messages 전용, chat→chat/completions 전용) — 안 그러면 세 라우트가 전부 동일한 전체
        // 목록을 반환해서 클라이언트가 실제로 동작 안 하는 엔드포인트의 모델을 골라버리는 문제가 있었다.
        // 분류는 zen 공식 문서(zen.mdx)에서 동적으로 가져오고, 문서에 없는 모델만 이름 패턴으로 폴백한다.
        const endpointMap = await getZenEndpointMap();
        const upstreamJson = await fr.json();
        const filtered = Array.isArray(upstreamJson.data)
          ? upstreamJson.data.filter((m) => {
              if (!m || !m.id || !(m.id.endsWith('-free') || KNOWN_FREE_EXTRA.has(m.id))) return false;
              const proto = classifyZenModelProtocol(m.id, endpointMap);
              if (pathname === '/res/v1/models') return proto === 'responses';
              if (pathname === '/mes/v1/models') return proto === 'messages';
              return proto === 'chat'; // /chat/v1/models — gemini-native/unknown은 어느 라우트에도 안 냄
            })
          : [];
        return json({ ...upstreamJson, data: filtered }, 200);
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    // Kilo Gateway는 zen과 완전히 별개 서비스라 UPSTREAM(zen) 기반 passthrough 그룹에 못 낀다.
    // /res|chat|mes와 같은 원칙(네이티브 엔드포인트로 바디 최소 변형 전달)으로 Kilo 전용 라우트를
    // 별도로 둔다 — 모델 리스트는 무료만(getKiloFreeModels 재사용, 접두사만 벗김).
    if (request.method === 'GET' && pathname === '/kilo/v1/models') {
      try {
        const kiloModels = await getKiloFreeModels();
        const data = kiloModels.map((m) => ({ ...m, id: m.id.replace(/^kilo\//, '') }));
        return json({ object: 'list', data });
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    const NATIVE_PASSTHROUGH_ROUTES = {
      '/res/v1/responses': '/responses',
      '/chat/v1/chat/completions': '/chat/completions',
      '/mes/v1/messages': '/messages',
    };
    if (request.method === 'POST' && NATIVE_PASSTHROUGH_ROUTES[pathname]) {
      const rawText = await request.text();
      let pbody; try { pbody = JSON.parse(rawText || '{}'); } catch { return json({ error: { message: 'Invalid JSON' } }, 400); }
      if (!pbody.model) return json({ error: { message: 'model required' } }, 400);
      const isStream = !!pbody.stream;
      const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' });
      // /res/v1/responses는 순수 passthrough(바디 무변형)가 원칙이지만, muse 계열에서 100% 확정적으로
      // 실패하는 두 가지 케이스만 최소 개입으로 방어한다(res/chat/mes 설계 원칙과 같은 성격의 예외, P24/P28):
      let outText = rawText;
      let patched = null;
      if (pathname === '/res/v1/responses') {
        // 1) zen은 tools[].type: "image_generation"을 아예 지원하지 않아 항상 400을 낸다. CLIProxyAPI의
        //    codex 실행기가 muse-spark 계열 /responses 호출에 이 tool을 기본으로 자동 주입해서 발생
        //    (클라이언트가 직접 보낸 tools엔 없음) — 이 tool 타입이 섞여 있을 때만 그것만 제거한다.
        if (Array.isArray(pbody.tools) && pbody.tools.some((t) => t && t.type === 'image_generation')) {
          patched = patched || { ...pbody };
          const filtered = patched.tools.filter((t) => !(t && t.type === 'image_generation'));
          patched.tools = filtered;
          if (!filtered.length) delete patched.tools;
          console.warn('[compat] /res/v1/responses: stripped unsupported image_generation tool before forwarding to zen');
        }
        // 2) muse는 실제 출력 전에 내부 reasoning으로 먼저 토큰을 소모한다. 클라이언트가 짧은 답변을
        //    기대하고 max_output_tokens를 작게(예: 64) 보내면 reasoning만으로 예산이 다 소진돼
        //    output:[]로 "성공"(200) 응답하는 채로 끝난다(P28 — OmniRoute 등 직접 호출 클라이언트에서
        //    실측 재현: incomplete_details.reason:"max_output_tokens", output:[]). 레거시 변환 경로의
        //    applyMuseDefaults()가 강제하던 131072 하한을 여기서도 동일하게 적용.
        if (/muse/i.test(String(pbody.model || ''))) {
          const reqMax = Number((patched || pbody).max_output_tokens) || 0;
          if (reqMax < 131072) {
            patched = patched || { ...pbody };
            patched.max_output_tokens = Math.max(131072, reqMax);
            console.warn('[compat] /res/v1/responses: raised max_output_tokens to 131072 floor for muse model (reasoning budget)');
          }
        }
      }
      if (patched) outText = JSON.stringify(patched);
      try {
        const fr = await fetch(UPSTREAM + NATIVE_PASSTHROUGH_ROUTES[pathname], { method: 'POST', headers, body: outText });
        const ct = fr.headers.get('content-type') || 'application/json';
        if (isStream && ct.includes('text/event-stream')) {
          return new Response(fr.body, { status: fr.status, headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
        }
        const text = await fr.text();
        return new Response(text, { status: fr.status, headers: { ...CORS, 'Content-Type': ct } });
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    if (request.method === 'POST' && pathname === '/kilo/v1/chat/completions') {
      const rawText = await request.text();
      let pbody; try { pbody = JSON.parse(rawText || '{}'); } catch { return json({ error: { message: 'Invalid JSON' } }, 400); }
      if (!pbody.model) return json({ error: { message: 'model required' } }, 400);
      const realModel = String(pbody.model).replace(/^kilo\//i, '');
      let msgs = Array.isArray(pbody.messages) ? pbody.messages : [];
      if (!msgs.length && Array.isArray(pbody.input)) {
        msgs = pbody.input.map((i) => ({ role: i.role || 'user', content: typeof i.content === 'string' ? i.content : Array.isArray(i.content) ? i.content.map((c) => c.text || '').join('') : '' }));
      }
      const isStream = !!pbody.stream;
      const kHeaders = { 'Content-Type': 'application/json', Accept: isStream ? 'text/event-stream' : 'application/json' };
      const clientAuth = request.headers.get('authorization');
      if (clientAuth) kHeaders.Authorization = clientAuth;
      // Kilo가 라우팅하는 모델(예: kilo-auto)에 자체적으로 reasoning.effort를 강제 배정해서
      // 클라이언트가 보낸 reasoning_effort와 충돌하면 400을 낸다(P17) — 이 전용 경로도 동일 방어.
      const kiloBody = { ...pbody, model: realModel, messages: msgs };
      delete kiloBody.reasoning_effort;
      delete kiloBody.reasoningEffort;
      try {
        const kr = await fetch(KILO_BASE + '/chat/completions', { method: 'POST', headers: kHeaders, body: JSON.stringify(kiloBody) });
        if (isStream && kr.ok) {
          return new Response(kr.body, { status: 200, headers: { ...CORS, 'Content-Type': kr.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' } });
        }
        return new Response(await kr.text(), { status: kr.status, headers: { ...CORS, 'Content-Type': kr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    if (request.method === 'GET' && pathname === '/v1/models') {
      try {
        let data = await getFreeModelsExpanded();
        try { data = data.concat(await getKiloFreeModels()); } catch {}
        // uncloseai/dahl은 kilo/zen 키 체계와 무관하게 항상 무인증으로 동작하므로 항상 추가한다.
        try { data = data.concat(await getUncloseaiModels()); } catch {}
        try { data = data.concat(await getDahlModels()); } catch {}
        data.sort((a, b) => a.id.localeCompare(b.id));
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

    const { upstreamModel, variant: rawVariant } = parseModel(body.model);
    const isMuse = /muse/i.test(upstreamModel);
    const isStream = !!body.stream;
    // 대형 프롬프트 빈 choices 방지 — chat/responses 공용 트렁케이트 (messages는 변환 후 별도)
    if (Array.isArray(body.messages)) body.messages = truncateMessagesIfNeeded(body.messages, body.instructions || body.system);
    if (Array.isArray(body.input)) body.input = truncateInputIfNeeded(body.input, body.instructions);
    // P23: 콜론 접미사가 최우선, 없으면 thinking -> reasoning_effort/reasoning.effort 순.
    const variant = rawVariant || effortFromThinking(body.thinking) || effortFromClientBody(body);

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
      // === UncloseAI/Dahl 모델 (uncloseai/, dahl/ 접두사) — kilo/zen 키 체계와 완전
      // 무관하게 직접 포워드. 클라이언트가 보낸 Authorization은 무시하고 각 업스트림에
      // 맞는 인증을 여기서 직접 구성한다(uncloseai는 무인증, dahl은 우리가 자체 발급한 토큰). ===
      if (/^(uncloseai|dahl)\//i.test(String(body.model || ''))) {
        const isDahl = /^dahl\//i.test(String(body.model || ''));
        const realModel = String(body.model).replace(/^(uncloseai|dahl)\//i, '');
        const upstreamBase = isDahl ? DAHL_BASE : UNCLOSEAI_BASE;
        const uHeaders = { 'Content-Type': 'application/json', Accept: isStream ? 'text/event-stream' : 'application/json' };
        let ur;
        for (let attempt = 0; attempt < (isDahl ? 2 : 1); attempt++) {
          if (isDahl) uHeaders.Authorization = `Bearer ${await getDahlToken(attempt > 0)}`;
          ur = await fetch(upstreamBase + '/v1/chat/completions', { method: 'POST', headers: uHeaders, body: JSON.stringify({ ...body, model: realModel }) });
          // dahl 토큰이 (관찰된 적은 없지만) 무효화됐을 가능성에 대비: 인증 실패면 재발급 1회 재시도
          if (isDahl && (ur.status === 401 || ur.status === 403) && attempt === 0) continue;
          break;
        }
        if (isStream && ur.ok) {
          return new Response(ur.body, { status: 200, headers: { ...CORS, 'Content-Type': ur.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' } });
        }
        return new Response(await ur.text(), { status: ur.status, headers: { ...CORS, 'Content-Type': ur.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
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
        // P23 fix: flat reasoning_effort fallback, but avoid duplicate when body already has reasoning object
        // Use rawVariant (colon suffix only) — global variant already includes thinking/clientBody and would bypass the body.reasoning check
        const effectiveVariant = rawVariant || (body.reasoning ? null : effortFromClientBody(body));
        let upstreamBody = applyMuseDefaults({ ...body, model: upstreamModel }, 'responses');
        if (isMuse) {
          upstreamBody.metadata = Object.assign({}, upstreamBody.metadata, { _nonce: crypto.randomUUID().slice(0, 12) });
          if (effectiveVariant) {
            delete upstreamBody.reasoning_effort; delete upstreamBody.reasoningEffort;
            upstreamBody.reasoning = Object.assign({}, upstreamBody.reasoning, { effort: effectiveVariant === 'minimal' ? 'low' : (['low', 'medium', 'high'].includes(effectiveVariant) ? effectiveVariant : 'high'), summary: (upstreamBody.reasoning || {}).summary || 'auto' });
          } else if (upstreamBody.reasoning) {
            delete upstreamBody.reasoning_effort; delete upstreamBody.reasoningEffort;
          }
        } else {
          upstreamBody = applyVariant(upstreamBody, effectiveVariant);
        }
        if (Array.isArray(upstreamBody.input)) upstreamBody.input = sanitizeResponsesInput(upstreamBody.input);
        const r = await forward('/responses', upstreamBody, isStream);
        return forwardStreamOrJson(r, isStream);
      }

      if (pathname === '/v1/messages') {
        let anthMessages = anthropicMessagesToOpenAI(body);
        anthMessages = truncateMessagesIfNeeded(anthMessages, body.system);
        const anthTools = anthropicToolsToOpenAI(body.tools);
        const anthToolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);
        const openReq = { model: upstreamModel, messages: anthMessages, max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p, stream: !!body.stream, stop: body.stop_sequences, ...(anthTools?{tools:anthTools}:{}), ...(anthToolChoice?{tool_choice:anthToolChoice}:{}) };
        const full = applyVariant(applyMuseDefaults(openReq, 'chat'), variant);
        if (variant && isMuse) full.reasoning = { effort: variant === 'minimal' ? 'low' : (['low', 'medium', 'high'].includes(variant) ? variant : 'high') };
        let r;
        if (/^kilo\//i.test(String(full.model || ''))) {
          const kBody = { ...full, model: String(full.model).replace(/^kilo\//i, '') };
          delete kBody.reasoning_effort; delete kBody.reasoningEffort;
          if (variant && !String(kBody.model).includes(':')) kBody.model += ':' + variant;
          const kr = await fetch(KILO_BASE + '/chat/completions', { method: 'POST', headers: injectHeaders({ 'Content-Type': 'application/json', Accept: isStream ? 'text/event-stream' : 'application/json' }), body: JSON.stringify(kBody) });
          r = new Response(await kr.text(), { status: kr.status, headers: { 'Content-Type': kr.headers.get('content-type') || 'application/json' } });
        } else if (isMuse) {
          // P21-fix (2026-09-11): muse-spark는 /chat/completions를 지원하지 않아
          // (P9 등, upstream이 빈 응답/500을 반환) /responses로 우회해야 한다.
          // api/index.js는 이 분기가 있었는데 deno 포팅 시 누락돼 muse 모델 +
          // /v1/messages 조합이 전부 500(Internal server error)으로 깨졌었다.
          // museChatResponse가 이미 /responses 왕복 + OpenAI chat.completion(.chunk)
          // 형태 변환을 다 처리하므로 그대로 재사용 — 아래 공통 경로(SSE 그대로
          // 포워드 / JSON 파싱 후 Anthropic 변환)가 동일하게 적용된다.
          r = await museChatResponse(upstreamModel, full, variant, isStream);
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
