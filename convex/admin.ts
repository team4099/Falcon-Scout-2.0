import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAdminHash, isUsingDefaultAdminPassword, requireAdmin } from "./adminAuth";

/**
 * Change the shared admin password.
 *
 * Both values are SHA-256 hashes computed in the browser — the plaintext
 * password never leaves the device. `adminKey` is the current hash and is
 * verified by requireAdmin before anything is written, so knowing the old
 * password is required to set a new one.
 */
export const setAdminPassword = mutation({
  args: {
    newHash:  v.string(),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { newHash, adminKey }) => {
    await requireAdmin(ctx, adminKey);

    const normalised = newHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalised)) {
      throw new Error("Invalid password hash.");
    }

    // Ensure the row exists (seeds from env on first use), then update it.
    await getAdminHash(ctx);
    const row = await ctx.db.query("adminConfig").first();
    if (!row) throw new Error("Admin config missing.");

    await ctx.db.patch(row._id, { passwordHash: normalised, updatedAt: Date.now() });
  },
});

/**
 * Verify an admin password hash without changing anything.
 * Lets the client confirm the password against the server when enabling admin
 * mode, so a wrong password fails at the door rather than on the first
 * privileged action.
 */
export const verifyAdminPassword = mutation({
  args: { adminKey: v.optional(v.string()) },
  handler: async (ctx, { adminKey }) => {
    await requireAdmin(ctx, adminKey);
    return true;
  },
});

/**
 * Whether the admin password is still the shipped default.
 *
 * Deliberately exposes only a boolean, never the hash. The Settings page uses
 * it to warn that admin access is effectively open, since the default is
 * public knowledge.
 */
export const adminPasswordIsDefault = query({
  args: {},
  handler: async (ctx) => isUsingDefaultAdminPassword(ctx),
});
