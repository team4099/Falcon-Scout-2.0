import { Routes, Route, NavLink, useNavigate, useLocation } from "react-router";
import { useTheme } from "next-themes";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useCached } from "@/hooks/useCached";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import { setTBAKey } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Moon,
  Sun,
  LayoutDashboard,
  ClipboardList,
  Columns,
  Settings,
  WrenchIcon,
  LogOut,
  User,
  Users,
  Wifi,
  WifiOff,
  CloudOff,
  RefreshCw,
  CalendarDays,
  BarChart2,
  QrCode,
  ScanLine,
  MoreHorizontal,
  X,
} from "lucide-react";
import { useOfflineSync } from "@/hooks/useOfflineSync";
import { useUIStore } from "@/store/uiStore";

import DashboardPage from "@/pages/DashboardPage";
import ScoutMatchPage from "@/pages/ScoutMatchPage";
import KanbanPage from "@/pages/KanbanPage";
import MatchesPage from "@/pages/MatchesPage";
import DataViewerPage from "@/pages/DataViewerPage";
import FormBuilderPage from "@/pages/FormBuilderPage";
import SettingsPage from "@/pages/SettingsPage";
import QRCodesPage from "@/pages/QRCodesPage";
import ScannerPage from "@/pages/ScannerPage";
import LoginPage from "@/pages/LoginPage";
import ManageScoutsPage from "@/pages/ManageScoutsPage";
import SchedulingPage from "@/pages/SchedulingPage";
import MySchedulePage from "@/pages/MySchedulePage";

// Base nav items — always visible
const BASE_NAV = [
  { to: "/",          label: "Dashboard",   icon: LayoutDashboard },
  { to: "/matches",   label: "Matches",      icon: CalendarDays    },
  { to: "/data",      label: "Data Viewer",  icon: BarChart2       },
  { to: "/scout",     label: "Scout Match",  icon: ClipboardList   },
  { to: "/schedule",  label: "My Schedule",  icon: CalendarDays    },
  { to: "/qrcodes",   label: "My QR Codes",  icon: QrCode          },
  { to: "/scanner",   label: "QR Scanner",   icon: ScanLine        },
  { to: "/kanban",    label: "Picklist",     icon: Columns         },
];

function NavItem({ to, label, icon: Icon }: { to: string; label: string; icon: React.ElementType }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
          isActive
            ? "bg-primary text-primary-foreground font-medium"
            : "text-muted-foreground hover:text-foreground hover:bg-muted"
        }`
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </NavLink>
  );
}

type NavEntry = { to: string; label: string; icon: React.ElementType };

function MobileBottomNav({ primary, more }: { primary: NavEntry[]; more: NavEntry[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  // Close the "More" sheet whenever the route changes
  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  return (
    <>
      {/* Backdrop */}
      {moreOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
          onClick={() => setMoreOpen(false)}
        />
      )}

      {/* More sheet — anchored at bottom-0, slides up over the tab bar */}
      <div
        className={`md:hidden fixed inset-x-0 bottom-0 z-50 bg-card border-t border-border rounded-t-2xl shadow-2xl transition-transform duration-300 ease-out ${
          moreOpen ? "-translate-y-16" : "translate-y-full pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border">
          <span className="text-sm font-semibold text-foreground">More</span>
          <button
            onClick={() => setMoreOpen(false)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-4 gap-1 p-3">
          {more.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setMoreOpen(false)}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 py-2.5 px-1 rounded-xl text-[10px] font-medium transition-colors ${
                  isActive
                    ? "text-primary bg-primary/10"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <div className={`p-2 rounded-xl transition-colors ${isActive ? "bg-primary/10" : "bg-muted/60"}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <span className="truncate w-full text-center">{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </div>

      {/* Tab bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-card border-t border-border flex items-stretch h-16 safe-area-inset-bottom">
        {primary.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
                isActive
                  ? "text-primary"
                  : "text-muted-foreground"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <div className={`p-1.5 rounded-xl transition-colors ${isActive ? "bg-primary/10" : ""}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}

        {/* More button */}
        <button
          onClick={() => setMoreOpen((o) => !o)}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
            moreOpen ? "text-primary" : "text-muted-foreground"
          }`}
        >
          <div className={`p-1.5 rounded-xl transition-colors ${moreOpen ? "bg-primary/10" : ""}`}>
            <MoreHorizontal className="h-5 w-5" />
          </div>
          <span>More</span>
        </button>
      </nav>
    </>
  );
}

function AuthenticatedApp() {
  const { theme, setTheme } = useTheme();
  const { signOut } = useAuthActions();
  const navigate = useNavigate();
  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const { totalPending, lastSyncedAt, isOnline, markSynced } = useOfflineSync();
  const { isAdminMode } = useUIStore();

  // Build nav dynamically — admin-only items shown/hidden based on isAdminMode
  const NAV = [
    ...BASE_NAV,
    ...(isAdminMode
      ? [
          { to: "/builder",     label: "Form Builder",  icon: WrenchIcon  },
          { to: "/scouts",      label: "Manage Scouts", icon: Users       },
          { to: "/scheduling",  label: "Scheduling",    icon: CalendarDays },
        ]
      : []),
    { to: "/settings", label: "Settings", icon: Settings },
  ];

  // Bottom nav (most-used on mobile) — max 4 primary + More overflow
  const BOTTOM_NAV_PRIMARY = [
    { to: "/",        label: "Dashboard", icon: LayoutDashboard },
    { to: "/scout",   label: "Scout",     icon: ClipboardList   },
    { to: "/schedule",label: "Schedule",  icon: CalendarDays    },
    { to: "/kanban",  label: "Picklist",  icon: Columns         },
  ];

  const BOTTOM_NAV_MORE = [
    { to: "/matches",  label: "Matches",   icon: CalendarDays },
    { to: "/data",     label: "Data",      icon: BarChart2    },
    { to: "/qrcodes",  label: "QR Codes",  icon: QrCode       },
    { to: "/scanner",  label: "Scanner",   icon: ScanLine     },
    ...(isAdminMode
      ? [
          { to: "/scouts",      label: "Scouts",       icon: Users       },
          { to: "/scheduling",  label: "Scheduling",   icon: CalendarDays },
          { to: "/builder",     label: "Form Builder", icon: WrenchIcon  },
        ]
      : []),
    { to: "/settings", label: "Settings",  icon: Settings    },
  ];

  // Stamp the sync time immediately when we know we're online
  useEffect(() => {
    if (isOnline) markSynced();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // ── Sync TBA key from Convex → localStorage on every app load ──
  const userSettings = useQuery(api.users.getUserSettings);
  useEffect(() => {
    if (userSettings === undefined) return; // still loading
    const cloudKey = userSettings?.tbaApiKey ?? "";
    if (cloudKey) setTBAKey(cloudKey);
  }, [userSettings]);

  /** "just now" / "2 min ago" / "1 hr ago" */
  function formatAge(ts: number | null): string {
    if (ts === null) return "never";
    const secs = Math.floor((Date.now() - ts) / 1_000);
    if (secs < 30)  return "now";
    const mins = Math.floor(secs / 60);
    if (mins < 1)   return "just now";
    if (mins < 60)  return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs} hr ago`;
  }

  async function handleSignOut() {
    await signOut();
    navigate("/login");
  }


  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* ── Desktop Sidebar ─────────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-border bg-card">
        {/* Logo */}
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-black text-xs">FS</span>
            </div>
            <div>
              <p className="font-bold text-sm leading-none">FalconScout</p>
              <p className="text-[10px] text-muted-foreground">2.0</p>
            </div>
          </div>
          {currentEvent && (
            <p className="text-[11px] font-mono text-primary mt-2 truncate">{currentEvent.eventKey}</p>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {NAV.map((n) => (
            <NavItem key={n.to} {...n} />
          ))}
        </nav>

        <Separator />

        {/* Footer */}
        <div className="p-2 space-y-1">
        {/* Sync status */}
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
            {isOnline ? (
              <Wifi className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-yellow-500" />
            )}
            <div className="flex flex-col min-w-0">
              {totalPending > 0 ? (
                <span className="text-yellow-500 font-medium">{totalPending} pending sync</span>
              ) : (
                <span>{isOnline ? "Online" : "Offline"}</span>
              )}
              <span className="text-[10px] opacity-60 truncate">Synced {formatAge(lastSyncedAt)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 px-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-8 w-8">
                <User className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start">
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive gap-2"
                  onClick={handleSignOut}
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto min-w-0">
        {/* Mobile top bar */}
        <div className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 py-2.5 bg-card border-b border-border">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-black text-[10px]">FS</span>
            </div>
            <span className="font-bold text-sm">FalconScout</span>
            {currentEvent && (
              <span className="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                {currentEvent.eventKey}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {/* Offline / sync status */}
            <div className="flex items-center gap-1">
              {!isOnline
                ? <WifiOff className="h-3.5 w-3.5 text-amber-500" />
                : <Wifi className="h-3.5 w-3.5 text-green-500" />
              }
              {totalPending > 0 && (
                <span className="text-[9px] font-bold bg-amber-500 text-white rounded-full px-1">{totalPending}</span>
              )}
            </div>
            <span className="text-[9px] text-muted-foreground hidden xs:inline">{formatAge(lastSyncedAt)}</span>
            <Button variant="ghost" size="icon" className="h-8 w-8"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSignOut}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Offline banner — shown below top bar when disconnected */}
        {!isOnline && (
          <div className="sticky top-[49px] md:top-0 z-20 flex items-center gap-2 px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs font-medium">
            <CloudOff className="h-3.5 w-3.5 shrink-0" />
            <span>You&apos;re offline — changes are saved locally and will sync when you reconnect.</span>
            {lastSyncedAt && (
              <span className="ml-auto shrink-0 opacity-70">Last synced {formatAge(lastSyncedAt)}</span>
            )}
          </div>
        )}

        {/* Pending sync banner when there are queued ops (online but not yet flushed) */}
        {isOnline && totalPending > 0 && (
          <div className="sticky top-[49px] md:top-0 z-20 flex items-center gap-2 px-4 py-1.5 bg-primary/5 border-b border-primary/20 text-primary text-xs font-medium">
            <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span>Syncing {totalPending} pending change{totalPending !== 1 ? "s" : ""}…</span>
          </div>
        )}

        {/* Page content */}
        <div className="p-4 md:p-6 pb-24 md:pb-6 min-h-full">
          <Routes>
            <Route path="/"           element={<DashboardPage />} />
            <Route path="/matches"    element={<MatchesPage />} />
            <Route path="/data"       element={<DataViewerPage />} />
            <Route path="/scout"      element={<ScoutMatchPage />} />
            <Route path="/schedule"   element={<MySchedulePage />} />
            <Route path="/qrcodes"    element={<QRCodesPage />} />
            <Route path="/scanner"    element={<ScannerPage />} />
            <Route path="/kanban"     element={<KanbanPage />} />
            <Route path="/builder"    element={<FormBuilderPage />} />
            <Route path="/scouts"     element={<ManageScoutsPage />} />
            <Route path="/scheduling" element={<SchedulingPage />} />
            <Route path="/settings"   element={<SettingsPage />} />
            <Route path="/login"      element={<LoginPage />} />
          </Routes>
        </div>
      </main>

      {/* ── Mobile Bottom Tab Bar ────────────────────────────────────────── */}
      <MobileBottomNav
        primary={BOTTOM_NAV_PRIMARY}
        more={BOTTOM_NAV_MORE}
      />
    </div>
  );
}


// ─── Offline auth helpers ─────────────────────────────────────────────────────
// When offline, Convex's WebSocket never connects so useConvexAuth stays in
// isLoading=true and useQuery never resolves. We bypass both by:
//   1. Reading the JWT directly from localStorage to determine auth status.
//   2. Caching the viewer record in localStorage and serving it as a fallback.

const CONVEX_URL       = (import.meta.env.VITE_CONVEX_URL ?? "") as string;
const _escapedNs       = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");
const _JWT_KEY         = `__convexAuthJWT_${_escapedNs}`;
const VIEWER_CACHE_KEY = "falconscout_viewer_cache";

function hasStoredJwt(): boolean {
  try { return !!localStorage.getItem(_JWT_KEY); } catch { return false; }
}

function getCachedViewer(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(VIEWER_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setCachedViewer(v: Record<string, unknown>): void {
  try { localStorage.setItem(VIEWER_CACHE_KEY, JSON.stringify(v)); } catch {}
}

export default function App() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const viewer = useQuery(api.users.viewer);

  // Persist the viewer to localStorage whenever it arrives from Convex
  useEffect(() => {
    if (viewer) setCachedViewer(viewer as Record<string, unknown>);
  }, [viewer]);

  // ── Offline short-circuit ───────────────────────────────────────────────
  // If the browser is offline and we still have a JWT + cached viewer, skip
  // all the Convex loading states and go straight to the authenticated shell.
  const offline = !navigator.onLine;
  const cachedViewer = getCachedViewer();

  if ((isLoading || viewer === undefined) && offline && hasStoredJwt() && cachedViewer) {
    return <AuthenticatedApp />;
  }

  // ── Normal (online) flow ───────────────────────────────────────────────
  // Still checking auth state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        <p className="text-sm text-muted-foreground font-medium animate-pulse">Verifying session...</p>
      </div>
    );
  }

  // Not authenticated
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background">
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </div>
    );
  }

  // Authenticated but viewer still loading
  if (viewer === undefined) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        <p className="text-sm text-muted-foreground font-medium animate-pulse">Loading user...</p>
      </div>
    );
  }

  // Authenticated but no user record (shouldn't happen normally)
  if (viewer === null) {
    return (
      <div className="min-h-screen bg-background">
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </div>
    );
  }

  return <AuthenticatedApp />;
}
