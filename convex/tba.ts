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
// Only approved users may call it, and only for a fixed allowlist of read paths,
// so it can't be turned into a general-purpose proxy for the key.

import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getApprovedUserId } from "./adminAuth";

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
    const key = process.env.TBA_API_KEY;
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
