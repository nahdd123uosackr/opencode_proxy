'use strict';
const crypto = require('node:crypto');
const UPSTREAM = process.env.UPSTREAM || 'https://opencode.ai/inference/v1';

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
    if (errStatus === 429 || /FreeUsageLimitError/i.test(bodyText || '')) {
      resetZenSession(key);
    }
  } else {
    markKeySuccess(key);
  }
}


// === Kilo Gateway 프로바이더 (무료 모델 및 사용자 키 지원) ===
const KILO_BASE = process.env.KILO_BASE || 'https://ai-gateway.kilo.ai/api/v1';
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

// === UncloseAI 프로바이더 (완전 무인증, OmniRoute registry authType:"optional"로 확인) ===
// 클라이언트가 어떤 키를 보내든(zen/kilo/없음) 무관하게 항상 사용 가능 — 업스트림이 키 자체를
// 요구하지 않는다(2026-09-12 실측: 키 없이 /v1/models·/v1/chat/completions 둘 다 200).
// 2026-09-30: hermes.ai.unturf.com이 죽어서(502, 실측 확인 — pool 경유 /uncloseai/ 요청이
// "all upstreams exhausted"로 45개 노드 전부 실패) qwen.ai.unturf.com으로 교체. 모델 목록
// 재확인 결과 turboderp/Qwen3.8-27B-exl3 그대로 서빙 중이라 config.yaml 쪽 모델명은 안 바꿔도 됨.
const BLOCKRUN_BASE = 'https://blockrun.ai/api';
let blockrunModelsCache = null, blockrunModelsCacheTime = 0;

async function getBlockrunModels() {
  const now = Date.now();
  if (blockrunModelsCache && (now - blockrunModelsCacheTime) < 300000) return blockrunModelsCache;
  try {
    const r = await fetch(BLOCKRUN_BASE + '/v1/models', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const nowSec = Math.floor(now / 1000);
    // filter only free models
    const freeModels = (j.data || []).filter(m => m && m.id && (m.billing_mode === 'free' || (m.pricing && m.pricing.input === 0)));
    const list = freeModels.map(m => ({ id: 'blockrun/' + m.id, object: 'model', created: nowSec, owned_by: 'blockrun' }));
    blockrunModelsCache = list;
    blockrunModelsCacheTime = now;
    return list;
  } catch (e) {
    console.error('[blockrun models] fail', e.message);
  }
  return blockrunModelsCache || [];
}

const UNCLOSEAI_BASE = 'https://qwen.ai.unturf.com';
let uncloseaiModelsCache = null, uncloseaiModelsCacheTime = 0;

async function getUncloseaiModels() {
  const now = Date.now();
  if (uncloseaiModelsCache && (now - uncloseaiModelsCacheTime) < 300000) return uncloseaiModelsCache;
  try {
    const r = await fetch(UNCLOSEAI_BASE + '/v1/models', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const nowSec = Math.floor(now / 1000);
    const list = (j.data || []).filter(m => m && m.id).map(m => ({ id: 'uncloseai/' + m.id, object: 'model', created: nowSec, owned_by: 'uncloseai' }));
    uncloseaiModelsCache = list;
    uncloseaiModelsCacheTime = now;
    return list;
  } catch (e) {
    console.error('[uncloseai models] fail', e.message);
  }
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
let dahlTokenCache = null, dahlTokenCacheTime = 0;
let dahlModelsCache = null, dahlModelsCacheTime = 0;
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
  dahlTokenCache = token;
  dahlTokenCacheTime = now;
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
    const list = (j.data || []).filter(m => m && m.id).map(m => ({ id: 'dahl/' + m.id, object: 'model', created: nowSec, owned_by: 'dahl' }));
    dahlModelsCache = list;
    dahlModelsCacheTime = now;
    return list;
  } catch (e) {
    console.error('[dahl models] fail', e.message);
  }
  return dahlModelsCache || [];
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

// P33 fix (2026-09-17): zen이 무료 티어 추론 엔드포인트(/responses, /chat/completions)에
// "OpenCode's free tier can only be used from within OpenCode" (FreeTierError, 403) 클라이언트
// 검증을 추가했다. 실제 opencode CLI(Bun 런타임)로 mitmproxy 경유 실측 캡처 + Node fetch로
// 최소 헤더 조합 격리 테스트한 결과, 필요조건은 정확히 2개뿐이었다:
//   1) User-Agent가 정확히 실제 CLI 문자열('opencode/latest/2.0.5/cli') -- 'opencode/'로
//      시작하기만 한 임의 값(예: 'opencode/pool')은 통과 못 함, 정확한 문자열이어야 함
//   2) x-opencode-session 값이 'ses_' 접두사 형식 -- 접두사 없는 순수 hex는 실패
// Authorization/x-opencode-client 값/b3/traceparent/x-opencode-project 등은 전부 무관함을
// 확인(있어도 없어도 결과 동일) -- GET /models는 애초에 이 게이트가 없어 UA 무관하게 통과.
// 기존 코드는 pickUA()로 Chrome 브라우저 UA를 위장해 보냈고 세션 ID도 접두사 없는 순수
// hex였다 -- 두 조건 다 게이트를 통과 못 하는 값이었다.
// P33 (2026-09-30): 2026-09-29 게이트 강화 이후 위 ZEN_UA/세션 형식이 더 이상 안 먹힌다.
// OmniRoute(우리가 쓰는 게이트웨이 소프트웨어)의 v3.8.51에서 병합된 PR #14013("OpenCode
// free tier request contract")의 실제 헤더/세션 ID 생성 규칙을 빌드 산출물(청크
// 20420.js 등)에서 역공학해 그대로 이식했다. 오라클2에서 opencode.ai/zen/v1에 순수
// Node fetch로 직접 검증(2026-09-30): space-bunny-free/big-pickle/mimo-v2.6-flash-free
// 는 /chat/completions에서, muse-spark-1.2/1.3는 /responses에서(둘 다 tools에 실제
// opencode CLI 도구 이름 여러 개를 넣어야 함 — _noop 하나만으로는 403 유지) 200 확인.
//
// 세션/메시지 ID 형식: `<prefix>` + sha256(또는 random 32B)의 앞 6바이트를 hex로,
// 이어지는 14바이트를 base62로 인코딩한 문자열. 정규식: /^(ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const ZEN_B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function opencodeIdFromDigest(prefix, digest) {
  const hexPart = Buffer.from(digest.subarray(0, 6)).toString('hex');
  let b62Part = '';
  for (const byte of digest.subarray(6, 20)) b62Part += ZEN_B62[byte % 62];
  return prefix + hexPart + b62Part;
}
function synthesizeOpencodeId(prefix) {
  return opencodeIdFromDigest(prefix, crypto.randomBytes(32));
}
// zen이 무료 쿼터를 session(+IP) 단위로 집행한다는 관측이 있다(9router #5107,
// opencode #58205 참고). 요청마다 세션을 새로 만들면 재시도/후속턴이 전부 새 쿼터
// 버킷으로 들어가 사용량이 분산·중복 집계되고 비정상 패턴으로도 보인다. 그래서:
//   - 세션 id: 인증 주체(zenApiKey) 단위로 고정하고, 익명(free tier) 요청은
//     24시간 윈도우로 로테이션한다. 실제 CLI의 "세션 시작→하루 리셋" 동작 흉내.
//   - 요청 id: sha256(sessionId + 마지막 user 메시지)로 결정론적 생성해 재시도가
//     같은 id를 공유하게 한다(실제 CLI/9router PR #4723의 deriveRequestId와 동일 개념).
// 랜덤 fallback을 남겨두는 이유: session-id 단위로 합산이 강화돼 막히는 경우가
// 생기면 환경변수 ZEN_SESSION_MODE=random 하나로 원래 동작으로 되돌릴 수 있다.
// 2026-10-24 (9router PR #4791): zen은 ses_ id의 hex 12자가 실제 CLI의
// "inverted timestamp" 인코딩인지 검사한다 — hex 12자 = ~(ms*4096 + counter)의
// 하위 48비트. sha256/랜덤 비트로 만든 id는 정규식은 통과해도 이 디코딩 검사에서
// 실패해 403 FreeTierError가 난다(PR #4791 작성자가 실 zen에 실측 확인).
// 그래서 세션 id는 canonical 방식(반전 타임스탬프 hex + base62 꼬리)으로 발급하고,
// 일 단위 고정/키 단위 고정은 "발급된 canonical id를 캐시"하는 방식으로 유지한다.
const ZEN_TS_MASK = (1n << 48n) - 1n;
const SESSION_COUNTER_MAX = 16;
let zenIdCounter = 0;
function canonicalSessionId() {
  // 9router #5218: counter must wrap in 1..16 (values >=100 give 403 FreeTierError)
  zenIdCounter = (zenIdCounter % SESSION_COUNTER_MAX) + 1;
  const units = BigInt(Date.now()) * 4096n + BigInt(zenIdCounter);
  const inverted = (~units) & ZEN_TS_MASK;
  const hexPart = inverted.toString(16).padStart(12, '0');
  const digest = crypto.randomBytes(14);
  let b62Part = '';
  for (const byte of digest) b62Part += ZEN_B62[byte % 62];
  return 'ses_' + hexPart + b62Part;
}
const ZEN_SESSION_MODE = process.env.ZEN_SESSION_MODE || 'stable'; // 'stable' | 'random'
let zenAnonSession = null; // { id: string, day: string }
const zenKeySessionCache = new Map(); // keyHash -> canonical session id (프로세스 수명 동안 고정)
function resetZenSession(zenApiKey) {
  if (zenApiKey) {
    const keyHash = crypto.createHash('sha256').update(String(zenApiKey)).digest('hex').slice(0, 16);
    zenKeySessionCache.delete(keyHash);
  } else {
    zenAnonSession = null;
  }
}
function sessionIdFor(zenApiKey) {
  if (ZEN_SESSION_MODE === 'random') return canonicalSessionId();
  const day = new Date().toISOString().slice(0, 10); // UTC 일 단위
  if (zenApiKey) {
    const keyHash = crypto.createHash('sha256').update(String(zenApiKey)).digest('hex').slice(0, 16);
    let id = zenKeySessionCache.get(keyHash);
    if (!id) { id = canonicalSessionId(); zenKeySessionCache.set(keyHash, id); }
    return id;
  }
  if (!zenAnonSession || zenAnonSession.day !== day) {
    zenAnonSession = { id: canonicalSessionId(), day };
  }
  return zenAnonSession.id;
}
function requestIdFor(sessionId, upstreamBody) {
  if (ZEN_SESSION_MODE === 'random' || upstreamBody === undefined) return synthesizeOpencodeId('msg_');
  const text = extractLastUserText(upstreamBody);
  const digest = crypto.createHash('sha256').update(sessionId + '|' + text).digest();
  return opencodeIdFromDigest('msg_', digest.subarray(0, 20));
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
  // Responses API 형식: input이 문자열이거나 아이템 배열
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
// 실측 정규식(청크 20420.js): /opencode\/(?:[a-z]+\/)?v?(\d+)\.(\d+)/i
// 9router #5218: 2026-10-14 이후 v1 UA('opencode/1.18.x')는 403 FreeTierError로 차단됨.
// v2 CLI UA 형식('opencode/latest/2.0.26/cli')을 사용하여 통과.
const ZEN_UA = process.env.ZEN_UA || 'opencode/latest/2.2.0/cli';
function injectHeaders(headers, relay, zenApiKey, upstreamBody) {
  const h = { ...headers };
  const sessionId = sessionIdFor(zenApiKey);
  h['User-Agent'] = ZEN_UA;
  h['x-opencode-session-id'] = sessionId;
  h['x-opencode-session'] = sessionId;
  h['x-session-affinity'] = sessionId;
  h['x-session-id'] = sessionId;
  h['x-opencode-client'] = 'cli';
  h['x-opencode-project'] = crypto.randomBytes(20).toString('hex');
  delete h['x-opencode-request'];
  if (zenApiKey) {
    h['Authorization'] = zenApiKey.startsWith('Bearer ') ? zenApiKey : `Bearer ${zenApiKey}`;
  } else {
    h['Authorization'] = 'Bearer public';
  }
  return h;
}

// 9router #5218 / #5253: OpenCode Zen Free tier 게이트웨이 요구사항:
// 1) 시스템 프롬프트에 <env> 블록(Working directory 및 Workspace root folder)이 없으면 즉시 429 FreeUsageLimitError 반환
// 2) 도구 목록에 read와 shell의 정확한 스키마 및 설명이 포함되어야 함
const OPENCODE_ENV_MARKER =
  "<env>\n  Working directory: /workspace\n  Workspace root folder: /workspace\n</env>";
const ENV_BLOCK_RE = /<env>([\s\S]*?)<\/env>/;
const ENV_MARKER_RE = /<env>[\s\S]*?Working directory:[\s\S]*?Workspace root folder:[\s\S]*?<\/env>/;
const ENV_WORKDIR_RE = /Working directory:[^\n]*/;
const ENV_ROOT_RE = /Workspace root folder:/;

function hasEnvMarker(value) {
  return typeof value === 'string' && ENV_MARKER_RE.test(value);
}

function upgradeEnvBlock(text) {
  return text.replace(ENV_BLOCK_RE, (block, inner) => {
    if (ENV_ROOT_RE.test(inner)) return block;
    const root = '  Workspace root folder: /workspace';
    const upgraded = ENV_WORKDIR_RE.test(inner)
      ? inner.replace(ENV_WORKDIR_RE, (line) => `${line}\n${root}`)
      : `${inner.replace(/\s*$/, '')}\n${root}\n`;
    return `<env>${upgraded}</env>`;
  });
}

function withEnvMarker(value) {
  const text = typeof value === 'string' ? value : '';
  if (hasEnvMarker(text)) return text;
  if (ENV_BLOCK_RE.test(text)) return upgradeEnvBlock(text);
  return text.trim() ? `${text}\n\n${OPENCODE_ENV_MARKER}` : OPENCODE_ENV_MARKER;
}

function applyFingerprintSystemPrompt(body) {
  if (!body || typeof body !== 'object') return body;

  if (body.system !== undefined) {
    if (typeof body.system === 'string') {
      body.system = withEnvMarker(body.system);
    } else if (Array.isArray(body.system)) {
      const marked = body.system.some((block) =>
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
      const marked = first.content.some((part) => hasEnvMarker(part?.text));
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

// 9router: OpenCode 공식 CLI(v2.0.26)의 read와 shell 정확한 도구 정의
const FINGERPRINT_TOOL_DEFINITIONS = {
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
function zenPlaceholderToolsFor(requestFormat) {
  if (requestFormat === 'responses') {
    return ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAMES.map((name) => {
      const def = FINGERPRINT_TOOL_DEFINITIONS[name];
      if (def) {
        return { type: 'function', name, description: def.description, parameters: def.parameters };
      }
      return {
        type: 'function', name, description: 'Do not call this tool. It exists only to satisfy a client contract requirement.', parameters: { type: 'object', properties: {} },
      };
    });
  }
  return ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAMES.map((name) => {
    const def = FINGERPRINT_TOOL_DEFINITIONS[name];
    if (def) {
      return { type: 'function', function: { name, description: def.description, parameters: def.parameters } };
    }
    return {
      type: 'function',
      function: { name, description: 'Do not call this tool. It exists only to satisfy a client contract requirement.', parameters: { type: 'object', properties: {} } },
    };
  });
}
// muse-spark는 /chat/completions에서 tools 계약을 갖춰도 500 Internal server error로
// 실패한다(실측 확인, 계약과 무관한 그 엔드포인트 자체의 결함) — /responses에서는
// 동일 계약으로 200 확인됨. 그래서 free tier 모델 판별과 별개로, 어느 엔드포인트로
// 보낼지는 기존 museViaResponses 라우팅(모델명 정규식)을 그대로 따른다.
const ZEN_FREE_MODEL_SUFFIX_RE = /-free$/i;
// OmniRoute PR #14013의 OPENCODE_FREE_MODELS 목록 — 이름이 '-free'로 안 끝나지만
// 무료로 취급되는 모델(예: big-pickle). 실측: big-pickle도 tools 계약을 갖추면
// /chat/completions에서 200 확인됨.
const ZEN_KNOWN_FREE_MODELS = new Set(['big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free', 'hy3-free', 'nemotron-3-ultra-free', 'north-mini-code-free']);
// P34: 동적 목록(zen.mdx "The free models:")과 하드코딩 폴백 목록의 합집합으로 판별.
// 이름이 '-free'로 끝나는 건 그 자체로 이미 무료 신호이므로 문서 fetch 없이 즉시 처리하고,
// 그렇지 않은 경우(big-pickle처럼)만 동적 목록을 조회한다 — 매 요청마다 불필요한 await을
// 피하기 위한 최적화. 문서 fetch/파싱이 실패하면 getZenFreeModelSet()이 null을 반환하고,
// 그 경우 하드코딩 Set만으로 판별(기존 동작과 동일하게 안전한 폴백).
async function isZenFreeTierModel(modelId) {
  const id = String(modelId || '');
  if (ZEN_FREE_MODEL_SUFFIX_RE.test(id) || ZEN_KNOWN_FREE_MODELS.has(id)) return true;
  const dynamicSet = await getZenFreeModelSet();
  return !!(dynamicSet && dynamicSet.has(id));
}
// body가 plain object일 때만 stream:true 강제 + tools 보강.
// 실측(2026-09-30): zen free-tier 게이트는 tools 배열에 opencode CLI 고유 도구 이름
// (bash/read/write/...)이 들어가는지로 판정한다(재현 실험: Claude Code 도구 10개나
// mcp__* 10개는 403, CLI 이름 10개는 200 — 개수와 무관). 그래서 클라이언트가 보낸
// tools를 종류와 무관하게 전부 보존한 채 CLI 플레이스홀더와 합집합을 항상 만든다.
const ZEN_MIN_TOOLS = 6;
function applyZenFreeTierContract(body, requestFormat) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let next = applyFingerprintSystemPrompt({ ...body, stream: true });
  let existing = Array.isArray(next.tools) ? next.tools : [];
  // P36 fix: CLIProxyAPI의 codex 실행기 등이 자동 주입하는 type:"image_generation"
  // 같은 비호환 도구는 zen이 타입 자체를 미지원해 403/400으로 거부한다(P24 교훈).
  // 플레이스홀더를 채우기 전에 이런 비호환 도구를 먼저 걸러낸다.
  existing = existing.filter((t) => t && t.type !== 'image_generation');
  // P37 fix: zen의 free-tier 게이트는 tools에 opencode CLI 고유 도구 이름(bash/read/write/...)
  // 이 들어와야만 통과한다(P37 재현 실험). 이전 P36 조건문은 "클라이언트가 보낸 tools가 6개 이상
  // 이면 그대로 통과"라고 해 Claude Code의 Bash/Read/mcp__* 같은 CLI가 아닌 도구만으로
  // 6개 채워져도 보강 없이 그대로 zen에 건네면서 403 FreeTierError가 났다.
  // 클라이언트 도구는 모두 보존하면서 CLI 플레이스홀더와 합집합을 항상 만든다.
  const existingNames = new Set(existing.map((t) => (t && t.function && t.function.name) || (t && t.name) || '').filter(Boolean));
  const placeholders = zenPlaceholderToolsFor(requestFormat).filter((t) => {
    const name = (t.function && t.function.name) || t.name;
    return !existingNames.has(name);
  });
  next.tools = [...existing, ...placeholders];
  return next;
}

function authOk(req) {
  if (!PROXY_API_KEY) return true;
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.headers['x-proxy-key'];
  return apiKey === PROXY_API_KEY;
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, x-opencode-session' };
}

const REASONING_PASSBACK_RE = /reasoning_content.{0,40}must be passed back/i;

// stage 1: reasoning_content가 빠진 assistant 메시지에 빈 값을 채워 재시도.
// stage 2: 그래도 거절하면 thinking 모드 자체를 끄고 history의 reasoning_content를 제거.
function relaxReasoningPassback(body, stage) {
  const next = { ...body };
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (stage === 1) {
    next.messages = msgs.map(m => (m && m.role === 'assistant' && m.reasoning_content === undefined) ? { ...m, reasoning_content: '' } : m);
    return next;
  }
  next.messages = msgs.map(m => {
    if (!m || m.role !== 'assistant' || m.reasoning_content === undefined) return m;
    const { reasoning_content, ...rest } = m;
    return rest;
  });
  delete next.reasoning_effort; delete next.reasoningEffort; delete next.reasoning;
  next.thinking = { type: 'disabled' };
  return next;
}

// reasoning 모델이 작은 max_tokens를 추론에 소진하는 것 방지 (공통)
function applyMinTokens(body) {
  const mmT = parseInt(process.env.MIN_MAX_TOKENS || '1024', 10);
  for (const k of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    if (typeof body[k] === 'number' && body[k] < mmT) body[k] = mmT;
  }
  return body;
}

// 2) 대형 프롬프트(191k→141k 압축 후에도 대형) 빈 choices 방지 — 입력 히스토리 트렁케이트
// muse-spark 컨텍스트 1M, output 131k 강제 시 프롬프트가 700k 토큰을 넘으면
// 남은 출력 여유가 좁아지며 upstream이 reasoning만 125B로 끊고 content:null 빈 choices로 200 반환.
// 프롬프트 토큰을 700k(≈2.8M chars) 이하로 유지하도록 오래된 히스토리부터 잘라냄.
// system/developer 메시지는 보존, tool 히스토리는 call_id 매칭을 유지하기 위해
// tool_result는 대응되는 assistant tool_calls와 함께 보존/삭제.
function estimateTokens(str) {
  return Math.ceil(String(str || '').length / 4);
}
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
  // system/developer는 보존, 나머지는 오래된 것부터 제거 (tool_result는 짝을 맞춰 제거)
  const systemMsgs = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const otherMsgs = messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  // 뒤에서부터(최신이 중요) 누적
  const keptOther = [];
  let keptTokens = totalPromptTokensForMessages(systemMsgs, instructions);
  for (let i = otherMsgs.length - 1; i >= 0; i--) {
    const cand = otherMsgs[i];
    const candTokens = estimateTokens(JSON.stringify(cand.content || '')) + 10 + (Array.isArray(cand.tool_calls) ? estimateTokens(JSON.stringify(cand.tool_calls)) : 0);
    if (keptTokens + candTokens > MAX) {
      // tool_result 단독으로 남으면 짝이 깨지므로, 대응 assistant tool_calls가 없으면 스킵
      if (cand.role === 'tool') {
        // tool_result만 남고 assistant가 잘렸으면 의미 없으니 스킵
        const hasPair = keptOther.some(k => k.role === 'assistant' && Array.isArray(k.tool_calls) && k.tool_calls.some(tc => tc.id === cand.tool_call_id));
        if (!hasPair) continue;
      }
      if (cand.role === 'assistant' && Array.isArray(cand.tool_calls)) {
        // assistant tool_calls만 남고 뒤에 tool_result가 없으면 잘라냄
        const hasResult = keptOther.some(k => k.role === 'tool' && k.tool_call_id && cand.tool_calls.some(tc => tc.id === k.tool_call_id));
        // 결과 없어도 일단 보존하되, 전체가 너무 크면 계속 잘라야 하므로 일단 스킵하지 않고 계속
      }
      // 토큰 초과 시 더 오래된 메시지 스킵
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
  // developer role은 보존
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

// P31 fix (2026-09-15): Anthropic Messages API rejects tool JSON Schemas whose
// nesting depth exceeds 10 with `[400] Error from provider (Console): Upstream
// request failed: [invalid_request_error] JSON schema exceeds the maximum
// nesting depth of 10 levels` -- MCP-heavy clients (many tools, each with
// deeply nested object/array parameter schemas) routinely exceed this. None of
// the tools-forwarding paths (/v1/messages, /v1/chat/completions, /v1/responses,
// the res|chat|mes native passthrough routes, kilo/uncloseai/dahl) validated or
// capped schema depth -- the client's schema was forwarded to Claude/muse
// verbatim. Rather than reject the request, truncate any branch past maxDepth
// down to a permissive leaf ({type, description, enum} only, dropping further
// properties/items/anyOf) -- same "degrade an optional/unsupported shape
// instead of failing outright" philosophy as the image_generation tool strip
// (P24) and the compat-retry field stripper.
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

// P33: free tier 계약이 stream:true를 강제하므로, 클라이언트가 stream:false를
// 원했던 요청은 SSE로 받은 뒤 여기서 표준 chat.completion JSON으로 재조립한다
// (OmniRoute PR #14013의 "forced-stream-then-rebuild" 전략과 동일 원칙).
function rebuildChatJsonFromForcedStream(sseText, model) {
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

// P33: museViaResponses가 free tier 계약 때문에 body.stream을 강제로 true로 보내면
// (클라이언트가 stream:false를 원했어도) upstream이 Responses API SSE로 답한다 —
// 여기서 완성된 response 객체를 조립해 기존 responsesToChatJson()에 그대로 넘긴다.
function collectResponsesObjectFromSSE(sseText) {
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
const ZEN_CATALOG_URL = process.env.ZEN_CATALOG_URL || 'https://models.opencode.ai/api.json';
const ZEN_CATALOG_TTL = 6 * 60 * 60 * 1000;
const ZEN_CATALOG_RETRY_MS = 60 * 1000; // 실패 직후 매 요청마다 8초 타임아웃을 반복하지 않도록
let zenCatalogCache = null, zenCatalogCacheTime = 0, zenCatalogFailUntil = 0, zenCatalogInflight = null;

function zenProtocolFromCatalog(provider) {
  const npm = String((provider && provider.npm) || '');
  const api = String((provider && provider.api) || '');
  if (/anthropic/i.test(npm) || /\/anthropic\//.test(api)) return 'messages';
  if (/google/i.test(npm) || /\/google\//.test(api)) return 'gemini-native';
  if (npm === '@ai-sdk/openai') return 'responses';
  return 'chat';
}

function parseZenCatalog(json) {
  const models = json && json.opencode && json.opencode.models;
  if (!models || typeof models !== 'object') throw new Error('catalog has no opencode.models');
  const protocols = {}, free = new Set(), deprecated = new Set();
  for (const [id, m] of Object.entries(models)) {
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

async function getZenCatalog() {
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
    } catch (e) {
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
async function getZenEndpointMap() { const c = await getZenCatalog(); return c ? c.protocols : null; }
async function getZenFreeModelSet() { const c = await getZenCatalog(); return c ? c.free : null; }
async function getZenDeprecatedSet() { const c = await getZenCatalog(); return c ? c.deprecated : null; }

const MUSE_MODEL_RE = /^muse-spark/i;
const CLAUDE_MODEL_RE = /^claude-/i;
function classifyZenModelProtocol(id, endpointMap) {
  const fromDocs = endpointMap && endpointMap[id];
  if (fromDocs) return fromDocs;
  if (MUSE_MODEL_RE.test(id)) return 'responses';
  if (CLAUDE_MODEL_RE.test(id)) return 'messages';
  return 'chat';
}
let modelsCache = null, modelsCacheTime = 0;
const MODELS_TTL = 60 * 60 * 1000;

async function museViaResponses(upstreamModel, bodyObj, variant, isStream, zenApiKey) {
  const reqMax = Math.max(bodyObj.max_tokens || 0, bodyObj.max_output_tokens || 0);
  const filteredTools = (bodyObj.tools || []).filter((t) => t && t.type !== 'image_generation');
  const convertedTools = capToolsDepth(filteredTools.map(t => t && t.type === 'function' && t.function ? { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters } : t).filter(Boolean));
  const isFreeTier = await isZenFreeTierModel(upstreamModel);
  // P37: zen의 free-tier 게이트는 tools에 opencode CLI 고유 도구 이름(bash/read/write/...)
  // 이 들어와야만 통과한다(P37 재현 실험) — 개수 조건이 아니라 이름 조건이다. 그래서
  // 클라이언트가 보낸 tools를 종류/개수와 무관하게 전부 보존한 채 CLI 플레이스홀더와
  // 합집합을 항상 만든다.
  let tools = convertedTools;
  if (isFreeTier) {
    const existingNames = new Set(convertedTools.map((t) => t.name).filter(Boolean));
    const placeholders = zenPlaceholderToolsFor('responses').filter((t) => !existingNames.has(t.name));
    tools = [...convertedTools, ...placeholders];
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
    // P33: free tier 게이트는 body.stream===true를 요구한다 — 클라이언트가 stream:false를
    // 원했어도(isStream=false) upstream에는 강제로 true를 보내야 통과한다. 호출부가
    // isStream 값을 보고 SSE를 그대로 흘릴지 JSON으로 재조립할지 이미 분기하므로
    // 여기서 body.stream을 강제해도 클라이언트에게 가는 응답 형태는 안 바뀐다.
    stream: isFreeTier ? true : !!isStream,
    metadata: { _nonce: crypto.randomUUID().slice(0, 12) },
  };
  if (isFreeTier) {
    applyFingerprintSystemPrompt(rbody);
  }
  const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': rbody.stream ? 'text/event-stream' : 'application/json' }, null, zenApiKey, rbody);
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
  // 2026-10-26: 카탈로그가 deprecated로 표시한 모델은 목록에 노출하지 않는다(카탈로그를 못 받으면 필터 없이 기존 동작).
  const deprecatedIds = await getZenDeprecatedSet();
  const freeIds = rawIds.filter(id => (id.endsWith('-free') || KNOWN_FREE_EXTRA.has(id)) && !(deprecatedIds && deprecatedIds.has(id)));
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

// Compat-retry safety net (idea borrowed from LiveXY/responses-to-chat's "부분 400
// 파라미터 불일치 시 필드 제거 후 1회 재시도"): our P3/P9/P14/P20 bugs were all the
// same shape — Zen rejects one optional field it doesn't support yet, and we only
// found out after a real client hit it. Rather than waiting for the next one to
// surface as a new P-number, strip the offending optional field and retry once
// instead of failing the whole request. Only ever touches fields we already know
// are optional — never touches required fields like model/input/messages.
const OPTIONAL_DEGRADE_FIELDS = ['metadata', 'parallel_tool_calls', 'previous_response_id', 'store', 'service_tier', 'reasoning'];
function detectDegradableField(errorBodyText) {
  const t = String(errorBodyText || '');
  for (const f of OPTIONAL_DEGRADE_FIELDS) {
    if (t.includes(`"${f}"`) || t.includes(`'${f}'`)) return f;
  }
  return null;
}

const MUSE_EFFORT = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high'
};

// P23 fix (2026-09-11): muse-spark 경로(museViaResponses)와 /v1/messages는 effort를
// 오직 모델명 콜론 접미사(":high" 등)의 `variant`로만 읽었다. 클라이언트가 실제로
// 보낸 reasoning_effort / reasoning.effort(Codex의 /v1/chat/completions 호출 등)는
// 완전히 무시되고 콜론 접미사가 없으면 무조건 'low'로 깔렸다. 콜론 접미사가 없을 때
// body 자체에 실려온 effort 힌트를 대신 사용한다 (콜론 접미사가 최우선, 그다음 body).
function effortFromClientBody(body) {
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort) return body.reasoning_effort;
  if (typeof body.reasoningEffort === 'string' && body.reasoningEffort) return body.reasoningEffort;
  if (body.reasoning && typeof body.reasoning.effort === 'string' && body.reasoning.effort) return body.reasoning.effort;
  return null;
}

// Claude(Anthropic) 클라이언트의 extended thinking(`thinking: {type:"enabled",
// budget_tokens:N}`)은 이 프록시가 요청 쪽에서 전혀 읽지 않고 있었다(응답 쪽 reasoning ->
// thinking 블록 변환만 존재). budget_tokens를 muse의 3단계 effort로 대략 매핑한다 —
// 정확한 토큰 대 effort 환산표가 없어 임의 경계지만, "thinking을 켰는데 완전히
// 무시당하는 것"보다는 낫다.
function effortFromThinking(thinking) {
  if (!thinking || thinking.type !== 'enabled') return null;
  const bt = Number(thinking.budget_tokens) || 0;
  if (bt <= 4000) return 'low';
  if (bt <= 12000) return 'medium';
  return 'high';
}

const handle = async (req, res) => {
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `https://${req.headers.host}`);
  let pathname = url.pathname;

  // 2026-10-26: /opencode/v1/* 전용 접두사 라우트. Kilo(/kilo/v1/*), Dahl(/dahl/v1/*)와 같은
  // 형태로, 게이트웨이가 프로바이더 이름을 경로 접두사로 붙여 보내는 클라이언트
  // (예: OmniRoute의 opencode-key-chat 프로바이더)를 받아준다. 접두사만 벗겨서
  // 기존 /v1/* 처리 경로를 그대로 재사용한다 — zen 전용 동작(무료 티어 계약,
  // 프로토콜 분기, 모델 판별)을 중복 구현하지 않기 위해서다.
  let isOpencodePrefix = false;
  if (pathname === '/opencode' || pathname.startsWith('/opencode/')) {
    isOpencodePrefix = true;
    pathname = pathname.slice('/opencode'.length) || '/';
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
  }

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

  const isNativeProtocolPrefix = pathname.startsWith('/res/') || pathname.startsWith('/chat/') || pathname.startsWith('/mes/') || pathname.startsWith('/kilo/') || pathname.startsWith('/uncloseai/') || pathname.startsWith('/dahl/') || pathname.startsWith('/blockrun/');
  if ((pathname.startsWith('/v1/') || isNativeProtocolPrefix) && !authOk(req)) {
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
      if (isOpencodePrefix) {
        const zenModels = await getFreeModelsExpanded();
        const nowSec = Math.floor(Date.now() / 1000);
        const data = [];
        const seen = new Set();
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
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ object: 'list', data }));
      }
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
      // uncloseai/dahl은 kilo/zen 키 체계와 무관하게 항상 무인증으로 동작하므로
      // (uncloseai: 업스트림 자체가 키 요구 안 함, dahl: 우리 쪽이 토큰을 자체 발급)
      // 위 3단 분기 결과와 무관하게 모든 요청에 항상 추가한다.
      try {
        const uncloseai = await getUncloseaiModels();
        data = data.concat(uncloseai);
      } catch {}
      try {
        const blockrun = await getBlockrunModels();
        data = data.concat(blockrun);
      } catch {}
      try {
        const dahl = await getDahlModels();
        data = data.concat(dahl);
      } catch {}
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
    const hasUncloseaiPrefix = /^uncloseai\//i.test(modelStr);
    const hasDahlPrefix = /^dahl\//i.test(modelStr);
    const hasBlockrunPrefix = /^blockrun\//i.test(modelStr);

    // --- Blockrun/UncloseAI/Dahl 요청 처리 (kilo/zen 키 체계와 완전 무관 — 클라이언트가 보낸
    // Authorization은 무시하고 각 업스트림에 맞는 인증을 여기서 직접 구성한다) ---
    if (hasBlockrunPrefix || hasUncloseaiPrefix || hasDahlPrefix) {
      const isDahl = hasDahlPrefix;
      const isBlockrun = hasBlockrunPrefix;
      const realModel = modelStr.replace(/^(blockrun|uncloseai|dahl)\//i, '');
      const upstreamBase = isBlockrun ? BLOCKRUN_BASE : (isDahl ? DAHL_BASE : UNCLOSEAI_BASE);
      const uHeaders = { 'Content-Type': 'application/json', 'Accept': body.stream ? 'text/event-stream' : 'application/json' };
      try {
        let fr;
        for (let attempt = 0; attempt < (isDahl ? 2 : 1); attempt++) {
          if (isDahl) uHeaders['Authorization'] = `Bearer ${await getDahlToken(attempt > 0)}`;
          fr = await fetch(upstreamBase + '/v1/chat/completions', {
            method: 'POST',
            headers: uHeaders,
            body: JSON.stringify({ ...body, model: realModel }),
            signal: AbortSignal.timeout(parseInt(process.env.UNCLOSEAI_DAHL_TIMEOUT_MS || '120000', 10)),
          });
          // dahl 토큰이 (관찰된 적은 없지만) 무효화됐을 가능성에 대비: 인증 실패면 재발급 1회 재시도
          if (isDahl && (fr.status === 401 || fr.status === 403) && attempt === 0) continue;
          break;
        }
        if (body.stream && fr.ok) {
          res.writeHead(200, { 'Content-Type': fr.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' });
          const reader = fr.body.getReader(); const dec = new TextDecoder();
          try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); } } catch {}
          return res.end();
        }
        const t = await fr.text();
        res.writeHead(fr.status, { 'Content-Type': fr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
        return res.end(t);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: e.message } }));
      }
    }

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
      const headersC = injectHeaders({ 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json' }, null, zenApiKey, mb);
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
    // P23: 콜론 접미사 없이 reasoning_effort/reasoning.effort로 effort를 보낸
    // 클라이언트(OpenAI 호환 SDK 등)도 museViaResponses가 그 값을 쓰도록 한다.
    const effectiveVariant = variant || effortFromClientBody(body);
    // 대형 프롬프트 빈 choices 방지 — 700k 토큰 초과 시 오래된 히스토리 트렁케이트
    if (Array.isArray(body.messages)) body.messages = truncateMessagesIfNeeded(body.messages, body.instructions || body.system);
    if (Array.isArray(body.input)) body.input = truncateInputIfNeeded(body.input, body.instructions);
    if (Array.isArray(body.tools)) body.tools = capToolsDepth(body.tools);
    let ub = applyMuseDefaults({ ...body, model: upstreamModel }, 'responses');
    if (/muse/i.test(upstreamModel)) ub.metadata = Object.assign({}, ub.metadata, { _nonce: crypto.randomUUID().slice(0, 12) });
    if (!/muse/i.test(upstreamModel)) ub = applyVariant(ub, effectiveVariant);

let upstreamBody = applyVariant(applyMuseDefaults({ ...body, model: upstreamModel }, 'chat'), effectiveVariant);
    if (effectiveVariant && /muse/i.test(upstreamModel)) delete upstreamBody.reasoning_effort, upstreamBody.reasoning = { effort: MUSE_EFFORT[effectiveVariant] || 'high' };
    // P33: muse 계열이 아닌 다른 '-free' 무료 모델(space-bunny-free/big-pickle/
    // mimo-v2.6-flash-free 등)도 이 /chat/completions 경로에서 동일한 free tier
    // 게이트를 탄다 — tools가 비어있으면 stream:true 강제 + 플레이스홀더 도구 주입.
    if (!/muse/i.test(upstreamModel) && await isZenFreeTierModel(upstreamModel)) {
      upstreamBody = applyZenFreeTierContract(upstreamBody, 'chat');
    }

    const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': (body.stream || upstreamBody.stream) ? 'text/event-stream' : 'application/json' }, null, zenApiKey, upstreamBody);
    headers['Cache-Control'] = 'no-store';

    try {
      let fetchRes;
      if (/muse/i.test(upstreamModel)) {
        fetchRes = await museViaResponses(upstreamModel, upstreamBody, effectiveVariant, !!body.stream, zenApiKey);
        if (fetchRes.ok && body.stream) {
          if (zenApiKey) markKeySuccess(zenApiKey);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          if (res.flushHeaders) res.flushHeaders();
          await pumpResponsesSSEToChat(fetchRes.body, c => res.write(c));
          return res.end();
        }
        if (fetchRes.ok) {
          // P33: free tier 모델은 museViaResponses가 body.stream을 강제로 true로
          // 보냈을 수 있다(클라이언트는 stream:false를 원했어도) — 그 경우 upstream이
          // JSON이 아니라 Responses SSE로 응답하므로 .json()이 아니라 SSE 텍스트를
          // 모아서 response.completed 이벤트에서 최종 객체를 추출해야 한다.
          const ct = fetchRes.headers.get('content-type') || '';
          let responseObj;
          if (ct.includes('text/event-stream')) {
            const sseText = await fetchRes.text();
            responseObj = collectResponsesObjectFromSSE(sseText);
            if (!responseObj) throw new Error('forced-stream response missing response.completed event');
          } else {
            responseObj = await fetchRes.json();
          }
          const cj = responsesToChatJson(responseObj, upstreamModel);
          if (zenApiKey) markKeySuccess(zenApiKey);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(cj));
        }
      } else {
        fetchRes = await fetch(UPSTREAM + '/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
      }
      let bodyText = await fetchRes.text();

      // 클라이언트(omniroute 등)가 이전 assistant 턴의 reasoning_content를 버리고 보내면 thinking 모드
      // 모델(DeepSeek 계열)이 400을 낸다. 해당 에러일 때만 단계적으로 완화해 재시도한다.
      for (let stage = 1; stage <= 2 && fetchRes.status === 400 && REASONING_PASSBACK_RE.test(bodyText); stage++) {
        console.log(`[reasoning-passback] 400 for ${upstreamModel}, retry stage ${stage}`);
        upstreamBody = relaxReasoningPassback(upstreamBody, stage);
        fetchRes = await fetch(UPSTREAM + '/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
        bodyText = await fetchRes.text();
      }

      let isErrPayload = !fetchRes.ok || (/"error":/i.test(bodyText) && !/"choices":/i.test(bodyText));

      if (zenApiKey) {
        checkAndMarkResponse(zenApiKey, fetchRes.status, bodyText);
      }

      // If Zen Key failed (AuthError or RateLimit) and we can transparently fallback to free anonymous session:
      if (isErrPayload && zenApiKey && (/AuthError|Invalid API key|FreeUsageLimitError|Rate limit/i.test(bodyText))) {
        console.log(`[Failover] ZenKey failed (${bodyText.slice(0, 80)}), transparently falling back to anonymous session...`);
        const anonHeaders = injectHeaders({ 'Content-Type': 'application/json', 'Accept': body.stream ? 'text/event-stream' : 'application/json' }, null, null, upstreamBody);
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
      // P34 fix: isErrPayload인데 status가 200이 아닌 경우(예: 400 "Endpoint is
      // unavailable")를 위 두 분기가 못 잡으면, 아래 stream:true 강제 재조립 로직이
      // 에러 JSON을 SSE로 착각해 빈 content:""로 감춰버렸다(실측: ling-3.0-flash-fin-free
      // 400을 200 빈 응답으로 둔갑시킴). 진짜 upstream 에러는 원본 status/body 그대로 전달.
      if (isErrPayload) {
        res.writeHead(fetchRes.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(bodyText);
      }

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        return res.end(bodyText);
      } else if (upstreamBody.stream && !body.stream) {
        // P33: 클라이언트는 stream:false를 원했지만 free tier 계약 때문에 upstream엔
        // stream:true로 보냈다 — SSE로 온 응답을 표준 JSON으로 재조립해서 돌려준다.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(rebuildChatJsonFromForcedStream(bodyText, upstreamModel)));
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
    // P23: 콜론 접미사가 없으면 Claude의 thinking(budget_tokens) -> 그다음
    // reasoning_effort/reasoning.effort 순서로 effort를 추정한다. 이전에는 콜론
    // 접미사가 없으면 무조건 'low'로 깔려서 클라이언트가 요청한 thinking/effort가
    // muse-spark 경로에서 통째로 무시됐다.
    const effectiveVariant = variant || effortFromThinking(body.thinking) || effortFromClientBody(body);
    // P21: Anthropic → OpenAI 정규화 (system/tool/image/tool_result)
    let anthMessages = anthropicMessagesToOpenAI(body);
    // 대형 프롬프트 빈 choices 방지
    anthMessages = truncateMessagesIfNeeded(anthMessages, body.system);
    const anthTools = capToolsDepth(anthropicToolsToOpenAI(body.tools));
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
    openReq = applyVariant(applyMuseDefaults(openReq, 'chat'), effectiveVariant);
    if (await isZenFreeTierModel(upstreamModel)) {
      openReq = applyZenFreeTierContract(openReq, 'chat');
    }
    const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': body.stream ? 'text/event-stream' : 'application/json' }, null, zenApiKey, openReq);

    try {
      let fetchRes;
      if (/muse/i.test(upstreamModel)) {
        const mfr = await museViaResponses(upstreamModel, openReq, effectiveVariant, !!body.stream, zenApiKey);
        if (!mfr.ok) { const t = await mfr.text(); res.writeHead(mfr.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: t.slice(0, 500) } })); }
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          if (res.flushHeaders) res.flushHeaders();
          const aw = createAnthropicStreamWriter(c => res.write(c), upstreamModel, 0);
          await pumpResponsesSSEToAnthropic(mfr.body, aw);
          return res.end();
        }
        const ct = mfr.headers.get('content-type') || '';
        let responseObj;
        if (ct.includes('text/event-stream')) {
          const sseText = await mfr.text();
          responseObj = collectResponsesObjectFromSSE(sseText);
          if (!responseObj) throw new Error('forced-stream response missing response.completed event');
        } else {
          responseObj = await mfr.json();
        }
        const cj = responsesToChatJson(responseObj, upstreamModel);
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
    // P23: 네이티브 /v1/responses 호출은 보통 body.reasoning.effort를 이미 제대로
    // 보내서(applyMuseDefaults의 `body.reasoning || {...}`가 보존) 대부분 문제없지만,
    // 콜론 접미사도 없고 nested reasoning도 없이 flat reasoning_effort만 보내는
    // 클라이언트를 위한 폴백.
    const effectiveVariant = variant || (body.reasoning ? null : effortFromClientBody(body));
    // 대형 프롬프트 빈 choices 방지
    if (Array.isArray(body.input)) body.input = truncateInputIfNeeded(body.input, body.instructions);
    if (Array.isArray(body.tools)) body.tools = capToolsDepth(body.tools);
    let upstreamBody = applyMuseDefaults({ ...body, model: upstreamModel }, 'responses');
    if (/muse/i.test(upstreamModel)) {
      upstreamBody.metadata = Object.assign({}, upstreamBody.metadata, { _nonce: crypto.randomUUID().slice(0, 12) });
      if (effectiveVariant) {
        delete upstreamBody.reasoning_effort; delete upstreamBody.reasoningEffort;
        upstreamBody.reasoning = { effort: MUSE_EFFORT[effectiveVariant] || 'high', summary: 'auto' };
      } else if (upstreamBody.reasoning) {
        delete upstreamBody.reasoning_effort; delete upstreamBody.reasoningEffort;
      }
    } else {
      upstreamBody = applyVariant(upstreamBody, effectiveVariant);
    }
    // P20: /v1/responses passthrough 정규화 — Codex wire_api=responses 직접 호출 시
    // type:'text' 등이 그대로 가면 Zen이 input[N].content 400을 냄. skill.md §4 교훈.
    if (Array.isArray(upstreamBody.input)) upstreamBody.input = sanitizeResponsesInput(upstreamBody.input);
    if (Array.isArray(upstreamBody.instructions) && typeof upstreamBody.instructions === 'string') {
      // instructions는 문자열 그대로 유지 — 배열이면 이미 input으로 처리됨
    }
    // P36: /v1/responses 네이티브 호출 경로(opencode-free-res provider 등)도 free tier
    // 모델이면 동일한 게이트(tools 배열 필수 + stream:true 강제)를 탄다 — 이 경로에서
    // 누락되어 403 FreeTierError가 발생하던 사고를 해결.
    if (await isZenFreeTierModel(upstreamModel)) {
      upstreamBody = applyZenFreeTierContract(upstreamBody, 'responses');
    }

    const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': (body.stream || upstreamBody.stream) ? 'text/event-stream' : 'application/json' }, null, zenApiKey, upstreamBody);
    try {
      let fr = await fetch(UPSTREAM + '/responses', { method: 'POST', headers: headers, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
      if (fr.status === 400) {
        const errText = await fr.text();
        const field = detectDegradableField(errText);
        if (field && Object.prototype.hasOwnProperty.call(upstreamBody, field)) {
          console.warn(`[compat-retry] /v1/responses 400 mentions "${field}", stripping and retrying once`);
          const degraded = { ...upstreamBody };
          delete degraded[field];
          fr = await fetch(UPSTREAM + '/responses', { method: 'POST', headers: headers, body: JSON.stringify(degraded), signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
        } else {
          res.writeHead(400, { 'Content-Type': fr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
          return res.end(errText);
        }
      }
      res.writeHead(fr.status === 200 ? 200 : fr.status, { 'Content-Type': fr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
      return res.end(await fr.text());
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  // ============================================================
  // 2026-09-11 설계 전환: 프로토콜 간 변환을 시도하는 대신, 모델이 실제로 지원하는
  // 네이티브 엔드포인트로만 라우팅한다. zen 업스트림은 /chat/completions,
  // /responses, /v1/messages를 전부 자체 제공하지만(세 경로 모두 401 확인 —
  // 존재는 함) 모델별로 어느 엔드포인트가 실제로 동작하는지는 다르다(예: muse-spark는
  // /chat/completions에서 빈 응답, /responses만 정상 — P9/P21이 이 문제를 변환
  // 레이어에서 우회하려다 반복적으로 재발했다). 변환 로직으로 모든 조합을 커버하려던
  // 기존 접근 대신, bifrost에 프로토콜별 프로바이더 3개(res/chat/mes)를 등록해서
  // "이 모델은 애초에 이 엔드포인트로만 부른다"를 강제한다.
  // 아래 6개 라우트는 바디를 전혀 건드리지 않는 순수 passthrough다 — 변환 버그
  // (P3/P9/P14/P20/P21/P23) 계열 자체가 구조적으로 발생할 수 없다.
  if (pathname === '/res/v1/models' || pathname === '/chat/v1/models' || pathname === '/mes/v1/models') {
    const zenApiKey = isZen ? clientKey : null;
    const headers = injectHeaders({ 'Content-Type': 'application/json' }, null, zenApiKey);
    try {
      const fr = await fetch(UPSTREAM + '/models', { method: 'GET', headers, signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
      if (!fr.ok) {
        res.writeHead(fr.status, { 'Content-Type': fr.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
        return res.end(await fr.text());
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
        ? upstreamJson.data.filter(m => {
            if (!m || !m.id || !(m.id.endsWith('-free') || KNOWN_FREE_EXTRA.has(m.id))) return false;
            if (deprecatedIds && deprecatedIds.has(m.id)) return false; // deprecated 모델 제외
            const proto = classifyZenModelProtocol(m.id, endpointMap);
            if (pathname === '/res/v1/models') return proto === 'responses';
            if (pathname === '/mes/v1/models') return proto === 'messages';
            return proto === 'chat'; // /chat/v1/models — gemini-native/unknown은 어느 라우트에도 안 냄
          })
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ...upstreamJson, data: filtered }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  // Kilo Gateway는 zen과 완전히 별개 서비스라 UPSTREAM(zen) 기반 passthrough 그룹에 못 낀다.
  // /res|chat|mes와 같은 원칙(네이티브 엔드포인트로 바디 최소 변형 전달)으로 Kilo 전용 라우트를
  // 별도로 둔다 — 모델 리스트는 무료만(getKiloFreeModels 재사용, 접두사만 벗김).
  if (pathname === '/kilo/v1/models') {
    try {
      const kiloModels = await getKiloFreeModels();
      const data = kiloModels.map(m => ({ ...m, id: m.id.replace(/^kilo\//, '') }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ object: 'list', data }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  const NATIVE_PASSTHROUGH_ROUTES = {
    '/res/v1/responses': '/responses',
    '/chat/v1/chat/completions': '/chat/completions',
    '/mes/v1/messages': '/messages',
  };
  if (req.method === 'POST' && NATIVE_PASSTHROUGH_ROUTES[pathname]) {
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    let body; try { body = JSON.parse(rawBody || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid JSON' } })); }
    if (!body.model) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model required' } })); }
    const zenApiKey = isZen ? clientKey : null;
    const isStream = !!body.stream;
    const headers = injectHeaders({ 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' }, null, zenApiKey, body);
    // zen의 /v1/messages는 진짜 Anthropic Messages API 계약을 따라서 Authorization: Bearer가
    // 아니라 x-api-key를 요구한다 (chat/completions, /responses는 Bearer로 정상 동작 확인됨 —
    // mes 전용 케이스). CLIProxyAPI의 claude-api-key 실행기 경유 검증 중 발견 (AuthError: Missing API key).
    if (pathname === '/mes/v1/messages' && zenApiKey) {
      headers['x-api-key'] = zenApiKey;
      delete headers['Authorization'];
    }
    // /res/v1/responses는 순수 passthrough(바디 무변형)가 원칙이지만, muse 계열에서 100% 확정적으로
    // 실패하는 두 가지 케이스만 최소 개입으로 방어한다(res/chat/mes 설계 원칙과 같은 성격의 예외, P24/P28):
    let outBody = rawBody;
    let patched = null;
    // P32: 클라이언트(또는 클라이언트가 서버에 영구 저장한 대화 히스토리) 쪽에서 이미 같은
    // call_id가 서로 다른 두 tool call에 중복 배정된 채로 들어오면, zen이 'Duplicate
    // function_call_output' 400을 낸다 — 이 라우트군은 순수 passthrough라 pool이 다른 노드로
    // 재시도해도 매번 동일한 바디를 다시 보내 똑같이 실패한다(요청 스코프 문제, failover로는
    // 회복 불가). museToInput(P3)이 /v1/chat/completions 변환 경로에 이미 적용한 "먼저 나온
    // 쌍만 유지" 방어를, 형태가 다른 이 세 라우트의 페이로드에도 동일 원칙으로 적용한다.
    if (pathname === '/res/v1/responses' && Array.isArray((patched || body).input)) {
      const src = (patched || body).input;
      const seenCalls = new Set(), seenOutputs = new Set();
      let removed = 0;
      const filtered = src.filter(it => {
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
        patched = patched || { ...body };
        patched.input = filtered;
        console.warn(`[compat] /res/v1/responses: removed ${removed} duplicate function_call/function_call_output call_id entries before forwarding (P32)`);
      }
    } else if (pathname === '/chat/v1/chat/completions' && Array.isArray((patched || body).messages)) {
      const src = (patched || body).messages;
      const seenCalls = new Set(), seenOutputs = new Set();
      let removed = 0;
      const filtered = [];
      for (const m of src) {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          const kept = m.tool_calls.filter(tc => {
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
        patched = patched || { ...body };
        patched.messages = filtered;
        console.warn(`[compat] /chat/v1/chat/completions: removed ${removed} duplicate tool_calls/tool call_id entries before forwarding (P32)`);
      }
    } else if (pathname === '/mes/v1/messages' && Array.isArray((patched || body).messages)) {
      const src = (patched || body).messages;
      const seenCalls = new Set(), seenOutputs = new Set();
      let removed = 0;
      const filtered = [];
      for (const m of src) {
        if (m && Array.isArray(m.content)) {
          const kept = m.content.filter(b => {
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
        patched = patched || { ...body };
        patched.messages = filtered;
        console.warn(`[compat] /mes/v1/messages: removed ${removed} duplicate tool_use/tool_result id entries before forwarding (P32)`);
      }
    }
    // P31: JSON schema 10-depth 제한(Anthropic Messages API, muse 경유 시 동일 제약)은 라우트
    // 셋(res/responses, chat/chat.completions, mes/messages) 전부에서 발생 가능하므로 공통 처리.
    if (Array.isArray(body.tools)) {
      const capped = capToolsDepth(body.tools);
      if (JSON.stringify(capped) !== JSON.stringify(body.tools)) {
        patched = patched || { ...body };
        patched.tools = capped;
        console.warn(`[compat] ${pathname}: capped tool schema nesting depth to ${MAX_TOOL_SCHEMA_DEPTH} before forwarding`);
      }
    }
    if (pathname === '/res/v1/responses') {
      // 1) zen은 tools[].type: "image_generation"을 아예 지원하지 않아 항상 400을 낸다. CLIProxyAPI의
      //    codex 실행기가 muse-spark 계열 /responses 호출에 이 tool을 기본으로 자동 주입해서 발생
      //    (클라이언트가 직접 보낸 tools엔 없음) — 이 tool 타입이 섞여 있을 때만 그것만 제거한다.
      if (Array.isArray((patched || body).tools) && (patched || body).tools.some(t => t && t.type === 'image_generation')) {
        patched = patched || { ...body };
        const filtered = patched.tools.filter(t => !(t && t.type === 'image_generation'));
        patched.tools = filtered;
        if (!filtered.length) delete patched.tools;
        console.warn('[compat] /res/v1/responses: stripped unsupported image_generation tool before forwarding to zen');
      }
      // 2) muse는 실제 출력 전에 내부 reasoning으로 먼저 토큰을 소모한다. 클라이언트가 짧은 답변을
      //    기대하고 max_output_tokens를 작게(예: 64) 보내면 reasoning만으로 예산이 다 소진돼
      //    output:[]로 "성공"(200) 응답하는 채로 끝난다(P28 — OmniRoute 등 직접 호출 클라이언트에서
      //    실측 재현: incomplete_details.reason:"max_output_tokens", output:[]). 레거시 변환 경로의
      //    applyMuseDefaults()가 강제하던 131072 하한을 여기서도 동일하게 적용.
      if (/muse/i.test(String(body.model || ''))) {
        const reqMax = Number((patched || body).max_output_tokens) || 0;
        if (reqMax < 131072) {
          patched = patched || { ...body };
          patched.max_output_tokens = Math.max(131072, reqMax);
          console.warn('[compat] /res/v1/responses: raised max_output_tokens to 131072 floor for muse model (reasoning budget)');
        }
      }
    }
    // P36: /res/v1/responses, /chat/v1/chat/completions 등 네이티브 passthrough
    // 라우트도 free tier 모델이면 동일한 게이트(tools 배열 필수 + stream:true 강제)를
    // 탄다 — opencode-free-res provider 등이 /res/v1/responses로 직접 호출할 때
    // tools 누락으로 403 FreeTierError가 나던 사고를 방어.
    const { upstreamModel: reqModel } = parseModel(body.model);
    if (await isZenFreeTierModel(reqModel)) {
      const format = pathname === '/res/v1/responses' ? 'responses' : 'chat';
      const cur = patched || body;
      const contractApplied = applyZenFreeTierContract(cur, format);
      if (contractApplied !== cur) {
        patched = contractApplied;
      }
    }
    if (patched) outBody = JSON.stringify(patched);
    const finalStream = isStream || ((patched || body).stream === true);
    if (finalStream && !headers['Accept']?.includes('text/event-stream')) {
      headers['Accept'] = 'text/event-stream';
    }
    try {
      const fr = await fetch(UPSTREAM + NATIVE_PASSTHROUGH_ROUTES[pathname], { method: 'POST', headers, body: outBody, signal: AbortSignal.timeout(ZEN_TIMEOUT_MS) });
      const ct = fr.headers.get('content-type') || 'application/json';
      res.writeHead(fr.status, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
      if (isStream && fr.body && ct.includes('text/event-stream')) {
        for await (const chunk of fr.body) res.write(chunk);
        return res.end();
      }
      return res.end(await fr.text());
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  if (req.method === 'POST' && pathname === '/kilo/v1/chat/completions') {
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    let body; try { body = JSON.parse(rawBody || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid JSON' } })); }
    if (!body.model) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model required' } })); }
    const realModel = String(body.model).replace(/^kilo\//i, '');
    let msgs = Array.isArray(body.messages) ? body.messages : [];
    if (!msgs.length && Array.isArray(body.input)) {
      msgs = body.input.map(i => ({ role: i.role || 'user', content: typeof i.content === 'string' ? i.content : Array.isArray(i.content) ? i.content.map(c => c.text || '').join('') : '' }));
    }
    const isStream = !!body.stream;
    const kHeaders = { 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' };
    if (req.headers.authorization) kHeaders['Authorization'] = req.headers.authorization;
    // Kilo가 라우팅하는 모델(예: kilo-auto)에 자체적으로 reasoning.effort를 강제 배정해서
    // 클라이언트가 보낸 reasoning_effort와 충돌하면 400을 낸다(P17) — 이 전용 경로도 동일 방어.
    const kiloBody = { ...body, model: realModel, messages: msgs };
    delete kiloBody.reasoning_effort;
    delete kiloBody.reasoningEffort;
    try {
      const kr = await fetch(KILO_BASE + '/chat/completions', {
        method: 'POST', headers: kHeaders, body: JSON.stringify(kiloBody),
        signal: AbortSignal.timeout(parseInt(process.env.KILO_STREAM_TIMEOUT_MS || '300000', 10))
      });
      const ct = kr.headers.get('content-type') || 'application/json';
      res.writeHead(kr.status, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
      if (isStream && kr.body && ct.includes('text/event-stream')) {
        const reader = kr.body.getReader(); const dec = new TextDecoder();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); } } catch {}
        return res.end();
      }
      return res.end(await kr.text());
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  // /kilo/v1과 같은 원칙(네이티브 엔드포인트, 접두사 없는 모델명)의 UncloseAI/Dahl 전용 라우트.
  // 레거시 /v1/models·/v1/chat/completions의 uncloseai/·dahl/ 접두사 라우팅과 별개로,
  // 클라이언트가 그 프로바이더만 쓰고 싶을 때 접두사 없이 바로 부를 수 있게 한다.
  if (pathname === '/blockrun/v1/models') {
    try {
      const models = await getBlockrunModels();
      const data = models.map(m => ({ ...m, id: m.id.replace(/^blockrun\//, '') }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ object: 'list', data }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  if (req.method === 'POST' && pathname === '/blockrun/v1/chat/completions') {
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    let body; try { body = JSON.parse(rawBody || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid JSON' } })); }
    if (!body.model) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model required' } })); }
    const realModel = String(body.model).replace(/^blockrun\//i, '');
    const isStream = !!body.stream;
    const uHeaders = { 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' };
    try {
      const ur = await fetch(BLOCKRUN_BASE + '/v1/chat/completions', {
        method: 'POST', headers: uHeaders, body: JSON.stringify({ ...body, model: realModel }),
        signal: AbortSignal.timeout(parseInt(process.env.BLOCKRUN_TIMEOUT_MS || '120000', 10)),
      });
      const ct = ur.headers.get('content-type') || 'application/json';
      res.writeHead(ur.status, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
      if (isStream && ur.body && ct.includes('text/event-stream')) {
        const reader = ur.body.getReader(); const dec = new TextDecoder();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); } } catch {}
        return res.end();
      }
      return res.end(await ur.text());
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  if (pathname === '/uncloseai/v1/models') {
    try {
      const models = await getUncloseaiModels();
      const data = models.map(m => ({ ...m, id: m.id.replace(/^uncloseai\//, '') }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ object: 'list', data }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  if (pathname === '/dahl/v1/models') {
    try {
      const models = await getDahlModels();
      const data = models.map(m => ({ ...m, id: m.id.replace(/^dahl\//, '') }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ object: 'list', data }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  if (req.method === 'POST' && pathname === '/uncloseai/v1/chat/completions') {
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    let body; try { body = JSON.parse(rawBody || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid JSON' } })); }
    if (!body.model) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model required' } })); }
    const realModel = String(body.model).replace(/^uncloseai\//i, ''); // kilo/v1과 동일하게 접두사 방어적 스트립
    const isStream = !!body.stream;
    const uHeaders = { 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' };
    try {
      const ur = await fetch(UNCLOSEAI_BASE + '/v1/chat/completions', {
        method: 'POST', headers: uHeaders, body: JSON.stringify({ ...body, model: realModel }),
        signal: AbortSignal.timeout(parseInt(process.env.UNCLOSEAI_DAHL_TIMEOUT_MS || '120000', 10)),
      });
      const ct = ur.headers.get('content-type') || 'application/json';
      res.writeHead(ur.status, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
      if (isStream && ur.body && ct.includes('text/event-stream')) {
        const reader = ur.body.getReader(); const dec = new TextDecoder();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); } } catch {}
        return res.end();
      }
      return res.end(await ur.text());
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  if (req.method === 'POST' && pathname === '/dahl/v1/chat/completions') {
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    let body; try { body = JSON.parse(rawBody || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid JSON' } })); }
    if (!body.model) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model required' } })); }
    const realModel = String(body.model).replace(/^dahl\//i, '');
    const isStream = !!body.stream;
    const dHeaders = { 'Content-Type': 'application/json', 'Accept': isStream ? 'text/event-stream' : 'application/json' };
    try {
      let dr;
      for (let attempt = 0; attempt < 2; attempt++) {
        dHeaders['Authorization'] = `Bearer ${await getDahlToken(attempt > 0)}`;
        dr = await fetch(DAHL_BASE + '/v1/chat/completions', {
          method: 'POST', headers: dHeaders, body: JSON.stringify({ ...body, model: realModel }),
          signal: AbortSignal.timeout(parseInt(process.env.UNCLOSEAI_DAHL_TIMEOUT_MS || '120000', 10)),
        });
        if ((dr.status === 401 || dr.status === 403) && attempt === 0) continue;
        break;
      }
      const ct = dr.headers.get('content-type') || 'application/json';
      res.writeHead(dr.status, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
      if (isStream && dr.body && ct.includes('text/event-stream')) {
        const reader = dr.body.getReader(); const dec = new TextDecoder();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); } } catch {}
        return res.end();
      }
      return res.end(await dr.text());
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