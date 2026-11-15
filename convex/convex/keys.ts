import { mutation, query } from "./_generated/server";

/** Bearer keys self-expire so a leaked key stops working without manual rotation. */
const KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Rotate this long before expiry so callers polling /key never see a dead key. */
export const ROTATE_AHEAD_MS = 24 * 60 * 60 * 1000;

function newKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return (
    "fk_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * Returns the current usable key, minting one when the store is empty or the
 * newest key is inside the rotation window. Retired keys are marked inactive
 * instead of deleted so a stale client fails auth with 401 rather than a
 * confusing "no key configured" 503.
 */
export const ensureActive = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("apiKeys").collect();
    const usable = rows
      .filter((r) => r.active && r.expiresAt - now > ROTATE_AHEAD_MS)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (usable) return usable;

    for (const r of rows.filter((r) => r.active)) {
      await ctx.db.patch(r._id, { active: false });
    }

    const createdAt = now;
    const expiresAt = now + KEY_TTL_MS;
    const key = newKey();
    await ctx.db.insert("apiKeys", { key, createdAt, expiresAt, active: true });
    return { key, createdAt, expiresAt, active: true, _id: null as unknown as string };
  },
});

/** Read-only fast path: index lookup, no table scan, no write transaction. */
export const peekActive = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("apiKeys")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    const usable = rows
      .filter((r) => r.expiresAt - now > ROTATE_AHEAD_MS)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return usable ? { key: usable.key, expiresAt: usable.expiresAt } : null;
  },
});

/** Metadata only — never returns the secret itself. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("apiKeys").collect();
    const active = rows.filter((r) => r.active && r.expiresAt > now);
    const latest = active.sort((a, b) => b.createdAt - a.createdAt)[0];
    return {
      activeCount: active.length,
      expiresAt: latest?.expiresAt ?? null,
      rotatesInMs: latest ? latest.expiresAt - now : null,
    };
  },
});