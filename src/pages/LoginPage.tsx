import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useState } from "react";
import { ArrowLeft, ShieldCheck, UserPlus } from "lucide-react";

function GoogleMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function Spinner() {
  return <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />;
}

/**
 * Two deliberately separate sign-in routes:
 *
 *   Team  — the @team4099.com path. `login_hint`/domain framing only; the real
 *           check is isTeamEmail on the server.
 *   Guest — anyone else. Lands on GuestAccessPage until an admin approves,
 *           and the server hands them nothing before that (requireUser).
 *
 * Both ultimately use the same Google provider, so no extra OAuth redirect URI
 * has to be registered — the split is about which door a person walks through
 * and what they are told to expect, not about two sets of credentials.
 */
export default function LoginPage() {
  const { signIn } = useAuthActions();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"choose" | "guest">("choose");

  // Dev-only escape hatch. `import.meta.env.DEV` is false in the Vercel
  // production build, so this whole branch is dead-code-eliminated from the
  // shipped bundle. The real gate is still server-side: the anonymous
  // providers only exist on deployments with ALLOW_DEV_LOGIN=true.
  const devLoginAvailable = import.meta.env.DEV;

  async function devSignIn(provider: string) {
    setLoading(true);
    try {
      await signIn(provider, { redirectTo: "/" });
    } catch {
      toast.error("Dev login failed. Run `npx convex env set ALLOW_DEV_LOGIN true` on your dev deployment.");
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    setLoading(true);
    try {
      await signIn("google", { redirectTo: "/" });
    } catch {
      toast.error("Sign in failed. Use a Google account with a verified email.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo/branding */}
        <div className="text-center mb-8">
          <div className="mx-auto h-16 w-16 rounded-2xl bg-primary flex items-center justify-center mb-4 shadow-lg shadow-primary/30">
            <span className="text-primary-foreground font-black text-2xl">FS</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight">FalconScout</h1>
          <p className="text-muted-foreground text-sm mt-1">Team 4099 Scouting App</p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-xl shadow-black/10">
          {mode === "choose" ? (
            <>
              <div className="text-center space-y-1">
                <h2 className="font-semibold">Welcome back</h2>
                <p className="text-xs text-muted-foreground">
                  Sign in with your <span className="text-primary font-mono">@team4099.com</span> account
                </p>
              </div>

              <Button
                className="w-full h-11 gap-3 font-medium"
                onClick={handleGoogleLogin}
                disabled={loading}
              >
                {loading ? <Spinner /> : <GoogleMark />}
                {loading ? "Signing in…" : "Sign in with Team 4099"}
              </Button>

              <div className="relative py-1">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                    Not on the team?
                  </span>
                </div>
              </div>

              <Button
                variant="outline"
                className="w-full h-11 gap-2 font-medium"
                onClick={() => setMode("guest")}
                disabled={loading}
              >
                <UserPlus className="h-4 w-4" />
                Guest access
              </Button>

              {devLoginAvailable && (
                <div className="pt-2 border-t border-border space-y-2">
                  <Button variant="outline" className="w-full h-10 text-sm" onClick={() => devSignIn("anonymous")} disabled={loading}>
                    Dev login (Scout)
                  </Button>
                  <Button variant="outline" className="w-full h-10 text-sm" onClick={() => devSignIn("dev-admin")} disabled={loading}>
                    Dev login (Admin)
                  </Button>
                  <Button variant="outline" className="w-full h-10 text-sm" onClick={() => devSignIn("dev-guest")} disabled={loading}>
                    Dev login (Guest)
                  </Button>
                  <p className="text-center text-[11px] text-muted-foreground">
                    Localhost only — never shipped to production
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="text-center space-y-2">
                <div className="mx-auto h-10 w-10 rounded-xl bg-muted flex items-center justify-center">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                </div>
                <h2 className="font-semibold">Guest access</h2>
                <p className="text-xs text-muted-foreground">
                  For alumni, mentors and scouts from other teams. Sign in with any Google
                  account, then send a short request — a Team 4099 admin approves it before you
                  can see any data.
                </p>
              </div>

              <Button
                className="w-full h-11 gap-3 font-medium"
                onClick={handleGoogleLogin}
                disabled={loading}
              >
                {loading ? <Spinner /> : <GoogleMark />}
                {loading ? "Signing in…" : "Continue as guest"}
              </Button>

              <Button
                variant="ghost"
                className="w-full h-10 gap-2 text-sm"
                onClick={() => setMode("choose")}
                disabled={loading}
              >
                <ArrowLeft className="h-4 w-4" />
                Back to team sign-in
              </Button>

              {devLoginAvailable && (
                <div className="pt-2 border-t border-border">
                  <Button variant="outline" className="w-full h-10 text-sm" onClick={() => devSignIn("dev-guest")} disabled={loading}>
                    Dev login (Guest)
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
