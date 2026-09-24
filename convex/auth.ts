import { convexAuth } from "@convex-dev/auth/server";
import Google from "@auth/core/providers/google";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import type { GenericQueryCtx, AnyDataModel } from "convex/server";
import type { Id } from "./_generated/dataModel";

/**
 * The session JWT only carries a `sub` claim by default — no email, no other
 * profile fields. adminAuth.ts's isAdminEmail reads
 * ctx.auth.getUserIdentity()?.email, which without this is always undefined
 * in a real deployment (convex-test's fake identities let you set `email`
 * directly on the test identity, which is why the allowlist tests passed
 * while the live "Enable" button stayed disabled for every account, inherent
 * admins included). Stamping the user's stored email onto the token as a
 * custom claim is what makes that check possible. Exported so it can be unit
 * tested directly — convex-test's `withIdentity` bypasses real token
 * generation, so there is no other way to cover this.
 */
export async function authCustomClaims(
  ctx: GenericQueryCtx<AnyDataModel>,
  { userId }: { userId: Id<"users"> },
) {
  const user = await ctx.db.get(userId);
  return { email: user?.email };
}

// Anonymous sign-in is only wired up when ALLOW_DEV_LOGIN is set on this
// deployment's Convex env vars. Set it ONLY on your local `convex dev`
// deployment (`npx convex env set ALLOW_DEV_LOGIN true`) so you can skip
// Google login while testing on localhost. Never set it on the prod
// deployment Vercel talks to — the gate lives here on the server, so even a
// tampered client can't summon a provider the deployment didn't register.
const devProviders =
  process.env.ALLOW_DEV_LOGIN === "true"
    ? [
        // Give the throwaway dev user a real-looking name/email so leaderboards,
        // schedules and submission attribution render like they do in prod.
        Anonymous({
          profile: () => ({
            name: "Dev Scout",
            email: "dev@team4099.com",
            isAnonymous: true as const,
          }),
        }),
        // Second dev-only provider so admin-only screens (Form Builder, Manage
        // Scouts, Scheduling edit mode, resolving bets) are reachable on
        // localhost without a real @team4099.com Google account. The email
        // here is only treated as admin-eligible when ALLOW_DEV_LOGIN is set
        // (see DEV_ADMIN_EMAIL in convex/adminAuth.ts) — same gate as this
        // whole provider, so it's a no-op on any deployment that didn't
        // explicitly opt in.
        Anonymous({
          id: "dev-admin",
          profile: () => ({
            name: "Dev Admin",
            email: "devadmin@team4099.com",
            isAnonymous: true as const,
          }),
        }),
      ]
    : [];

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      profile(profile) {
        // Anyone with a verified Google address may sign in, but only
        // @team4099.com accounts get data access automatically. Everyone else
        // lands on the guest-request screen and sees nothing until an admin
        // approves them (see convex/guests.ts and requireUser).
        if (!profile.email || profile.email_verified === false) {
          throw new Error("A verified Google email is required");
        }
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: profile.picture,
        };
      },
    }),
    ...devProviders,
  ],
  jwt: {
    customClaims: authCustomClaims,
  },
});
