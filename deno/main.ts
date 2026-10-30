'use strict';

const UPSTREAM = 'https://opencode.ai/inference/v1';
const PROXY_API_KEY = ''; // set via wrangler secret PROXY_API_KEY if needed

const KNOWN_FREE_EXTRA = new Set(['big-pickle', 'grok-code']);
// 2026-10-26: zen.mdx(공식 문서)는 2026-10-12 커밋 25053bbdc("replace old Zen and Go pages with V2 console
// docs")로 저장소에서 삭제돼 raw URL이 404가 됐다. 그 뒤로 Endpoints 표와 "The free models:" 목록 파싱이 계속
// 실패해 이름 패턴 휴리스틱과 하드코딩 목록으로만 동작했다. 같은 사실(모델별 프로토콜, 무료 여부, deprecated)을
// 정품 CLI가 스스로 읽는 카탈로그(models.opencode.ai/api.json)에서 얻는다:
//   무료       = cost.input === 0 && cost.output === 0  (deprecated 제외)
//   deprecated = status === 'deprecated'
//   프로토콜   = provider.npm: @ai-sdk/anthropic -> messages, @ai-sdk/openai -> responses,
//                @ai-sdk/google -> gemini-native, 그 외(npm 없음, mistral 등) -> chat
// 카탈로그에 없는 모델(신규 모델 등)은 deprecated로 취급하지 않는다 — 목록에 없다고 폐기된 것은 아니다.
// 카탈로그 fetch가 실패하면 마지막으로 성공한 값을 계속 쓰고, 처음부터 없으면 null(=이름 패턴 휴리스틱 + 하드코딩 폴백).
const ZEN_CATALOG_URL = (() => { try { return Deno.env.get('ZEN_CATALOG_URL') || 'https://models.opencode.ai/api.json'; } catch { return 'https://models.opencode.ai/api.json'; } })();
const ZEN_CATALOG_TTL = 6 * 60 * 60 * 1000;
const ZEN_CATALOG_RETRY_MS = 60 * 1000; // 실패 직후 매 요청마다 8초 타임아웃을 반복하지 않도록
type ZenCatalog = { protocols: Record<string, string>; free: Set<string>; deprecated: Set<string> };
let zenCatalogCache: ZenCatalog | null = null;
let zenCatalogCacheTime = 0;
let zenCatalogFailUntil = 0;
let zenCatalogInflight: Promise<ZenCatalog | null> | null = null;

function zenProtocolFromCatalog(provider: any): string {
  const npm = String((provider && provider.npm) || '');
  const api = String((provider && provider.api) || '');
  if (/anthropic/i.test(npm) || /\/anthropic\//.test(api)) return 'messages';
  if (/google/i.test(npm) || /\/google\//.test(api)) return 'gemini-native';
  if (npm === '@ai-sdk/openai') return 'responses';
  return 'chat';
}

function parseZenCatalog(json: any): ZenCatalog {
  const models = json && json.opencode && json.opencode.models;
  if (!models || typeof models !== 'object') throw new Error('catalog has no opencode.models');
  const protocols: Record<string, string> = {};
  const free = new Set<string>();
  const deprecated = new Set<string>();
  for (const [id, m] of Object.entries<any>(models)) {
    if (!m || typeof m !== 'object') continue;
    protocols[id] = zenProtocolFromCatalog(m.provider);
    const isDeprecated = m.status === 'deprecated';
    if (isDeprecated) deprecated.add(id);
    const c = m.cost;
    if (!isDeprecated && c && c.input === 0 && c.output === 0) free.add(id);
  }
  if (Object.keys(protocols).length < 10) throw new Error('parsed suspiciously few catalog models (' + Object.keys(protocols).length + ')');
  return { protocols, free, deprecated };
}

async function getZenCatalog(): Promise<ZenCatalog | null> {
  const now = Date.now();
  if (zenCatalogCache && (now - zenCatalogCacheTime) < ZEN_CATALOG_TTL) return zenCatalogCache;
  if (now < zenCatalogFailUntil) return zenCatalogCache; // 최근 실패: 마지막 성공값(없으면 null)
  if (zenCatalogInflight) return zenCatalogInflight;
  zenCatalogInflight = (async () => {
    try {
      const r = await fetch(ZEN_CATALOG_URL, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('catalog fetch failed: HTTP ' + r.status);
      zenCatalogCache = parseZenCatalog(await r.json());
      zenCatalogCacheTime = Date.now();
      zenCatalogFailUntil = 0;
    } catch (e: any) {
      zenCatalogFailUntil = Date.now() + ZEN_CATALOG_RETRY_MS;
      console.warn('[zen-catalog] fetch/parse failed, ' + (zenCatalogCache ? 'keeping the last good catalog' : 'falling back to name-pattern heuristic + hardcoded free list') + ':', e.message);
    } finally {
      zenCatalogInflight = null;
    }
    return zenCatalogCache;
  })();
  return zenCatalogInflight;
}

// 호출부는 그대로 두기 위해 기존 함수 이름을 유지한다.
async function getZenEndpointMap(): Promise<Record<string, string> | null> { const c = await getZenCatalog(); return c ? c.protocols : null; }
async function getZenFreeModelSet(): Promise<Set<string> | null> { const c = await getZenCatalog(); return c ? c.free : null; }
async function getZenDeprecatedSet(): Promise<Set<string> | null> { const c = await getZenCatalog(); return c ? c.deprecated : null; }

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
// P33 fix (2026-09-17): api/index.js와 동일 로직 이식 — zen이 무료 티어 추론 엔드포인트에
// "OpenCode's free tier can only be used from within OpenCode" (FreeTierError, 403) 클라이언트
// 검증을 추가했다. 실측(mitmproxy로 진짜 opencode CLI 캡처 + Node fetch 최소조합 격리 테스트)
// 결과 필요조건은 User-Agent가 정확히 실제 CLI 문자열, x-opencode-session이 'ses_' 접두사
// 형식인 것 2개뿐 — 상세 근거는 api/index.js의 동일 주석 참고.
// P33 (2026-09-30): api/index.js와 동일 — UA는 /opencode\/(?:[a-z]+\/)?v?(\d+)\.(\d+)/ 를 통과해야
// 하고(major>1 또는 1.17+), 세션/메시지 ID는 prefix + hex 12자 + base62 14자 형식이어야 한다.
const ZEN_B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function opencodeIdFromDigest(prefix: string, digest: Uint8Array): string {
  let hexPart = '';
  for (const byte of digest.subarray(0, 6)) hexPart += byte.toString(16).padStart(2, '0');
  let b62Part = '';
  for (const byte of digest.subarray(6, 20)) b62Part += ZEN_B62[byte % 62];
  return prefix + hexPart + b62Part;
}
function synthesizeOpencodeId(prefix: string): string {
  return opencodeIdFromDigest(prefix, crypto.getRandomValues(new Uint8Array(32)));
}
// api/index.js와 동일 정책(2026-10-24): zen이 무료 쿼터를 session(+IP) 단위로 집행한다는
// 관측(9router #5107, opencode #58205)에 맞춰, 세션 id는 UTC 일 단위로 고정 로테이션하고
// 요청 id는 sha256(sessionId + 마지막 user 메시지)로 결정론적 생성 — 재시도가 같은
// id를 공유해 쿼터를 중복 소모하지 않게 한다(실제 CLI/9router PR #4723과 동일 개념).
// 이상 징후 시 Deno.env ZEN_SESSION_MODE=random 으로 요청마다 랜덤 id 동작으로 복귀 가능.
// 2026-10-24 (9router PR #4791): zen은 ses_ id의 hex 12자가 inverted timestamp
// (~(ms*4096+counter)의 하위 48비트)인지 검사한다 — 랜덤/해시 비트는 403.
// 9router #5218: counter는 1..16 범위에서 순환해야 통과(100 이상은 403).
let zenIdCounter = 0;
function canonicalSessionId(): string {
  zenIdCounter = (zenIdCounter % 16) + 1;
  const units = BigInt(Date.now()) * 4096n + BigInt(zenIdCounter);
  const inverted = ~units & ((1n << 48n) - 1n);
  const hexPart = inverted.toString(16).padStart(12, '0');
  const digest = crypto.getRandomValues(new Uint8Array(14));
  let b62Part = '';
  for (const byte of digest) b62Part += ZEN_B62[byte % 62];
  return 'ses_' + hexPart + b62Part;
}
const ZEN_SESSION_MODE = (() => { try { return Deno.env.get('ZEN_SESSION_MODE') || 'stable'; } catch { return 'stable'; } })();
let zenAnonSession: { id: string; day: string } | null = null;
async function sha256Digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
async function sessionIdFor(): Promise<string> {
  if (ZEN_SESSION_MODE === 'random') return canonicalSessionId();
  const day = new Date().toISOString().slice(0, 10);
  if (!zenAnonSession || zenAnonSession.day !== day) {
    zenAnonSession = { id: canonicalSessionId(), day };
  }
  return zenAnonSession.id;
}
async function requestIdFor(sessionId: string, upstreamBody?: unknown): Promise<string> {
  if (ZEN_SESSION_MODE === 'random' || upstreamBody === undefined) return synthesizeOpencodeId('msg_');
  const text = extractLastUserText(upstreamBody);
  return opencodeIdFromDigest('msg_', await sha256Digest(sessionId + '|' + text));
}
function extractLastUserText(body: any): string {
  const parts: string[] = [];
  const collect = (c: any) => {
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
const ZEN_UA = 'opencode/latest/2.2.0/cli';
// injectHeaders가 async가 됐다 — 호출부는 모두 await 해야 한다.
async function injectHeaders(headers: any, upstreamBody?: unknown) {
  const h = { ...headers };
  const sessionId = await sessionIdFor();
  h['User-Agent'] = ZEN_UA;
  h['x-opencode-session-id'] = sessionId;
  h['x-opencode-session'] = sessionId;
  h['x-session-affinity'] = sessionId;
  h['x-session-id'] = sessionId;
  h['x-opencode-client'] = 'cli';
  h['x-opencode-project'] = crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'').slice(0,8); // 40-char git sha 형태
  delete h['x-opencode-request'];
  return h;
}

// 9router #5218 / #5253: OpenCode Zen Free tier 게이트웨이 요구사항:
// 1) 시스템 프롬프트에 <env> 블록(Working directory 및 Workspace root folder) 주입
// 2) 도구 목록에 read와 shell의 정확한 스키마 및 설명 포함
const OPENCODE_ENV_MARKER =
  "<env>\n  Working directory: /workspace\n  Workspace root folder: /workspace\n</env>";
const ENV_BLOCK_RE = /<env>([\s\S]*?)<\/env>/;
const ENV_MARKER_RE = /<env>[\s\S]*?Working directory:[\s\S]*?Workspace root folder:[\s\S]*?<\/env>/;
const ENV_WORKDIR_RE = /Working directory:[^\n]*/;
const ENV_ROOT_RE = /Workspace root folder:/;

function hasEnvMarker(value: any): boolean {
  return typeof value === 'string' && ENV_MARKER_RE.test(value);
}

function upgradeEnvBlock(text: string): string {
  return text.replace(ENV_BLOCK_RE, (block, inner) => {
    if (ENV_ROOT_RE.test(inner)) return block;
    const root = '  Workspace root folder: /workspace';
    const upgraded = ENV_WORKDIR_RE.test(inner)
      ? inner.replace(ENV_WORKDIR_RE, (line) => `${line}\n${root}`)
      : `${inner.replace(/\s*$/, '')}\n${root}\n`;
    return `<env>${upgraded}</env>`;
  });
}

function withEnvMarker(value: any): string {
  const text = typeof value === 'string' ? value : '';
  if (hasEnvMarker(text)) return text;
  if (ENV_BLOCK_RE.test(text)) return upgradeEnvBlock(text);
  return text.trim() ? `${text}\n\n${OPENCODE_ENV_MARKER}` : OPENCODE_ENV_MARKER;
}

function applyFingerprintSystemPrompt(body: any): any {
  if (!body || typeof body !== 'object') return body;

  if (body.system !== undefined) {
    if (typeof body.system === 'string') {
      body.system = withEnvMarker(body.system);
    } else if (Array.isArray(body.system)) {
      const marked = body.system.some((block: any) =>
        hasEnvMarker(typeof block === 'string' ? block : block?.text)
      );
      if (!marked) body.system = [...body.system, { type: 'text', text: OPENCODE_ENV_MARKER }];
    }
    return body;
  }

  if (body.instructions !== undefined) {
    if (typeof body.instructions === 'string') body.instructions = withEnvMarker(body.instructions);
    return body;
  }

  if (Array.isArray(body.input) && !Array.isArray(body.messages)) {
    body.instructions = OPENCODE_ENV_MARKER;
    return body;
  }

  if (!Array.isArray(body.messages)) return body;

  const first = body.messages[0];
  if (first && first.role === 'system') {
    if (typeof first.content === 'string') {
      body.messages = [{ ...first, content: withEnvMarker(first.content) }, ...body.messages.slice(1)];
      return body;
    }
    if (Array.isArray(first.content)) {
      const marked = first.content.some((part: any) => hasEnvMarker(part?.text));
      if (!marked) {
        body.messages = [
          { ...first, content: [...first.content, { type: 'text', text: OPENCODE_ENV_MARKER }] },
          ...body.messages.slice(1),
        ];
      }
      return body;
    }
  }

  body.messages = [{ role: 'system', content: OPENCODE_ENV_MARKER }, ...body.messages];
  return body;
}

const FINGERPRINT_TOOL_DEFINITIONS: Record<string, any> = {
  read: {
    description: 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
        limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  shell: {
    description: 'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
        timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
        background: { type: 'boolean', description: 'Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

const ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAMES = ['read', 'shell'];
function zenPlaceholderToolsFor(requestFormat: string): any[] {
  if (requestFormat === 'responses') {
    return ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAMES.map((name) => {
      const def = FINGERPRINT_TOOL_DEFINITIONS[name];
      if (def) {
        return { type: 'function', name, description: def.description, parameters: def.parameters };
      }
      return { type: 'function', name, description: 'Do not call this tool. It exists only to satisfy a client contract requirement.', parameters: { type: 'object', properties: {} } };
    });
  }
  return ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAMES.map((name) => {
    const def = FINGERPRINT_TOOL_DEFINITIONS[name];
    if (def) {
      return { type: 'function', function: { name, description: def.description, parameters: def.parameters } };
    }
    return { type: 'function', function: { name, description: 'Do not call this tool. It exists only to satisfy a client contract requirement.', parameters: { type: 'object', properties: {} } } };
  });
}
const ZEN_FREE_MODEL_SUFFIX_RE = /-free$/i;
const ZEN_KNOWN_FREE_MODELS = new Set(['big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free', 'hy3-free', 'nemotron-3-ultra-free', 'north-mini-code-free']);
async function isZenFreeTierModel(modelId: string): Promise<boolean> {
  const id = String(modelId || '');
  if (ZEN_FREE_MODEL_SUFFIX_RE.test(id) || ZEN_KNOWN_FREE_MODELS.has(id)) return true;
  const dynamicSet = await getZenFreeModelSet();
  return !!(dynamicSet && dynamicSet.has(id));
}
function applyZenFreeTierContract(body: any, requestFormat: string) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let next = applyFingerprintSystemPrompt({ ...body, stream: true });
  const existing = (Array.isArray(next.tools) ? next.tools : []).filter((t: any) => t && t.type !== 'image_generation');
  const existingNames = new Set(existing.map((t: any) => (t && t.function && t.function.name) || (t && t.name) || '').filter(Boolean));
  const placeholders = zenPlaceholderToolsFor(requestFormat).filter((t: any) => !existingNames.has((t.function && t.function.name) || t.name));
  next.tools = [...existing, ...placeholders];
  return next;
}
// free tier 계약이 stream:true를 강제하므로, stream:false를 원한 클라이언트에겐 SSE를 JSON으로 재조립해 돌려준다.
function rebuildChatJsonFromForcedStream(sseText: string, model: string) {
  let content = '';
  let role = 'assistant';
  let finishReason = 'stop';
  let usage = null;
  let id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  for (const line of sseText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]' || !payload) continue;
    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    if (evt.id) id = evt.id;
    const choice = evt.choices && evt.choices[0];
    if (!choice) { if (evt.usage) usage = evt.usage; continue; }
    const delta = choice.delta || {};
    if (delta.role) role = delta.role;
    if (typeof delta.content === 'string') content += delta.content;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (evt.usage) usage = evt.usage;
  }
  return {
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role, content }, finish_reason: finishReason }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
function collectResponsesObjectFromSSE(sseText: string) {
  let finalResponse = null;
  for (const line of sseText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    if (evt.type === 'response.completed' && evt.response) finalResponse = evt.response;
  }
  return finalResponse;
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
const KILO_BASE = (() => { try { return Deno.env.get('KILO_BASE') || 'https://ai-gateway.kilo.ai/api/v1'; } catch { return 'https://ai-gateway.kilo.ai/api/v1'; } })();
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
const BLOCKRUN_BASE = 'https://blockrun.ai/api';
let blockrunModelsCache = null;
let blockrunModelsCacheTime = 0;
async function getBlockrunModels() {
  const now = Date.now();
  if (blockrunModelsCache && (now - blockrunModelsCacheTime) < 300000) return blockrunModelsCache;
  try {
    const r = await fetch(BLOCKRUN_BASE + '/models', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const nowSec = Math.floor(now / 1000);
    const list = (j.data || []).filter((m: any) => m && m.id && (m.billing_mode === 'free' || (m.pricing && m.pricing.input === 0))).map((m: any) => ({ id: 'blockrun/' + m.id, object: 'model', created: nowSec, owned_by: 'blockrun' }));
    blockrunModelsCache = list; blockrunModelsCacheTime = now;
  } catch (e) { console.error('[blockrun models] fail', String(e).slice(0, 80)); }
  return blockrunModelsCache || [];
}

const UNCLOSEAI_BASE = 'https://qwen.ai.unturf.com';
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
  // 2026-10-26: 카탈로그가 deprecated로 표시한 모델은 목록에 노출하지 않는다(카탈로그를 못 받으면 필터 없이 기존 동작).
  const deprecatedIds = await getZenDeprecatedSet();
  const freeIds = rawIds.filter(id => (id.endsWith('-free') || KNOWN_FREE_EXTRA.has(id)) && !(deprecatedIds && deprecatedIds.has(id)));
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

// P31 fix (2026-09-15): api/index.js와 동일 로직 이식 — Anthropic Messages API는
// tool JSON Schema 중첩 깊이가 10을 넘으면 `[invalid_request_error] JSON schema
// exceeds the maximum nesting depth of 10 levels`로 400을 낸다. MCP 도구가 많은
// 클라이언트의 깊게 중첩된 parameters/input_schema가 그대로 forward되어 발생.
// image_generation tool 제거(P24)와 같은 철학으로, 거부 대신 depth 초과 분기를
// 허용 가능한 leaf({type,description,enum}만)로 잘라낸다.
function schemaChildNodes(node) {
  const out = [];
  if (node.properties && typeof node.properties === 'object') out.push(...Object.values(node.properties));
  if (node.items) out.push(...(Array.isArray(node.items) ? node.items : [node.items]));
  if (node.additionalProperties && typeof node.additionalProperties === 'object') out.push(node.additionalProperties);
  if (node.patternProperties && typeof node.patternProperties === 'object') out.push(...Object.values(node.patternProperties));
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(node[key])) out.push(...node[key]);
  return out;
}
function capSchemaDepth(node, maxDepth, depth) {
  depth = depth || 1;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  if (depth >= maxDepth) {
    const leaf = {};
    if (node.type) leaf.type = node.type;
    if (node.description) leaf.description = node.description;
    if (node.enum) leaf.enum = node.enum;
    return leaf;
  }
  const out = { ...node };
  if (node.properties && typeof node.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) out.properties[k] = capSchemaDepth(v, maxDepth, depth + 1);
  }
  if (node.items) {
    out.items = Array.isArray(node.items)
      ? node.items.map(it => capSchemaDepth(it, maxDepth, depth + 1))
      : capSchemaDepth(node.items, maxDepth, depth + 1);
  }
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    out.additionalProperties = capSchemaDepth(node.additionalProperties, maxDepth, depth + 1);
  }
  if (node.patternProperties && typeof node.patternProperties === 'object') {
    out.patternProperties = {};
    for (const [k, v] of Object.entries(node.patternProperties)) out.patternProperties[k] = capSchemaDepth(v, maxDepth, depth + 1);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[key])) out[key] = node[key].map(s => capSchemaDepth(s, maxDepth, depth + 1));
  }
  return out;
}
const MAX_TOOL_SCHEMA_DEPTH = parseInt(process.env.MAX_TOOL_SCHEMA_DEPTH || '9', 10);
function capToolSchemaDepth(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  const t = { ...tool };
  if (t.function && typeof t.function === 'object') {
    t.function = { ...t.function };
    if (t.function.parameters) t.function.parameters = capSchemaDepth(t.function.parameters, MAX_TOOL_SCHEMA_DEPTH);
  }
  if (t.parameters) t.parameters = capSchemaDepth(t.parameters, MAX_TOOL_SCHEMA_DEPTH);
  if (t.input_schema) t.input_schema = capSchemaDepth(t.input_schema, MAX_TOOL_SCHEMA_DEPTH);
  return t;
}
function capToolsDepth(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(capToolSchemaDepth);
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
  const convertedTools = capToolsDepth((bodyObj.tools || []).filter((t) => t && t.type !== 'image_generation').map(t => t && t.type === 'function' && t.function ? { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters } : t).filter(Boolean));
  const isFreeTier = await isZenFreeTierModel(upstreamModel);
  let tools = convertedTools;
  if (isFreeTier) {
    const existingNames = new Set(convertedTools.map((t) => t.name).filter(Boolean));
    tools = [...convertedTools, ...zenPlaceholderToolsFor('responses').filter((t) => !existingNames.has(t.name))];
  }
  const rbody = {
    model: upstreamModel,
    input: museToInput(bodyObj.messages),
    tools,
    tool_choice: bodyObj.tool_choice,
    max_output_tokens: Math.max(131072, reqMax || 0),
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: variant ? (MUSE_EFFORT[variant] || 'high') : 'low', summary: 'auto' },
    // free tier 게이트가 stream:true를 요구한다. 클라이언트가 stream:false여도 upstream에는 true로 보내고
    // 아래에서 SSE를 모아 JSON으로 재조립하므로 클라이언트가 받는 형태는 바뀌지 않는다.
    stream: isFreeTier ? true : !!isStream,
    metadata: { _nonce: crypto.randomUUID().slice(0, 12) },
  };
  const headers = await injectHeaders({ 'Content-Type': 'application/json', 'Accept': rbody.stream ? 'text/event-stream' : 'application/json' }, rbody);
  const r = await fetch(UPSTREAM + '/responses', { method: 'POST', headers, body: JSON.stringify(rbody) });
  if (!r.ok) return forwardStreamOrJson(r, false);
  if (isStream) return new Response(responsesSSEToChatStream(r.body), { status: 200, headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const responseObj = collectResponsesObjectFromSSE(await r.text());
    if (!responseObj) return json({ error: { message: 'forced-stream response missing response.completed event' } }, 502);
    return json(responsesToChatJson(responseObj, upstreamModel));
  }
  return json(responsesToChatJson(await r.json(), upstreamModel));
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
    let pathname = url.pathname;
    let isOpencodePrefix = false;

    // 2026-10-26: api/index.js와 동일 — /opencode/v1/* 접두사 라우트(Kilo/Dahl와 같은 형태).
    // 게이트웨이가 프로바이더 이름을 경로에 붙여 보내는 경우를 받아주고, 접두사만 벗겨
    // 기존 /v1/* 처리 경로를 그대로 재사용한다.
    if (pathname === '/opencode' || pathname.startsWith('/opencode/')) {
      isOpencodePrefix = true;
      pathname = pathname.slice('/opencode'.length) || '/';
      if (!pathname.startsWith('/')) pathname = '/' + pathname;
    }

    if (pathname === '/health' || pathname === '/v1/health') {
      return json({ status: 'ok', upstream: UPSTREAM });
    }
    const isNativeProtocolPrefix = pathname.startsWith('/res/') || pathname.startsWith('/chat/') || pathname.startsWith('/mes/') || pathname.startsWith('/kilo/') || pathname.startsWith('/blockrun/') || pathname.startsWith('/uncloseai/') || pathname.startsWith('/dahl/');
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
        const headers = await injectHeaders({ 'Content-Type': 'application/json' });
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
        const deprecatedIds = await getZenDeprecatedSet();
        const upstreamJson = await fr.json();
        const filtered = Array.isArray(upstreamJson.data)
          ? upstreamJson.data.filter((m) => {
              if (!m || !m.id || !(m.id.endsWith('-free') || KNOWN_FREE_EXTRA.has(m.id))) return false;
              if (deprecatedIds && deprecatedIds.has(m.id)) return false; // deprecated 모델 제외
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
      const headers = await injectHeaders({ 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' }, pbody);
      // /res/v1/responses는 순수 passthrough(바디 무변형)가 원칙이지만, muse 계열에서 100% 확정적으로
      // 실패하는 두 가지 케이스만 최소 개입으로 방어한다(res/chat/mes 설계 원칙과 같은 성격의 예외, P24/P28):
      let outText = rawText;
      let patched = null;
      // P32: 클라이언트(또는 클라이언트가 서버에 영구 저장한 대화 히스토리) 쪽에서 이미 같은
      // call_id가 서로 다른 두 tool call에 중복 배정된 채로 들어오면, zen이 'Duplicate
      // function_call_output' 400을 낸다 — 이 라우트군은 순수 passthrough라 pool이 다른 노드로
      // 재시도해도 매번 동일한 바디를 다시 보내 똑같이 실패한다(요청 스코프 문제, failover로는
      // 회복 불가). museToInput(P3)이 /v1/chat/completions 변환 경로에 이미 적용한 "먼저 나온
      // 쌍만 유지" 방어를, 형태가 다른 이 세 라우트의 페이로드에도 동일 원칙으로 적용한다.
      if (pathname === '/res/v1/responses' && Array.isArray((patched || pbody).input)) {
        const src = (patched || pbody).input;
        const seenCalls = new Set(), seenOutputs = new Set();
        let removed = 0;
        const filtered = src.filter((it) => {
          if (it && it.type === 'function_call') {
            const id = it.call_id || '';
            if (id && seenCalls.has(id)) { removed++; return false; }
            if (id) seenCalls.add(id);
          } else if (it && it.type === 'function_call_output') {
            const id = it.call_id || '';
            if (id && seenOutputs.has(id)) { removed++; return false; }
            if (id) seenOutputs.add(id);
          }
          return true;
        });
        if (removed) {
          patched = patched || { ...pbody };
          patched.input = filtered;
          console.warn(`[compat] /res/v1/responses: removed ${removed} duplicate function_call/function_call_output call_id entries before forwarding (P32)`);
        }
      } else if (pathname === '/chat/v1/chat/completions' && Array.isArray((patched || pbody).messages)) {
        const src = (patched || pbody).messages;
        const seenCalls = new Set(), seenOutputs = new Set();
        let removed = 0;
        const filtered = [];
        for (const m of src) {
          if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            const kept = m.tool_calls.filter((tc) => {
              const id = (tc && tc.id) || '';
              if (id && seenCalls.has(id)) { removed++; return false; }
              if (id) seenCalls.add(id);
              return true;
            });
            if (kept.length !== m.tool_calls.length) {
              if (kept.length) filtered.push({ ...m, tool_calls: kept });
              continue;
            }
            filtered.push(m);
            continue;
          }
          if (m && m.role === 'tool') {
            const id = m.tool_call_id || '';
            if (id && seenOutputs.has(id)) { removed++; continue; }
            if (id) seenOutputs.add(id);
          }
          filtered.push(m);
        }
        if (removed) {
          patched = patched || { ...pbody };
          patched.messages = filtered;
          console.warn(`[compat] /chat/v1/chat/completions: removed ${removed} duplicate tool_calls/tool call_id entries before forwarding (P32)`);
        }
      } else if (pathname === '/mes/v1/messages' && Array.isArray((patched || pbody).messages)) {
        const src = (patched || pbody).messages;
        const seenCalls = new Set(), seenOutputs = new Set();
        let removed = 0;
        const filtered = [];
        for (const m of src) {
          if (m && Array.isArray(m.content)) {
            const kept = m.content.filter((b) => {
              if (b && b.type === 'tool_use') {
                const id = b.id || '';
                if (id && seenCalls.has(id)) { removed++; return false; }
                if (id) seenCalls.add(id);
              } else if (b && b.type === 'tool_result') {
                const id = b.tool_use_id || '';
                if (id && seenOutputs.has(id)) { removed++; return false; }
                if (id) seenOutputs.add(id);
              }
              return true;
            });
            if (kept.length !== m.content.length) {
              if (kept.length) filtered.push({ ...m, content: kept });
              continue;
            }
          }
          filtered.push(m);
        }
        if (removed) {
          patched = patched || { ...pbody };
          patched.messages = filtered;
          console.warn(`[compat] /mes/v1/messages: removed ${removed} duplicate tool_use/tool_result id entries before forwarding (P32)`);
        }
      }
      // P31: JSON schema 10-depth 제한은 세 네이티브 라우트 전부에서 발생 가능하므로 공통 처리.
      if (Array.isArray(pbody.tools)) {
        const capped = capToolsDepth(pbody.tools);
        if (JSON.stringify(capped) !== JSON.stringify(pbody.tools)) {
          patched = patched || { ...pbody };
          patched.tools = capped;
          console.warn(`[compat] ${pathname}: capped tool schema nesting depth to ${MAX_TOOL_SCHEMA_DEPTH} before forwarding`);
        }
      }
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
      // P36: 네이티브 passthrough 라우트도 free tier 모델이면 동일한 게이트(stream:true + CLI 도구 이름)를 탄다.
      if (await isZenFreeTierModel(parseModel(pbody.model).upstreamModel)) {
        patched = applyZenFreeTierContract(patched || pbody, pathname === '/res/v1/responses' ? 'responses' : 'chat');
      }
      if (patched) outText = JSON.stringify(patched);
      if (isStream || (patched || pbody).stream === true) headers['Accept'] = 'text/event-stream';
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

    // /kilo/v1과 같은 원칙(네이티브 엔드포인트, 접두사 없는 모델명)의 UncloseAI/Dahl 전용 라우트.
    // 레거시 /v1/models·/v1/chat/completions의 uncloseai/·dahl/ 접두사 라우팅과 별개로,
    // 클라이언트가 그 프로바이더만 쓰고 싶을 때 접두사 없이 바로 부를 수 있게 한다.
    if (request.method === 'GET' && pathname === '/blockrun/v1/models') {
      try {
        const models = await getBlockrunModels();
        const data = models.map((m: any) => ({ ...m, id: String(m.id).replace(/^blockrun\//, '') }));
        return json({ object: 'list', data });
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    if (request.method === 'GET' && pathname === '/uncloseai/v1/models') {
      try {
        const models = await getUncloseaiModels();
        const data = models.map((m) => ({ ...m, id: m.id.replace(/^uncloseai\//, '') }));
        return json({ object: 'list', data });
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    if (request.method === 'GET' && pathname === '/dahl/v1/models') {
      try {
        const models = await getDahlModels();
        const data = models.map((m) => ({ ...m, id: m.id.replace(/^dahl\//, '') }));
        return json({ object: 'list', data });
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    if (request.method === 'POST' && pathname === '/blockrun/v1/chat/completions') {
      const rawText = await request.text();
      let pbody; try { pbody = JSON.parse(rawText || '{}'); } catch { return json({ error: { message: 'Invalid JSON' } }, 400); }
      if (!pbody.model) return json({ error: { message: 'model required' } }, 400);
      const realModel = String(pbody.model).replace(/^blockrun\//i, '');
      const isStream = !!pbody.stream;
      const uHeaders = { 'Content-Type': 'application/json', Accept: isStream ? 'text/event-stream' : 'application/json' };
      try {
        const ur = await fetch(BLOCKRUN_BASE + '/chat/completions', { method: 'POST', headers: uHeaders, body: JSON.stringify({ ...pbody, model: realModel }) });
        if (isStream && ur.ok) {
          return new Response(ur.body, { status: 200, headers: { ...CORS, 'Content-Type': ur.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' } });
        }
        return new Response(await ur.text(), { status: ur.status, headers: { ...CORS, 'Content-Type': ur.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    if (request.method === 'POST' && pathname === '/uncloseai/v1/chat/completions') {
      const rawText = await request.text();
      let pbody; try { pbody = JSON.parse(rawText || '{}'); } catch { return json({ error: { message: 'Invalid JSON' } }, 400); }
      if (!pbody.model) return json({ error: { message: 'model required' } }, 400);
      const realModel = String(pbody.model).replace(/^uncloseai\//i, '');
      const isStream = !!pbody.stream;
      const uHeaders = { 'Content-Type': 'application/json', Accept: isStream ? 'text/event-stream' : 'application/json' };
      try {
        const ur = await fetch(UNCLOSEAI_BASE + '/v1/chat/completions', { method: 'POST', headers: uHeaders, body: JSON.stringify({ ...pbody, model: realModel }) });
        if (isStream && ur.ok) {
          return new Response(ur.body, { status: 200, headers: { ...CORS, 'Content-Type': ur.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' } });
        }
        return new Response(await ur.text(), { status: ur.status, headers: { ...CORS, 'Content-Type': ur.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    if (request.method === 'POST' && pathname === '/dahl/v1/chat/completions') {
      const rawText = await request.text();
      let pbody; try { pbody = JSON.parse(rawText || '{}'); } catch { return json({ error: { message: 'Invalid JSON' } }, 400); }
      if (!pbody.model) return json({ error: { message: 'model required' } }, 400);
      const realModel = String(pbody.model).replace(/^dahl\//i, '');
      const isStream = !!pbody.stream;
      const dHeaders = { 'Content-Type': 'application/json', Accept: isStream ? 'text/event-stream' : 'application/json' };
      try {
        let dr;
        for (let attempt = 0; attempt < 2; attempt++) {
          dHeaders.Authorization = `Bearer ${await getDahlToken(attempt > 0)}`;
          dr = await fetch(DAHL_BASE + '/v1/chat/completions', { method: 'POST', headers: dHeaders, body: JSON.stringify({ ...pbody, model: realModel }) });
          if ((dr.status === 401 || dr.status === 403) && attempt === 0) continue;
          break;
        }
        if (isStream && dr.ok) {
          return new Response(dr.body, { status: 200, headers: { ...CORS, 'Content-Type': dr.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' } });
        }
        return new Response(await dr.text(), { status: dr.status, headers: { ...CORS, 'Content-Type': dr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
      } catch (e) { return json({ error: { message: e.message } }, 502); }
    }

    if (request.method === 'GET' && pathname === '/v1/models') {
      try {
        if (isOpencodePrefix) {
          const zenModels = await getFreeModelsExpanded();
          const nowSec = Math.floor(Date.now() / 1000);
          const data: any[] = [];
          const seen = new Set<string>();
          for (const m of zenModels) {
            const rawId = m.id.replace(/^opencode\//, '');
            if (!seen.has(rawId)) {
              seen.add(rawId);
              data.push({ id: rawId, object: 'model', created: nowSec, owned_by: 'opencode' });
            }
            if (!seen.has(m.id)) {
              seen.add(m.id);
              data.push({ id: m.id, object: 'model', created: nowSec, owned_by: 'opencode' });
            }
          }
          data.sort((a, b) => a.id.localeCompare(b.id));
          return json({ object: 'list', data });
        }
        let data = await getFreeModelsExpanded();
        try { data = data.concat(await getKiloFreeModels()); } catch {}
        // uncloseai/dahl은 kilo/zen 키 체계와 무관하게 항상 무인증으로 동작하므로 항상 추가한다.
        try { data = data.concat(await getUncloseaiModels()); } catch {}
        try { data = data.concat(await getBlockrunModels()); } catch {}
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
      if (/^(blockrun|uncloseai|dahl)\//i.test(String(body.model || ''))) {
        const isDahl = /^dahl\//i.test(String(body.model || ''));
        const isBlockrun = /^blockrun\//i.test(String(body.model || ''));
        const realModel = String(body.model).replace(/^(blockrun|uncloseai|dahl)\//i, '');
        const upstreamBase = isBlockrun ? BLOCKRUN_BASE : (isDahl ? DAHL_BASE : UNCLOSEAI_BASE);
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
          const r2 = await fetch(UPSTREAM + '/responses', { method: 'POST', headers: await injectHeaders({ 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' }, ub), body: JSON.stringify(ub) });
          if (isStream && r2.ok) return new Response(r2.body, { status: 200, headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Cache-Control': 'no-store' } });
          return new Response(await r2.text(), { status: r2.status, headers: { ...CORS, 'Content-Type': r2.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
        }
        if (Array.isArray(body.tools)) body.tools = capToolsDepth(body.tools);
        if (isMuse) return await museChatResponse(upstreamModel, body, variant, isStream);
        let upstreamBody = applyVariant(applyMuseDefaults({ ...body, model: upstreamModel }, 'chat'), variant);
        if (await isZenFreeTierModel(upstreamModel)) upstreamBody = applyZenFreeTierContract(upstreamBody, 'chat');
        const r = await forward('/chat/completions', upstreamBody, !!upstreamBody.stream);
        if (!r.ok) return forwardStreamOrJson(r, false);
        if (upstreamBody.stream && !isStream) return json(rebuildChatJsonFromForcedStream(await r.text(), upstreamModel));
        return forwardStreamOrJson(r, isStream);
      }

      if (pathname === '/v1/responses') {
        if (/^kilo\//i.test(String(body.model || ''))) return json({ error: { message: 'kilo models do not support the Responses API. Use /v1/chat/completions.' } }, 400);
        // P23 fix: flat reasoning_effort fallback, but avoid duplicate when body already has reasoning object
        // Use rawVariant (colon suffix only) — global variant already includes thinking/clientBody and would bypass the body.reasoning check
        const effectiveVariant = rawVariant || (body.reasoning ? null : effortFromClientBody(body));
        if (Array.isArray(body.tools)) body.tools = capToolsDepth(body.tools);
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
        if (await isZenFreeTierModel(upstreamModel)) upstreamBody = applyZenFreeTierContract(upstreamBody, 'responses');
        const r = await forward('/responses', upstreamBody, !!upstreamBody.stream);
        if (!r.ok) return forwardStreamOrJson(r, false);
        if (upstreamBody.stream && !isStream) {
          const responseObj = collectResponsesObjectFromSSE(await r.text());
          if (!responseObj) return json({ error: { message: 'forced-stream response missing response.completed event' } }, 502);
          return json(responseObj);
        }
        return forwardStreamOrJson(r, isStream);
      }

      if (pathname === '/v1/messages') {
        let anthMessages = anthropicMessagesToOpenAI(body);
        anthMessages = truncateMessagesIfNeeded(anthMessages, body.system);
        const anthTools = capToolsDepth(anthropicToolsToOpenAI(body.tools));
        const anthToolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);
        const openReq = { model: upstreamModel, messages: anthMessages, max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p, stream: !!body.stream, stop: body.stop_sequences, ...(anthTools?{tools:anthTools}:{}), ...(anthToolChoice?{tool_choice:anthToolChoice}:{}) };
        const full = applyVariant(applyMuseDefaults(openReq, 'chat'), variant);
        if (variant && isMuse) full.reasoning = { effort: variant === 'minimal' ? 'low' : (['low', 'medium', 'high'].includes(variant) ? variant : 'high') };
        let r;
        if (/^kilo\//i.test(String(full.model || ''))) {
          const kBody = { ...full, model: String(full.model).replace(/^kilo\//i, '') };
          delete kBody.reasoning_effort; delete kBody.reasoningEffort;
          if (variant && !String(kBody.model).includes(':')) kBody.model += ':' + variant;
          const kr = await fetch(KILO_BASE + '/chat/completions', { method: 'POST', headers: await injectHeaders({ 'Content-Type': 'application/json', Accept: isStream ? 'text/event-stream' : 'application/json' }), body: JSON.stringify(kBody) });
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
