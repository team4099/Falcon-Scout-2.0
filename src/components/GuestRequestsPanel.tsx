import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { Ban, Check, ChevronDown, X, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Decision = "approved" | "denied";

/**
 * Admin view of guest applications (non-@team4099.com accounts). Pending
 * requests are listed first with Approve/Deny; approved guests can be revoked
 * and denied ones re-approved. Every action is re-checked by requireAdmin in
 * convex/guests.ts — this panel is only ever shown in Admin Mode.
 *
 * It renders even with nothing to show. It used to return null on an empty
 * list, which meant an admin hunting for "where do I approve guests?" found an
 * absence rather than an answer — indistinguishable from the feature not
 * existing. The empty state says where requests come from instead.
 *
 * The list collapses behind the header so a long roster doesn't push the rest
 * of Manage Scouts off the screen. It opens by default only while something is
 * pending, so work that needs an admin is never hidden.
 *
 * Each row shows the guest's FRC team, editable in place — guests approved
 * before the team field existed have none until an admin fills it in.
 *
 * Approved guests can be put on the current event's roster from here (so they
 * get scheduled), and any guest can be deactivated to clear them out of this
 * list; they come back only if they sign in again (guests.listRequests).
 */
export default function GuestRequestsPanel() {
  const isAdmin = useQuery(api.admin.isCurrentUserAdmin);
  const requests = useQuery(api.guests.listRequests);
  const decide = useMutation(api.guests.decideRequest);
  const addToRoster = useMutation(api.roster.addToRoster);
  const deactivate = useMutation(api.admin.deactivateUser);
  const reactivate = useMutation(api.admin.reactivateUser);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);

  // Still loading, or the caller isn't admin-eligible (listRequests returns []
  // for them regardless — this just avoids showing an empty admin panel).
  if (requests === undefined || !isAdmin) return null;

  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");
  // Until the admin clicks, pending requests decide whether the list is shown.
  const open = openOverride ?? pending.length > 0;

  async function act(id: Id<"guestAccess">, email: string, decision: Decision) {
    setBusyId(id);
    try {
      await decide({ id, decision });
      toast.success(
        decision === "approved" ? `${email} approved.` : `${email} denied.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't update that request.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function run(id: string, fn: () => Promise<unknown>, ok: string, undo?: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await fn();
      toast.success(ok, undo && { action: { label: "Undo", onClick: () => void undo().catch(() => {}) } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="shrink-0 rounded-xl border border-border bg-card p-4 space-y-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpenOverride(!open)}
        className="flex w-full items-center gap-2 text-left"
      >
        <UserPlus className="h-4 w-4 shrink-0 text-primary" />
        <h2 className="text-sm font-semibold">Guest access</h2>
        {pending.length > 0 && (
          <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
            {pending.length} pending
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {requests.length > 0 && <span>{requests.length}</span>}
          <ChevronDown
            className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && requests.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No guest requests yet. Anyone signing in through{" "}
          <span className="font-medium text-foreground">Guest access</span> on
          the login screen appears here for approval.
        </p>
      )}

      {open && (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto">
          {[...pending, ...decided].map((r) => (
            <li
              key={r._id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5"
            >
              <div className="min-w-0 flex-1 basis-48">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">
                    {r.name || r.email}
                  </p>
                  <TeamNumberInput id={r._id} teamNumber={r.teamNumber} />
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {r.email}
                </p>
                {r.message && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    “{r.message}”
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {r.status !== "pending" && (
                  <span
                    className={`text-xs font-medium ${
                      r.status === "approved"
                        ? "text-green-500"
                        : "text-muted-foreground"
                    }`}
                  >
                    {r.status === "denied" ? "Denied" : r.onRoster ? "On roster" : "Approved"}
                  </span>
                )}
                {r.status === "approved" && r.userId && !r.onRoster && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1"
                    disabled={busyId === r._id}
                    onClick={() =>
                      run(r._id, () => addToRoster({ userIds: [r.userId!] }), `${r.name || r.email} added to the roster.`)
                    }
                  >
                    <UserPlus className="h-3.5 w-3.5" /> Add to event
                  </Button>
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
                    <X className="h-3.5 w-3.5" />{" "}
                    {r.status === "approved" ? "Revoke" : "Deny"}
                  </Button>
                )}
                {r.userId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 text-muted-foreground"
                    title="Deactivate: hide this guest until they sign in again"
                    aria-label={`Deactivate ${r.name || r.email}`}
                    disabled={busyId === r._id}
                    onClick={() => {
                      const userId = r.userId!;
                      if (!window.confirm(`Deactivate ${r.name || r.email}? They'll be hidden until they sign in again.`)) return;
                      run(
                        r._id,
                        () => deactivate({ userId }),
                        `${r.name || r.email} deactivated.`,
                        () => reactivate({ userId }),
                      );
                    }}
                  >
                    <Ban className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Inline team # editor. Saves on blur or Enter; clearing the field removes the
 * team. The server (guests.setTeamNumber) re-validates and requires admin.
 */
function TeamNumberInput({
  id,
  teamNumber,
}: {
  id: Id<"guestAccess">;
  teamNumber?: number;
}) {
  const setTeamNumber = useMutation(api.guests.setTeamNumber);
  const saved = teamNumber?.toString() ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;

  async function commit() {
    if (draft === null || draft === saved) return setDraft(null);
    try {
      await setTeamNumber({ id, teamNumber: draft ? Number(draft) : null });
      toast.success(draft ? `Team set to ${draft}.` : "Team cleared.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save team.");
    } finally {
      setDraft(null);
    }
  }

  return (
    <label
      className={`flex shrink-0 items-center rounded-full border px-2 text-[11px] font-bold ${
        value
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-dashed border-border text-muted-foreground"
      }`}
      title="Guest's FRC team"
    >
      Team
      <input
        value={value}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        inputMode="numeric"
        placeholder="#"
        aria-label="Team number"
        className="w-12 bg-transparent py-0.5 pl-1 outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}
