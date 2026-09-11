import { query } from "./_generated/server";
import { isCurrentUserAdminEligible } from "./adminAuth";

/**
 * Whether the signed-in caller's account is on the admin allowlist.
 *
 * The Settings page uses this to decide whether "Enable" grants real admin
 * mode or just previews the UI — the actual privileged mutations re-check
 * this independently on the server, so this query is purely informational.
 */
export const isCurrentUserAdmin = query({
  args: {},
  handler: async (ctx) => isCurrentUserAdminEligible(ctx),
});
