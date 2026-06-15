import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useState } from "react";

export default function LoginPage() {
  const { signIn } = useAuthActions();
  const [loading, setLoading] = useState(false);

  async function handleGoogleLogin() {
    setLoading(true);
    try {
      await signIn("google", { redirectTo: "/" });
    } catch {
      toast.error("Sign in failed. Make sure you're using a @team4099.com account.");
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
            {loading ? (
              <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            )}
            {loading ? "Signing in…" : "Continue with Google"}
          </Button>

          <p className="text-center text-xs text-muted-foreground pt-1">
            Only <span className="font-mono text-primary">@team4099.com</span> accounts are permitted
          </p>
        </div>
      </div>
    </div>
  );
}
