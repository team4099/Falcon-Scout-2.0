// ── Server-side TBA proxy ─────────────────────────────────────────────────────
//
// The TBA read key used to live in every scout's browser (localStorage, the
// userSettings table, the JS bundle via VITE_TBA_KEY) — anyone with DevTools
// could copy it. It now exists only as the Convex env var TBA_API_KEY, and the
// client asks this action to make the request on its behalf.
//
//   npx convex env set TBA_API_KEY <key>          (dev)
//   npx convex env set TBA_API_KEY <key> --prod   (production)
//
// An admin can also enter the key in Settings (tba.setKey). It lands in the
// tbaConfig table, which no client query can read back — the UI only learns
// whether one is set. The stored key wins over the env var.
//
// Only approved users may call it, and only for a fixed allowlist of read paths,
// so it can't be turned into a general-purpose proxy for the key.

import { v } from "convex/values";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getApprovedUserId, isCurrentUserAdminEligible, requireAdmin } from "./adminAuth";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";

// Exactly the endpoints src/lib/api.ts uses. Keep in sync when adding one.
const ALLOWED_PATHS = [
  /^\/event\/\d{4}[a-z0-9]{1,20}\/(teams|rankings|matches|insights)$/,
  /^\/team\/frc\d{1,5}$/,
  /^\/team\/frc\d{1,5}\/media\/\d{4}$/,
];

export const isApproved = internalQuery({
  args: {},
  handler: async (ctx) => (await getApprovedUserId(ctx)) !== null,
});

/** Server-only: the key the proxy should use (Settings-entered, else env var). */
export const getKey = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> =>
    (await ctx.db.query("tbaConfig").first())?.key ?? process.env.TBA_API_KEY ?? null,
});

/** Whether a key is configured. Only admin-eligible callers get an answer, and
 *  the key itself is never returned. */
export const hasKey = query({
  args: {},
  handler: async (ctx): Promise<boolean | null> => {
    if (!(await isCurrentUserAdminEligible(ctx))) return null;
    return (await ctx.db.query("tbaConfig").first()) !== null || !!process.env.TBA_API_KEY;
  },
});

export const setKey = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    await requireAdmin(ctx);
    const trimmed = key.trim();
    // TBA read keys are 64 chars of [A-Za-z0-9]; be lenient on length.
    if (!/^[A-Za-z0-9]{20,128}$/.test(trimmed)) {
      throw new Error("That doesn't look like a TBA API key.");
    }
    const rows = await ctx.db.query("tbaConfig").collect();
    const [keep, ...extra] = rows;
    for (const r of extra) await ctx.db.delete(r._id);
    if (keep) await ctx.db.patch(keep._id, { key: trimmed, updatedAt: Date.now() });
    else await ctx.db.insert("tbaConfig", { key: trimmed, updatedAt: Date.now() });
  },
});

/** Removes the Settings-entered key (an env-var key, if any, still applies). */
export const clearKey = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    for (const r of await ctx.db.query("tbaConfig").collect()) await ctx.db.delete(r._id);
  },
});

/**
 * Returns `{ status, data }` rather than throwing so the client can tell
 * "not signed in yet" (401 — don't back off) from "TBA is down" (5xx — do).
 * 503 means the deployment has no TBA_API_KEY configured.
 */
export const fetchTba = action({
  args: { path: v.string() },
  handler: async (ctx, { path }): Promise<{ status: number; data: unknown }> => {
    if (!(await ctx.runQuery(internal.tba.isApproved))) {
      return { status: 401, data: null };
    }
    if (!ALLOWED_PATHS.some((re) => re.test(path))) {
      return { status: 400, data: null };
    }
    const key = await ctx.runQuery(internal.tba.getKey);
    if (!key) return { status: 503, data: null };

    try {
      const res = await fetch(`${TBA_BASE}${path}`, {
        headers: { "X-TBA-Auth-Key": key },
      });
      // TBA rejecting *our* key is a server misconfiguration, not the caller's
      // sign-in problem — don't let it masquerade as our own 401.
      if (res.status === 401 || res.status === 403) return { status: 503, data: null };
      if (!res.ok) return { status: res.status, data: null };
      return { status: 200, data: await res.json() };
    } catch {
      return { status: 502, data: null };
    }
  },
});
