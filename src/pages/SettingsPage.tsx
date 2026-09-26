import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { useAdminMutation } from "@/hooks/useAdminMutation";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Settings2,
  CalendarSearch,
  CheckCircle2,
  ShieldCheck,
  ShieldOff,
  ShieldAlert,
  Lock,
  RefreshCw,
  ShieldX,
  Activity,
  AlertTriangle,
  KeyRound,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  clearApiCache, clearTBAErrCache,
  getStatboticsHealth, subscribeStatboticsHealth, checkStatboticsHosts,
  statboticsHostLabel,
  type StatboticsHealth,
} from "@/lib/api";
import { useUIStore } from "@/store/uiStore";

// ── TBA API key card ──────────────────────────────────────────────────────────
// Write-only: the server never sends the key back (tba.hasKey is a boolean), so
// once saved it's gone from the screen for everyone, including the admin who
// typed it. The input is a password field and is cleared right after saving.

function TbaKeyCard({ eventKey }: { eventKey?: string }) {
  const hasKey = useQuery(api.tba.hasKey);
  const setKey = useAdminMutation(api.tba.setKey);
  const clearKey = useAdminMutation(api.tba.clearKey);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await setKey({ key: value });
      setValue("");
      if (eventKey) clearTBAErrCache(eventKey);
      toast.success("TBA key saved.", { description: "Reload data (Clear Cache) to pull schedules." });
    } catch (e) {
      toast.error(e instanceof Error && e.message.includes("look like") ? "That doesn't look like a TBA API key." : "Failed to save key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    try {
      await clearKey({});
      toast.success("Stored TBA key removed.");
    } catch {
      toast.error("Failed to remove key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-primary" />
        <h3 className="font-semibold">TBA API Key</h3>
      </div>
      <div className="flex items-center gap-2 text-sm">
        {hasKey
          ? <><CheckCircle2 className="h-4 w-4 text-emerald-500" /> A key is configured.</>
          : <><AlertTriangle className="h-4 w-4 text-amber-500" /> No key set — schedules, teams and rankings can't load.</>}
      </div>
      <div className="space-y-1.5">
        <Label>{hasKey ? "Replace key" : "Enter key"}</Label>
        <Input
          type="password"
          autoComplete="off"
          placeholder="Paste TBA read key"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
        />
        <p className="text-xs text-muted-foreground">
          Get one at thebluealliance.com/account. Once saved it is hidden and can't be viewed again.
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={busy || !value.trim()} className="flex-1">
          {busy ? "Saving…" : "Save key"}
        </Button>
        {hasKey && (
          <Button variant="outline" onClick={handleRemove} disabled={busy}>Remove</Button>
        )}
      </div>
    </div>
  );
}

// ── Statbotics source card ────────────────────────────────────────────────────
// EPA data comes from the official Statbotics API, with a community mirror as
// an automatic standby. Which one is live is otherwise invisible — a silent
// failover looks identical to working normally until the mirror also goes down,
// so admins get to see it here.

function StatboticsSourceCard() {
  const [health, setHealth] = useState<StatboticsHealth>(() => getStatboticsHealth());
  const [checking, setChecking] = useState(false);

  useEffect(() => subscribeStatboticsHealth(setHealth), []);

  const onMirror = health.active === "mirror";

  async function handleRecheck() {
    setChecking(true);
    try {
      const result = await checkStatboticsHosts();
      if (result.primary) {
        toast.success("Official Statbotics API is up — switched back to it.");
      } else if (result.mirror) {
        toast.warning("Official API is still down. Using the mirror.");
      } else {
        toast.error("Both Statbotics hosts are unreachable.");
      }
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <h3 className="font-semibold">Statbotics Data Source</h3>
      </div>

      <div
        className={`flex items-start gap-3 rounded-lg border p-3 ${
          onMirror
            ? "border-emerald-500/40 bg-emerald-500/10"
            : "border-amber-500/40 bg-amber-500/10"
        }`}
      >
        {onMirror
          ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-500" />
          : <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />}
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">
            {onMirror ? "Using live mirror" : "Using official API (mirror failed)"}
          </p>
          <p className="text-xs text-muted-foreground break-all">
            {statboticsHostLabel(health.active)}
          </p>
          <p className="text-xs text-muted-foreground">
            {onMirror
              ? "EPA data is coming from the community mirror, which is kept live. The official API is the standby if the mirror fails."
              : "The mirror failed recently, so EPA data is coming from the official Statbotics API. It retries the mirror automatically every 5 minutes."}
          </p>
        </div>
      </div>

      {health.lastError && (
        <p className="text-xs text-muted-foreground">
          Last failure: {statboticsHostLabel(health.lastError.source)}
          {health.lastError.status > 0 ? ` returned ${health.lastError.status}` : " was unreachable"}
          {" · "}
          {new Date(health.lastError.at).toLocaleString()}
        </p>
      )}

      <Separator />

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Re-check both hosts</p>
        <Button variant="outline" size="sm" onClick={handleRecheck} disabled={checking}>
          {checking ? "Checking…" : "Re-check"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Tests the official API and the mirror right now, and switches back to the
        official one if it has recovered.
      </p>
    </div>
  );
}

// ── Admin Mode Card ────────────────────────────────────────────────────────────

function AdminModeCard() {
  const { isAdminMode, setAdminMode } = useUIStore();

  // The server is the only real gate — requireAdmin accepts an inherent admin
  // email or an active temporary grant, and re-checks it on every privileged
  // mutation regardless of this toggle. This query tells the UI whether the
  // caller is currently eligible at all, so non-admins can't turn the toggle
  // on, and a temporary admin whose 12-hour grant lapses gets switched back
  // automatically instead of sitting in a UI that no longer does anything.
  const isEligible = useQuery(api.admin.isCurrentUserAdmin);

  useEffect(() => {
    if (isEligible === false && isAdminMode) {
      setAdminMode(false);
      toast.info("Admin mode turned off.", {
        description: "Your admin access is no longer active.",
      });
    }
  }, [isEligible, isAdminMode, setAdminMode]);

  function handleDisable() {
    setAdminMode(false);
    toast.success("Admin mode disabled.");
  }

  function handleEnable() {
    if (!isEligible) return;
    setAdminMode(true);
    toast.success("Admin mode enabled.", {
      description: "You now have access to Form Builder and report deletion.",
    });
  }

  return (
    <div
      className={`border rounded-xl p-5 space-y-4 transition-colors ${
        isAdminMode
          ? "bg-amber-500/5 border-amber-500/40"
          : "bg-card border-border"
      }`}
    >
      {isEligible === false && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
          <ShieldX className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Admin is restricted</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Only designated team leads, or scouts they've temporarily granted
              admin access, can enable admin mode.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isAdminMode ? (
            <ShieldCheck className="h-4 w-4 text-amber-500" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-primary" />
          )}
          <h3 className="font-semibold">Admin Mode</h3>
          {isAdminMode && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-500 uppercase tracking-wider">
              Active
            </span>
          )}
        </div>
        {isAdminMode ? (
          <Button
            size="sm"
            variant="outline"
            className="border-amber-500/50 text-amber-500 hover:bg-amber-500/10 gap-1.5"
            onClick={handleDisable}
          >
            <ShieldOff className="h-3.5 w-3.5" />
            Disable
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={handleEnable}
            disabled={!isEligible}
            title={isEligible === false ? "Admin mode is restricted to team leads" : undefined}
          >
            <Lock className="h-3.5 w-3.5" />
            Enable
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        {isAdminMode
          ? "Admin mode is active. You can access the Form Builder and delete scouting reports."
          : "Admin mode restricts access to the Form Builder and report deletion to designated team leads."}
      </p>
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { isAdminMode } = useUIStore();

  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const setCurrentEvent = useAdminMutation(api.events.setCurrentEvent);

  const [eventKey, setEventKey] = useState("");
  const [eventName, setEventName] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearCacheConfirm, setClearCacheConfirm] = useState(false);

  async function handleSaveEvent() {
    if (!eventKey.trim()) {
      toast.error("Event key is required.");
      return;
    }
    setSaving(true);
    try {
      await setCurrentEvent({
        eventKey: eventKey.trim(),
        eventName: eventName.trim() || eventKey.trim(),
      });
      toast.success("Event set!");
    } catch {
      toast.error("Failed to save event.");
    } finally {
      setSaving(false);
    }
  }

  function handleClearCache() {
    clearApiCache();
    setClearCacheConfirm(false);
    toast.success("Cache cleared — data will refresh on next load.");
  }

  return (
    <div className="max-w-xl space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Settings2 className="h-6 w-6 text-primary" />
          Settings
        </h2>
        <p className="text-muted-foreground text-sm">Configure event and app preferences</p>
      </div>

      {/* Admin Mode */}
      <AdminModeCard />

      {/* Event */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarSearch className="h-4 w-4 text-primary" />
            <h3 className="font-semibold">Current Event</h3>
          </div>
          {!isAdminMode && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              <Lock className="h-3 w-3" />
              Admin only
            </span>
          )}
        </div>

        {currentEvent ? (
          <div className="flex items-center gap-3 px-3 py-2 bg-primary/10 rounded-lg text-sm">
            <span className="font-mono text-primary font-bold">{currentEvent.eventKey}</span>
            <span className="text-muted-foreground">·</span>
            <span>{currentEvent.eventName}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg text-sm text-muted-foreground">
            <CalendarSearch className="h-3.5 w-3.5 shrink-0" />
            No event set yet.
          </div>
        )}

        {isAdminMode ? (
          <>
            <Separator />

            <div className="space-y-1.5">
              <Label>
                TBA Event Key{" "}
                <span className="text-muted-foreground font-normal text-xs">(e.g. 2025chcmp)</span>
              </Label>
              <Input
                placeholder="2025chcmp"
                value={eventKey}
                onChange={(e) => setEventKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSaveEvent()}
              />
              <p className="text-xs text-muted-foreground">
                Find it in the event URL on{" "}
                <a
                  href="https://www.thebluealliance.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  thebluealliance.com
                </a>
                .
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>
                Event Display Name{" "}
                <span className="text-muted-foreground font-normal text-xs">(optional)</span>
              </Label>
              <Input
                placeholder="2025 NE District Boston"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSaveEvent()}
              />
            </div>

            <Button onClick={handleSaveEvent} disabled={saving} className="w-full">
              {saving ? "Saving…" : "Set Event"}
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
            <ShieldX className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            Only admins can change the active event. Enable Admin Mode above to update it.
          </div>
        )}
      </div>

      {/* Statbotics source — admin-facing diagnostics */}
      {isAdminMode && <TbaKeyCard eventKey={currentEvent?.eventKey} />}
      {isAdminMode && <StatboticsSourceCard />}

      {/* Data cache */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">Data</h3>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Clear data cache</p>
          <Button variant="outline" size="sm" onClick={() => setClearCacheConfirm(true)}>
            Clear Cache
          </Button>
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          Forces team lists, rankings and match data to refresh on next load.
          Your scouting data and anything waiting to sync is kept.
        </p>

        <AlertDialog open={clearCacheConfirm} onOpenChange={setClearCacheConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear the data cache?</AlertDialogTitle>
              <AlertDialogDescription>
                This deletes cached team lists, rankings, match schedules and team
                avatars. They re-download the next time you&apos;re online.
                <br /><br />
                Your scouting submissions, QR codes, scanned data and anything
                waiting to sync are not touched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleClearCache}>
                Clear cache
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
