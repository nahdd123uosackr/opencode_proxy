import { getServiceToken } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api } from "./_generated/api";

const GATEWAY = "https://ai-gateway.convex.dev";
const MODELS_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type ModelRow = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
};

let cache: { at: number; free: ModelRow[]; all: ModelRow[] } | null = null;

function isFreeModelId(id: string): boolean {
  return id.toLowerCase().includes("free");
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  // The gateway authenticates with a short-lived token minted inside the HTTP action.
  headers.set("Authorization", `Bearer ${await getServiceToken("ai-gateway")}`);
  if (!headers.has("Content-Type") && init?.body) headers.set("Content-Type", "application/json");
  return await fetch(`https://ai-gateway.convex.dev${path}`, { ...init, headers });
}

async function loadModels(force = false): Promise<{ free: ModelRow[]; all: ModelRow[] }> {
  if (!force && cache && Date.now() - cache.at < MODELS_TTL_MS) return cache;
  const res = await gatewayFetch("/v1/models", { method: "GET" });
  if (!res.ok) throw new Error(`gateway /v1/models failed: ${res.status}`);
  const json = (await res.json()) as { data?: ModelRow[] };
  const all = Array.isArray(json.data) ? json.data : [];
  const free = all.filter((m) => isFreeModelId(m.id));
  cache = { at: Date.now(), free, all };
  return { free, all };
}

function errorResponse(status: number, message: string, code: string, type = "invalid_request_error") {
  return Response.json({ error: { message, type, code } }, { status, headers: CORS });
}

function extractApiKey(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const alt = request.headers.get("x-api-key");
  return alt ? alt.trim() : null;
}

/** Cached DB key so a per-request mutation is not needed on every call. */
let keyCache: { value: string; expiresAt: number; at: number } | null = null;
const KEY_CACHE_MS = 60 * 1000;

async function activeKey(ctx: ActionCtx): Promise<string | null> {
  if (keyCache && Date.now() - keyCache.at < KEY_CACHE_MS && Date.now() < keyCache.expiresAt) {
    return keyCache.value;
  }
  try {
    const row =
      (await ctx.runQuery(api.keys.peekActive, {})) ??
      (await ctx.runMutation(api.keys.ensureActive, {}));
    keyCache = { value: row.key, expiresAt: row.expiresAt, at: Date.now() };
    return row.key;
  } catch (err) {
    console.log(`[keys] ensureActive failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function checkAccess(ctx: ActionCtx, request: Request): Promise<Response | null> {
  const provided = extractApiKey(request);
  if (!provided) {
    return errorResponse(401, "Missing bearer token", "invalid_api_key", "authentication_error");
  }
  const bootstrap = process.env.FREE_AI_KEY;
  if (bootstrap && provided === bootstrap) return null;
  const generated = await activeKey(ctx);
  // The bootstrap env key stays valid so a deployment can roll out the
  // self-rotating store without dropping in-flight clients.
  const accepted = [generated, bootstrap].filter(
    (k): k is string => typeof k === "string" && k.length > 0
  );
  if (accepted.length === 0) {
    return errorResponse(503, "Endpoint is not configured: no API key available", "misconfigured", "server_error");
  }
  if (!accepted.includes(provided)) {
    return errorResponse(401, "Invalid authentication credentials", "invalid_api_key", "authentication_error");
  }
  return null;
}

/** Shared secret guarding the key-distribution endpoint used by the pool. */
function checkKeySyncSecret(request: Request): Response | null {
  const expected = process.env.KEY_SYNC_SECRET;
  if (!expected) {
    return errorResponse(503, "KEY_SYNC_SECRET is not configured", "misconfigured", "server_error");
  }
  if (request.headers.get("x-key-sync-secret") !== expected) {
    return errorResponse(401, "Invalid key sync secret", "invalid_api_key", "authentication_error");
  }
  return null;
}

function forwardedHeaders(upstream: Response): Headers {
  const headers = new Headers(CORS);
  const contentType = upstream.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  const retryAfter = upstream.headers.get("Retry-After");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return headers;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return errorResponse(413, "Request body exceeds 16 MiB", "request_too_large");
  }
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON body", "invalid_json");
  }
}

async function ensureFreeModel(model: unknown): Promise<Response | null> {
  if (typeof model !== "string" || model.trim() === "") {
    return errorResponse(400, "`model` is required", "missing_model");
  }
  const { free, all } = await loadModels();
  if (free.some((m) => m.id === model)) return null;
  const known = all.some((m) => m.id === model);
  return errorResponse(
    403,
    known
      ? `Model "${model}" is not free. This endpoint only proxies free models (ids ending in ":free").`
      : `Unknown model "${model}". See GET /v1/models for the free catalog.`,
    "model_not_free"
  );
}

export const corsPreflight = httpAction(async () => {
  return new Response(null, { status: 204, headers: CORS });
});

export const debug = httpAction(async (ctx, request) => {
  const denied = await checkAccess(ctx, request);
  if (denied) return denied;
  const steps: Record<string, unknown> = {};
  try {
    const token = await getServiceToken("ai-gateway");
    steps.serviceToken = token ? `ok(len=${token.length})` : "empty";
  } catch (err) {
    steps.serviceToken = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    const started = Date.now();
    const res = await gatewayFetch("/v1/models", { method: "GET" });
    steps.modelsStatus = res.status;
    steps.modelsMs = Date.now() - started;
    const text = await res.text();
    steps.modelsBytes = text.length;
    steps.modelsHead = text.slice(0, 120);
  } catch (err) {
    steps.models = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return Response.json(steps, { headers: CORS });
});

export const health = httpAction(async (ctx) => {
  let keyStatus: unknown = null;
  try {
    keyStatus = await ctx.runQuery(api.keys.status, {});
  } catch {
    keyStatus = null;
  }
  return Response.json(
    {
      ok: true,
      upstream: GATEWAY,
      requiresClientKey: true,
      key: keyStatus,
    },
    { headers: CORS }
  );
});

export const models = httpAction(async (ctx, request) => {
  const denied = await checkAccess(ctx, request);
  if (denied) return denied;
  try {
    const { free } = await loadModels();
    return Response.json(
      { object: "list", data: free.map((m) => ({ ...m, free: true })) },
      { headers: CORS }
    );
  } catch (err) {
    return errorResponse(502, err instanceof Error ? err.message : String(err), "upstream_error", "server_error");
  }
});

export const chatCompletions = httpAction(async (ctx, request) => {
  const denied = await checkAccess(ctx, request);
  if (denied) return denied;

  const parsed = await readJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  const modelError = await ensureFreeModel(body.model);
  if (modelError) return modelError;

  const wantsStream = body.stream === true;
  let upstream: Response;
  try {
    upstream = await gatewayFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: wantsStream }),
    });
  } catch (err) {
    return errorResponse(502, err instanceof Error ? err.message : String(err), "upstream_error", "server_error");
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: forwardedHeaders(upstream),
    });
  }

  if (!wantsStream) {
    return new Response(await upstream.text(), { status: upstream.status, headers: forwardedHeaders(upstream) });
  }

  return new Response(upstream.body, { status: 200, headers: forwardedHeaders(upstream) });
});

export const embeddings = httpAction(async (ctx, request) => {
  const denied = await checkAccess(ctx, request);
  if (denied) return denied;

  const parsed = await readJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  const modelError = await ensureFreeModel(body.model);
  if (modelError) return modelError;

  let upstream: Response;
  try {
    upstream = await gatewayFetch("/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return errorResponse(502, err instanceof Error ? err.message : String(err), "upstream_error", "server_error");
  }

  return new Response(await upstream.text(), { status: upstream.status, headers: forwardedHeaders(upstream) });
});
/**
 * Key distribution for infrastructure clients (opencode pool). Guarded by a
 * separate shared secret so the bearer key never has to be shipped as a static
 * file that silently goes stale when the store rotates it.
 */
export const currentKey = httpAction(async (ctx, request) => {
  const denied = checkKeySyncSecret(request);
  if (denied) return denied;
  const key = await activeKey(ctx);
  if (!key) {
    return errorResponse(503, "No key available", "misconfigured", "server_error");
  }
  const status = await ctx.runQuery(api.keys.status, {});
  return Response.json({ key, ...status }, { headers: CORS });
});
