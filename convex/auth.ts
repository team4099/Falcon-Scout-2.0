import { convexAuth } from "@convex-dev/auth/server";
import Google from "@auth/core/providers/google";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";

// Anonymous sign-in is only wired up when ALLOW_DEV_LOGIN is set on this
// deployment's Convex env vars. Set it ONLY on your local `convex dev`
// deployment (`npx convex env set ALLOW_DEV_LOGIN true`) so you can skip
// Google login while testing on localhost. Never set it on the prod
// deployment Vercel talks to — the gate lives here on the server, so even a
// tampered client can't summon a provider the deployment didn't register.
const devProviders =
  process.env.ALLOW_DEV_LOGIN === "true" ? [Anonymous()] : [];

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      profile(profile) {
        if (!profile.email?.endsWith("@team4099.com")) {
          throw new Error("Only team4099.com emails are allowed");
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
});
