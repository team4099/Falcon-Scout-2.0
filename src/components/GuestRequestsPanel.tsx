import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { Check, X, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Decision = "approved" | "denied";

/**
 * Admin view of guest applications (non-@team4099.com accounts). Pending
 * requests are listed first with Approve/Deny; approved guests can be revoked
 * and denied ones re-approved. Every action is re-checked by requireAdmin in
 * convex/guests.ts — this panel is only ever shown in Admin Mode.
 */
export default function GuestRequestsPanel() {
  const requests = useQuery(api.guests.listRequests);
  const decide = useMutation(api.guests.decideRequest);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!requests || requests.length === 0) return null;

  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");

  async function act(id: Id<"guestAccess">, email: string, decision: Decision) {
    setBusyId(id);
    try {
      await decide({ id, decision });
      toast.success(decision === "approved" ? `${email} approved.` : `${email} denied.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update that request.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="shrink-0 rounded-xl border border-border bg-card p-4 space-y-3 max-h-72 overflow-y-auto">
      <div className="flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Guest access</h2>
        {pending.length > 0 && (
          <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
            {pending.length} pending
          </span>
        )}
      </div>

      <ul className="divide-y divide-border">
        {[...pending, ...decided].map((r) => (
          <li key={r._id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
            <div className="min-w-0 flex-1 basis-48">
              <p className="truncate text-sm font-medium">{r.name || r.email}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{r.email}</p>
              {r.message && <p className="mt-1 text-xs text-muted-foreground">“{r.message}”</p>}
            </div>
            <div className="flex items-center gap-2">
              {r.status !== "pending" && (
                <span
                  className={`text-xs font-medium ${
                    r.status === "approved" ? "text-green-500" : "text-muted-foreground"
                  }`}
                >
                  {r.status === "approved" ? "Approved" : "Denied"}
                </span>
              )}
              {r.status !== "approved" && (
                <Button
                  size="sm"
                  className="h-8 gap-1"
                  disabled={busyId === r._id}
                  onClick={() => act(r._id, r.email, "approved")}
                >
                  <Check className="h-3.5 w-3.5" /> Approve
                </Button>
              )}
              {r.status !== "denied" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1"
                  disabled={busyId === r._id}
                  onClick={() => act(r._id, r.email, "denied")}
                >
                  <X className="h-3.5 w-3.5" /> {r.status === "approved" ? "Revoke" : "Deny"}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
