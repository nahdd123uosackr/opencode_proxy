import { httpAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { handleRequest as proxyFetch } from "./main";
import { api } from "../_generated/api";

/** Convex HTTP action adapter around the runtime-neutral opencode_proxy handler. */
function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

async function gate(ctx: ActionCtx, request: Request): Promise<Response | null> {
  const provided = (
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-proxy-key") ??
    ""
  ).trim();
  if (!provided) {
    return Response.json(
      { error: { type: "authentication_error", message: "Missing bearer token" } },
      { status: 401 }
    );
  }
  if (process.env.PROXY_API_KEY && provided === process.env.PROXY_API_KEY) return null;
  // Pool forwards a browser-minted Dahl key under this prefix; the inner handler uses it upstream.
  if (provided.startsWith("dahl_")) return null;
  try {
    const row = (await ctx.runQuery(api.keys.peekActive, {})) ?? (await ctx.runMutation(api.keys.ensureActive, {}));
    if (provided === row.key || (process.env.FREE_AI_KEY && provided === process.env.FREE_AI_KEY)) return null;
  } catch {
    // Key store unreachable: fall through to the static env keys only.
  }
  const staticKeys = [process.env.PROXY_API_KEY, process.env.FREE_AI_KEY].filter(Boolean);
  if (staticKeys.includes(provided)) return null;
  return Response.json(
    { error: { type: "authentication_error", message: "Invalid API key" } },
    { status: 401 }
  );
}

function withMeta(response: Response, request: Request, startedAt: number): Response {
  const headers = new Headers(response.headers);
  headers.set("x-proxy-egress", clientIp(request));
  headers.set("x-proxy-duration-ms", String(Date.now() - startedAt));
  return new Response(response.body, { status: response.status, headers });
}

/** Strips the /proxy mount prefix so the inner handler sees the same paths it serves on Deno. */
function rebase(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname === "/proxy" || url.pathname.startsWith("/proxy/")) {
    url.pathname = url.pathname.slice("/proxy".length) || "/";
  }
  return new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    duplex: "half",
  } as RequestInit);
}

export const proxy = httpAction(async (ctx, request) => {
  const denied = await gate(ctx, request);
  if (denied) return denied;
  const startedAt = Date.now();
  try {
    const response = await proxyFetch(rebase(request), { ...process.env });
    return withMeta(response, request, startedAt);
  } catch (err) {
    return Response.json(
      { error: { message: err instanceof Error ? err.message : String(err), type: "proxy_error" } },
      { status: 502 }
    );
  }
});
