import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
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
  KeyRound,
  Eye,
  EyeOff,
  Trash2,
  CheckCircle2,
  ExternalLink,
  ShieldCheck,
  ShieldOff,
  ShieldAlert,
  Lock,
  KeySquare,
  RefreshCw,
} from "lucide-react";
import { getTBAKey, setTBAKey, clearApiCache } from "@/lib/api";
import { useUIStore } from "@/store/uiStore";
import {
  checkAdminPassword,
  changeAdminPassword,
} from "@/lib/adminAuth";

// ── API Key field ─────────────────────────────────────────────────────────────

function ApiKeyField({
  label,
  description,
  linkHref,
  linkLabel,
  storageKey: _storageKey,
  currentValue,
  onChange,
}: {
  label: string;
  description: string;
  linkHref: string;
  linkLabel: string;
  storageKey: string;
  currentValue: string;
  onChange: (val: string) => void;
}) {
  const [draft, setDraft] = useState(currentValue);
  const [show, setShow] = useState(false);
  const isSaved = currentValue.length > 0;
  const isDirty = draft !== currentValue;

  function handleSave() {
    onChange(draft.trim());
    toast.success(draft.trim() ? `${label} saved` : `${label} cleared`);
  }

  function handleClear() {
    setDraft("");
    onChange("");
    toast.success(`${label} cleared`);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2">
          {label}
          {isSaved && (
            <span className="flex items-center gap-1 text-[10px] font-normal text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded-full">
              <CheckCircle2 className="h-3 w-3" />
              Saved
            </span>
          )}
        </Label>
        {isSaved && (
          <button
            onClick={handleClear}
            className="text-xs text-destructive hover:underline flex items-center gap-1"
          >
            <Trash2 className="h-3 w-3" /> Remove
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={show ? "text" : "password"}
            placeholder={isSaved ? "••••••••••••••••" : "Paste your key here…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="pr-9 font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button
          onClick={handleSave}
          disabled={!isDirty}
          size="sm"
          className="shrink-0"
        >
          Save
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {description}{" "}
        <a
          href={linkHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
        >
          {linkLabel}
          <ExternalLink className="h-3 w-3" />
        </a>
      </p>
    </div>
  );
}

// ── Admin Mode Card ────────────────────────────────────────────────────────────

function AdminModeCard() {
  const { isAdminMode, setAdminMode } = useUIStore();

  // Enable flow
  const [showEnableForm, setShowEnableForm] = useState(false);
  const [enablePw, setEnablePw] = useState("");
  const [showEnablePw, setShowEnablePw] = useState(false);
  const [enableLoading, setEnableLoading] = useState(false);

  // Change password flow
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showOldPw, setShowOldPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [changeLoading, setChangeLoading] = useState(false);

  function handleDisable() {
    setAdminMode(false);
    setShowEnableForm(false);
    setShowChangeForm(false);
    setEnablePw("");
    setOldPw("");
    setNewPw("");
    setConfirmPw("");
    toast.success("Admin mode disabled.");
  }

  async function handleEnable() {
    if (!enablePw) return;
    setEnableLoading(true);
    try {
      const ok = await checkAdminPassword(enablePw);
      if (ok) {
        setAdminMode(true);
        setShowEnableForm(false);
        setEnablePw("");
        toast.success("Admin mode enabled.", {
          description: "You now have access to Form Builder and report deletion.",
        });
      } else {
        toast.error("Incorrect password.");
      }
    } finally {
      setEnableLoading(false);
    }
  }

  async function handleChangePassword() {
    if (!oldPw || !newPw || !confirmPw) {
      toast.error("All fields are required.");
      return;
    }
    if (newPw !== confirmPw) {
      toast.error("New passwords don't match.");
      return;
    }
    if (newPw.length < 4) {
      toast.error("New password must be at least 4 characters.");
      return;
    }
    setChangeLoading(true);
    try {
      const ok = await changeAdminPassword(oldPw, newPw);
      if (ok) {
        setShowChangeForm(false);
        setOldPw("");
        setNewPw("");
        setConfirmPw("");
        toast.success("Admin password changed successfully.");
      } else {
        toast.error("Current password is incorrect.");
      }
    } finally {
      setChangeLoading(false);
    }
  }

  return (
    <div
      className={`border rounded-xl p-5 space-y-4 transition-colors ${
        isAdminMode
          ? "bg-amber-500/5 border-amber-500/40"
          : "bg-card border-border"
      }`}
    >
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
            onClick={() => {
              setShowEnableForm((s) => !s);
              setShowChangeForm(false);
            }}
          >
            <Lock className="h-3.5 w-3.5" />
            Enable
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        {isAdminMode
          ? "Admin mode is active. You can access the Form Builder and delete scouting reports."
          : "Admin mode restricts access to the Form Builder and report deletion. Enter the password to unlock."}
      </p>

      {/* Enable form */}
      {!isAdminMode && showEnableForm && (
        <>
          <Separator />
          <div className="space-y-3">
            <Label className="flex items-center gap-1.5 text-sm">
              <Lock className="h-3.5 w-3.5 text-muted-foreground" />
              Enter Admin Password
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showEnablePw ? "text" : "password"}
                  placeholder="Password"
                  value={enablePw}
                  onChange={(e) => setEnablePw(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleEnable()}
                  className="pr-9"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowEnablePw((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showEnablePw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button
                size="sm"
                onClick={handleEnable}
                disabled={!enablePw || enableLoading}
                className="shrink-0"
              >
                {enableLoading ? "Checking…" : "Unlock"}
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Change password (visible when admin mode active) */}
      {isAdminMode && (
        <>
          <Separator />
          <div>
            <button
              onClick={() => setShowChangeForm((s) => !s)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <KeySquare className="h-3.5 w-3.5" />
              {showChangeForm ? "Hide" : "Change Admin Password"}
            </button>

            {showChangeForm && (
              <div className="mt-3 space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Current Password</Label>
                  <div className="relative">
                    <Input
                      type={showOldPw ? "text" : "password"}
                      placeholder="Current password"
                      value={oldPw}
                      onChange={(e) => setOldPw(e.target.value)}
                      className="pr-9 text-sm"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowOldPw((s) => !s)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                    >
                      {showOldPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">New Password</Label>
                  <div className="relative">
                    <Input
                      type={showNewPw ? "text" : "password"}
                      placeholder="New password (min 4 chars)"
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                      className="pr-9 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPw((s) => !s)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                    >
                      {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Confirm New Password</Label>
                  <Input
                    type="password"
                    placeholder="Confirm new password"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleChangePassword()}
                    className="text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleChangePassword}
                    disabled={!oldPw || !newPw || !confirmPw || changeLoading}
                  >
                    {changeLoading ? "Saving…" : "Update Password"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowChangeForm(false);
                      setOldPw("");
                      setNewPw("");
                      setConfirmPw("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const setCurrentEvent = useMutation(api.events.setCurrentEvent);

  const [eventKey, setEventKey] = useState("");
  const [eventName, setEventName] = useState("");
  const [saving, setSaving] = useState(false);

  // ── TBA key: sourced from Convex (cross-device) with localStorage as fallback ──
  const userSettings = useQuery(api.users.getUserSettings);
  const setTbaApiKeyMutation = useMutation(api.users.setTbaApiKey);
  // Local display state — seeded from localStorage immediately, then synced from Convex
  const [tbaKey, setTbaKeyState] = useState(() => getTBAKey());

  // When Convex delivers the saved key, mirror it into localStorage so all
  // fetch functions that call getTBAKey() pick it up without changes.
  useEffect(() => {
    if (userSettings === undefined) return; // still loading
    const cloudKey = userSettings?.tbaApiKey ?? "";
    // Prefer cloud key; fall back to whatever is already in localStorage
    const effective = cloudKey || getTBAKey();
    setTBAKey(effective);
    setTbaKeyState(effective);
  }, [userSettings]);

  // Keep state in sync if localStorage changes in another tab
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "falconscout_api_key_tba") {
        setTbaKeyState(getTBAKey());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

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
        <div className="flex items-center gap-2">
          <CalendarSearch className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">Current Event</h3>
        </div>

        {currentEvent && (
          <div className="flex items-center gap-3 px-3 py-2 bg-primary/10 rounded-lg text-sm">
            <span className="font-mono text-primary font-bold">{currentEvent.eventKey}</span>
            <span className="text-muted-foreground">·</span>
            <span>{currentEvent.eventName}</span>
          </div>
        )}

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
      </div>

      {/* API Keys */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">API Keys</h3>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground -mt-2">
          <RefreshCw className="h-3 w-3 shrink-0" />
          Keys are synced across all your devices automatically.
        </div>

        <Separator />

        <ApiKeyField
          label="The Blue Alliance"
          description="Required for team lists, rankings, and match schedules. Get a free Read API key at"
          linkHref="https://www.thebluealliance.com/account"
          linkLabel="thebluealliance.com/account"
          storageKey="tba"
          currentValue={tbaKey}
          onChange={async (val) => {
            setTBAKey(val);
            setTbaKeyState(val);
            // Persist to Convex so all devices pick it up
            try {
              await setTbaApiKeyMutation({ key: val });
            } catch {
              // Non-fatal: localStorage still has it for this device
            }
            // Clear TBA cache so next fetch uses the new key
            const cacheKeys = Object.keys(localStorage).filter((k) =>
              k.startsWith("falconscout_cache_tba_")
            );
            cacheKeys.forEach((k) => localStorage.removeItem(k));
          }}
        />

        <Separator />

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Clear data cache</p>
            <p className="text-xs text-muted-foreground">
              Forces all external API data to refresh on next load.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleClearCache}>
            Clear Cache
          </Button>
        </div>
      </div>
    </div>
  );
}
