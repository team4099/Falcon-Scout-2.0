import { useState } from "react";
import { useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "../../convex/_generated/api";

/**
 * Shown to a signed-in, non-@team4099.com account that hasn't been approved.
 * They can apply (status "none"), or see that their application is waiting on
 * an admin ("pending") or was declined ("denied"). All data stays locked on
 * the server regardless — see requireUser in convex/adminAuth.ts.
 */
export default function GuestAccessPage({
  status,
  email,
}: {
  status: "none" | "pending" | "denied";
  email?: string;
}) {
  const { signOut } = useAuthActions();
  const requestAccess = useMutation(api.guests.requestAccess);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleApply() {
    setSubmitting(true);
    try {
      await requestAccess({ message });
      toast.success("Request sent. An admin will review it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send your request.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-card border border-border rounded-2xl p-6 space-y-4 shadow-xl shadow-black/10">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-black tracking-tight">Guest access</h1>
          {email && <p className="text-xs font-mono text-muted-foreground">{email}</p>}
        </div>

        {status === "none" && (
          <>
            <p className="text-sm text-muted-foreground text-center">
              FalconScout is for Team 4099. Ask a team admin for guest access and they'll review
              your request.
            </p>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Who are you and why do you need access? (optional)"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <Button className="w-full h-11" onClick={handleApply} disabled={submitting}>
              {submitting ? "Sending…" : "Request access"}
            </Button>
          </>
        )}

        {status === "pending" && (
          <p className="text-sm text-muted-foreground text-center">
            Your request is waiting for an admin. This page updates on its own once you're
            approved — no need to sign in again.
          </p>
        )}

        {status === "denied" && (
          <p className="text-sm text-muted-foreground text-center">
            Your request wasn't approved. If you think that's a mistake, talk to a team admin.
          </p>
        )}

        <Button variant="ghost" className="w-full" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
