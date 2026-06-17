import { useState, useEffect, useMemo, useCallback, Fragment } from "react";
import { useQuery, useMutation } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useUIStore } from "@/store/uiStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchTBAEventMatches, fetchTBAEventTeams } from "@/lib/api";
import type { TBAMatch, TBATeam } from "@/lib/api";
import {
  Users, ShieldAlert, Lock, CalendarDays, Wrench, Loader2,
  AlertCircle, Plus, Trash2, Pencil, Check,
  Zap, LayoutGrid, Sparkles, TriangleAlert, ChevronDown as ChevDown,
  ClipboardList,
} from "lucide-react";
import {
  generateSchedule,
  type SchedulerOutput,
  type Position as GenPosition,
} from "@/lib/scheduleGenerator";

// ── Types ─────────────────────────────────────────────────────────────────────

interface User {
  _id: string;
  name?: string;
  email?: string;
  image?: string;
}

interface MatchAssignment {
  _id: string;
  matchNumber: number;
  matchLabel: string;
  position: Position;
  scoutId: string;
}

interface PitRotation {
  _id: string;
  eventKey: string;
  label?: string;
  startMatch?: number;
  endMatch?: number;
  isElims?: boolean;
  scoutIds: string[];
}

interface PitScoutingTeam {
  _id: string;
  eventKey: string;
  teamNumber: number;
  scoutIds: string[];
}

type Position = "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";
type TabType = "matches" | "pit" | "pitScouting";

// ── Constants ─────────────────────────────────────────────────────────────────

const POSITIONS: Position[] = ["red1", "red2", "red3", "blue1", "blue2", "blue3"];

const POS_META: Record<Position, { short: string; label: string; side: "red" | "blue" }> = {
  red1:  { short: "R1", label: "Red 1",  side: "red"  },
  red2:  { short: "R2", label: "Red 2",  side: "red"  },
  red3:  { short: "R3", label: "Red 3",  side: "red"  },
  blue1: { short: "B1", label: "Blue 1", side: "blue" },
  blue2: { short: "B2", label: "Blue 2", side: "blue" },
  blue3: { short: "B3", label: "Blue 3", side: "blue" },
};

// ── Theme tokens — gold / black only ─────────────────────────────────────────

const G     = "oklch(0.85 0.18 95)";        // primary gold
const G_DIM = "oklch(0.85 0.18 95 / 10%)";  // gold tint bg
const G_MED = "oklch(0.85 0.18 95 / 25%)";  // gold border / mid
const G_STR = "oklch(0.85 0.18 95 / 45%)";  // gold strong border
const G_TXT = "oklch(0.1 0 0)";             // text on gold
const SURFACE   = "oklch(1 0 0 / 3%)";       // card surface
const SURF_BORD = "oklch(1 0 0 / 8%)";       // card border
const SURF_HVR  = "oklch(1 0 0 / 6%)";       // hover surface
const MUTED     = "var(--muted-foreground)";
const FG        = "var(--foreground)";

// ── Helpers ───────────────────────────────────────────────────────────────────

function displayName(u: User) { return u.name ?? u.email ?? "?"; }
function firstName(u: User) {
  const n = displayName(u);
  return n.split(" ")[0] ?? n.slice(0, 8);
}
function avatarLetter(u: User) { return displayName(u).charAt(0).toUpperCase(); }

function tbaMatchLabel(m: TBAMatch): string {
  const lvl: Record<string, string> = { qm: "Q", ef: "EF", qf: "QF", sf: "SF", f: "F" };
  const prefix = lvl[m.comp_level] ?? m.comp_level.toUpperCase();
  if (m.comp_level === "qm") return `${prefix}${m.match_number}`;
  return `${prefix}${m.set_number}M${m.match_number}`;
}

function matchSortKey(m: TBAMatch) {
  const lvl: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
  return (lvl[m.comp_level] ?? 99) * 1_000_000 + m.set_number * 10_000 + m.match_number;
}

// ── Avatar ────────────────────────────────────────────────────────────────────

function Avatar({ user, size = 36 }: { user: User; size?: number }) {
  if (user.image) {
    return (
      <img src={user.image} alt={displayName(user)}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: `linear-gradient(135deg, ${G} 0%, oklch(0.75 0.20 80) 100%)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.38, fontWeight: 800, color: G_TXT,
      boxShadow: `0 2px 8px ${G} / 30%`,
    }}>
      {avatarLetter(user)}
    </div>
  );
}

// ── Admin lock screen ─────────────────────────────────────────────────────────

function AdminLockScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6">
      <div className="flex flex-col items-center gap-4 p-10 rounded-2xl border border-border bg-card max-w-sm w-full text-center shadow-sm">
        <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
          <ShieldAlert className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-bold tracking-tight text-foreground">Admin Access Required</h2>
          <p className="text-sm text-muted-foreground">Enable admin mode in Settings to manage schedules.</p>
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-muted/50 border border-border/50 text-sm text-muted-foreground w-full justify-center">
          <Lock className="h-4 w-4 shrink-0" />
          <span>Go to <strong className="text-foreground">Settings → Admin Mode</strong></span>
        </div>
      </div>
    </div>
  );
}

// ── Scout selector panel ──────────────────────────────────────────────────────

interface ScoutSelectorProps {
  users: User[];
  pinnedId: string | null;
  onPin: (id: string | null) => void;
  matchCounts: Record<string, number>;
  matches: TBAMatch[];
  onBatchAssign: (start: number, end: number, positions: Set<Position>) => Promise<void>;
  isMobile?: boolean;
  isLandscapePhone?: boolean;
}

function ScoutSelector({ users, pinnedId, onPin, matchCounts, matches, onBatchAssign, isMobile, isLandscapePhone }: ScoutSelectorProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // In landscape phone mode the panel is always open (side-by-side, never collapsed)
  const bodyVisible = isLandscapePhone ? true : (!isMobile || mobileOpen);
  const [batchStart, setBatchStart] = useState("");
  const [batchEnd, setBatchEnd]     = useState("");
  const [batchPos, setBatchPos]     = useState<Set<Position>>(new Set());
  const [batchBusy, setBatchBusy]   = useState(false);

  const pinned = users.find(u => u._id === pinnedId) ?? null;

  function togglePos(p: Position) {
    setBatchPos(prev => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n; });
  }

  async function handleBatch() {
    const s = parseInt(batchStart), e = parseInt(batchEnd);
    if (!pinnedId || isNaN(s) || isNaN(e) || s > e || batchPos.size === 0) return;
    setBatchBusy(true);
    try { await onBatchAssign(s, e, batchPos); setBatchStart(""); setBatchEnd(""); setBatchPos(new Set()); }
    finally { setBatchBusy(false); }
  }

  const previewCount = batchStart && batchEnd
    ? matches.filter(m => m.comp_level === "qm" && m.match_number >= parseInt(batchStart) && m.match_number <= parseInt(batchEnd)).length
    : 0;
  const totalSlots = previewCount * batchPos.size;
  const canApply = !!batchStart && !!batchEnd && parseInt(batchStart) <= parseInt(batchEnd) && batchPos.size > 0;


  return (
    <div style={{
      width: isLandscapePhone ? 130 : isMobile ? "100%" : 248,
      flexShrink: 0, display: "flex", flexDirection: "column",
      minHeight: 0, borderRadius: 14, border: `1px solid ${SURF_BORD}`,
      background: SURFACE, overflow: "hidden",
      maxHeight: isMobile && !isLandscapePhone && !mobileOpen ? 52 : undefined,
      transition: "max-height 0.25s ease",
    }}>
      {/* Header — tappable toggle on portrait-mobile only */}
      <div
        style={{
          padding: isLandscapePhone ? "8px 10px" : "11px 14px",
          borderBottom: bodyVisible ? `1px solid ${SURF_BORD}` : "none",
          background: G_DIM, flexShrink: 0,
          cursor: isMobile && !isLandscapePhone ? "pointer" : "default",
        }}
        onClick={isMobile && !isLandscapePhone ? () => setMobileOpen(o => !o) : undefined}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Users size={13} style={{ color: G }} />
          {!isLandscapePhone && (
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: G }}>
              {isMobile && pinnedId
                ? `Scout: ${pinned?.name?.split(" ")[0] ?? "?"}`
                : "Pin a Scout"}
            </span>
          )}
          <span style={{ marginLeft: isLandscapePhone ? 0 : "auto", background: G_MED, color: G, borderRadius: 20, padding: "1px 8px", fontSize: 11, fontWeight: 700 }}>
            {isLandscapePhone
              ? users.length
              : isMobile ? (mobileOpen ? "Close ▲" : `${users.length} scouts ▼`) : users.length}
          </span>
        </div>
        {!isMobile && !isLandscapePhone && (
          <p style={{ fontSize: 11, color: MUTED, margin: "4px 0 0", lineHeight: 1.3 }}>
            Select a scout, then click grid cells to assign.
          </p>
        )}
      </div>

      {/* Scout list */}
      {bodyVisible && (
        isLandscapePhone ? (
          /* Landscape phone: compact scrollable vertical list, avatar + first name only */
          <ScrollArea style={{ flex: 1 }}>
            <div style={{ padding: "4px 6px 6px", display: "flex", flexDirection: "column", gap: 2 }}>
              {users.map(u => {
                const active = pinnedId === u._id;
                const cnt = matchCounts[u._id] ?? 0;
                return (
                  <button key={u._id} onClick={() => onPin(active ? null : u._id)}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 6,
                      padding: "5px 6px", borderRadius: 8, cursor: "pointer",
                      background: active ? G_DIM : "transparent",
                      border: `1.5px solid ${active ? G_STR : "transparent"}`,
                      outline: "none", transition: "all 0.1s",
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = SURF_HVR; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
                  >
                    <Avatar user={u} size={22} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: active ? G : FG, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                      {firstName(u)}
                    </span>
                    {cnt > 0 && (
                      <span style={{ background: active ? G : G_MED, color: active ? G_TXT : G, borderRadius: 20, padding: "0 5px", fontSize: 9, fontWeight: 800, flexShrink: 0 }}>
                        {cnt}
                      </span>
                    )}
                    {active && <Check size={10} style={{ color: G, flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        ) : isMobile ? (
          /* Portrait phone: horizontal scrolling carousel */
          <div style={{ overflowX: "auto", overflowY: "hidden", display: "flex", gap: 6, padding: "8px 10px", flexShrink: 0 }}>
            {users.length === 0 && (
              <div style={{ padding: "12px", color: MUTED, fontSize: 13, whiteSpace: "nowrap" }}>No scouts yet</div>
            )}
            {users.map(u => {
              const active = pinnedId === u._id;
              const cnt = matchCounts[u._id] ?? 0;
              return (
                <button key={u._id} onClick={() => { onPin(active ? null : u._id); setMobileOpen(false); }}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    padding: "8px 10px", borderRadius: 12, cursor: "pointer", flexShrink: 0,
                    background: active ? G_DIM : SURF_HVR,
                    border: `1.5px solid ${active ? G_STR : SURF_BORD}`,
                    outline: "none", transition: "all 0.12s", minWidth: 58,
                  }}
                >
                  <Avatar user={u} size={32} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: active ? G : FG, whiteSpace: "nowrap", maxWidth: 58, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {firstName(u)}
                  </span>
                  {cnt > 0 && (
                    <span style={{ background: active ? G : SURF_BORD, color: active ? G_TXT : MUTED, borderRadius: 20, padding: "0px 5px", fontSize: 10, fontWeight: 800 }}>
                      {cnt}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          /* Desktop: full vertical list */
          <ScrollArea style={{ flex: 1 }}>
            <div style={{ padding: "8px 8px 4px" }}>
              {users.length === 0 && (
                <div style={{ padding: "32px 12px", textAlign: "center", color: MUTED, fontSize: 13 }}>
                  No scouts yet
                </div>
              )}
              {users.map(u => {
                const active = pinnedId === u._id;
                const cnt = matchCounts[u._id] ?? 0;
                return (
                  <button key={u._id} onClick={() => onPin(active ? null : u._id)}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 9,
                      padding: "8px 9px", borderRadius: 10, cursor: "pointer", textAlign: "left",
                      background: active ? G_DIM : "transparent",
                      border: `1.5px solid ${active ? G_STR : "transparent"}`,
                      outline: "none", transition: "all 0.12s",
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = SURF_HVR; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
                  >
                    <Avatar user={u} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: FG, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {displayName(u)}
                      </div>
                    </div>
                    {cnt > 0 && (
                      <span style={{ background: G, color: G_TXT, borderRadius: 20, padding: "1px 7px", fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                        {cnt}
                      </span>
                    )}
                    {active && <Check size={13} style={{ color: G, flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        )
      )}

      {/* Batch assign — desktop only */}
      {pinned && bodyVisible && !isMobile && !isLandscapePhone && (
        <div style={{ borderTop: `1px solid ${G_MED}`, padding: "12px 12px 14px", background: G_DIM, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}>
            <Zap size={13} style={{ color: G }} />
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: G }}>
              Batch Assign — {firstName(pinned)}
            </span>
          </div>

          {/* Range inputs */}
          <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, marginBottom: 5 }}>Match range</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
            {[
              { val: batchStart, set: setBatchStart, ph: "From" },
              { val: batchEnd,   set: setBatchEnd,   ph: "To"   },
            ].map(({ val, set, ph }, i) => (
              <>
                {i === 1 && <span style={{ fontSize: 11, color: MUTED, flexShrink: 0 }}>–</span>}
                <input key={ph} type="number" min={1} placeholder={ph}
                  value={val} onChange={e => set(e.target.value)}
                  style={{
                    flex: 1, padding: "5px 8px", borderRadius: 7, fontSize: 13, fontWeight: 600,
                    background: "var(--background)", border: `1.5px solid ${SURF_BORD}`,
                    color: FG, outline: "none", width: 0,
                  }}
                />
              </>
            ))}
          </div>

          {/* Position toggles */}
          <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, marginBottom: 6 }}>Positions</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginBottom: 8 }}>
            {POSITIONS.map(p => {
              const on = batchPos.has(p);
              return (
                <button key={p} onClick={() => togglePos(p)}
                  style={{
                    padding: "5px 0", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer",
                    background: on ? G : SURF_HVR,
                    color: on ? G_TXT : MUTED,
                    border: `1.5px solid ${on ? G_STR : SURF_BORD}`,
                    transition: "all 0.1s",
                  }}
                >
                  {POS_META[p].short}
                </button>
              );
            })}
          </div>

          {/* Quick-select presets */}
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            {[
              { label: "Red",  pos: ["red1","red2","red3"] as Position[] },
              { label: "Blue", pos: ["blue1","blue2","blue3"] as Position[] },
              { label: "All 6", pos: POSITIONS },
            ].map(({ label, pos }) => (
              <button key={label} onClick={() => setBatchPos(new Set(pos))}
                style={{
                  flex: 1, padding: "3px 0", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer",
                  background: G_MED, color: G, border: `1px solid ${G_STR}`,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Preview */}
          {canApply && (
            <p style={{ fontSize: 10, color: MUTED, marginBottom: 8, textAlign: "center", lineHeight: 1.3 }}>
              {previewCount} match{previewCount !== 1 ? "es" : ""} × {batchPos.size} pos = {totalSlots} slots
            </p>
          )}

          <button onClick={handleBatch} disabled={batchBusy || !canApply}
            style={{
              width: "100%", padding: "8px 0", borderRadius: 9, fontSize: 13, fontWeight: 700,
              background: canApply && !batchBusy ? G : SURF_HVR,
              color: canApply && !batchBusy ? G_TXT : MUTED,
              border: "none", cursor: batchBusy ? "wait" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              transition: "all 0.15s",
            }}
          >
            {batchBusy
              ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />Applying…</>
              : <><Zap size={13} />Apply to Range</>
            }
          </button>
        </div>
      )}
    </div>
  );
}

// ── Match grid ────────────────────────────────────────────────────────────────

interface MatchGridProps {
  matches: TBAMatch[];
  assignMap: Record<number, Partial<Record<Position, { scoutId: string; name: string; fullName: string }>>>;
  pinnedId: string | null;
  onCellClick: (matchNum: number, matchLbl: string, pos: Position) => void;
  saving: Set<string>;
  isMobile?: boolean;
  isLandscapePhone?: boolean;
}

function MatchGrid({ matches, assignMap, pinnedId, onCellClick, saving, isMobile, isLandscapePhone }: MatchGridProps) {
  const [expandedMatchKey, setExpandedMatchKey] = useState<string | null>(null);
  const canExpand = isMobile && !isLandscapePhone;
  if (matches.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: MUTED }}>
        <CalendarDays size={30} style={{ opacity: 0.3 }} />
        <span style={{ fontSize: 14 }}>No matches found for this event yet.</span>
      </div>
    );
  }

  // Column widths — label + 3 red + divider + 3 blue
  // landscape phone gets a slightly wider label so match numbers don't wrap
  const COL = isLandscapePhone
    ? "44px 1fr 1fr 1fr 2px 1fr 1fr 1fr"
    : isMobile
    ? "36px 1fr 1fr 1fr 2px 1fr 1fr 1fr"
    : "50px 1fr 1fr 1fr 3px 1fr 1fr 1fr";

  const cellPad = isLandscapePhone ? "3px 2px" : "4px 3px";
  const cellMinH = isLandscapePhone ? 24 : 28;
  const cellFontSize = isLandscapePhone ? 10 : 11;
  const rowPad = isLandscapePhone ? "2px 6px 8px" : "4px 10px 12px";
  const headerPad = isLandscapePhone ? "0 6px" : "0 10px";

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRadius: 14, border: `1px solid ${SURF_BORD}`, background: SURFACE, overflow: isMobile ? "auto" : "hidden" }}>
      {/* Sticky header */}
      <div style={{
        display: "grid", gridTemplateColumns: COL,
        alignItems: "stretch", padding: headerPad, flexShrink: 0,
        borderBottom: `1px solid ${SURF_BORD}`, background: "var(--card)",
      }}>
        <div style={{ padding: isMobile ? "7px 2px" : "9px 4px", fontSize: 10, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          {isMobile || isLandscapePhone ? "#" : "Match"}
        </div>
        {POSITIONS.map((p, i) => (
          <Fragment key={p}>
            {i === 3 && (
              <div style={{ background: SURF_BORD, width: "100%", alignSelf: "stretch" }} />
            )}
            <div style={{
              padding: "9px 4px", textAlign: "center",
              fontSize: 10, fontWeight: 800, letterSpacing: "0.07em", color: G,
              borderBottom: `2px solid ${G}`,
            }}>
              {POS_META[p].short}
            </div>
          </Fragment>
        ))}
      </div>

      {/* Rows */}
      <ScrollArea style={{ flex: 1 }}>
        <div style={{ padding: rowPad, display: "flex", flexDirection: "column", gap: isLandscapePhone ? 1 : 2 }}>
          {matches.map(m => {
            const lbl = tbaMatchLabel(m);
            const row = assignMap[m.match_number] ?? {};
            const isQual = m.comp_level === "qm";
            const isExpanded = canExpand && expandedMatchKey === m.key;
            const redPositions: Position[]  = ["red1",  "red2",  "red3"];
            const bluePositions: Position[] = ["blue1", "blue2", "blue3"];

            return (
              <Fragment key={m.key}>
                {/* Grid row */}
                <div style={{
                  display: "grid", gridTemplateColumns: COL,
                  gap: 0, alignItems: "center",
                  borderRadius: 8,
                  background: !isQual ? G_DIM : "transparent",
                  borderLeft: !isQual ? `2px solid ${G_MED}` : "2px solid transparent",
                }}>
                  {/* Match label — tap to expand on portrait mobile */}
                  {canExpand ? (
                    <button
                      onClick={() => setExpandedMatchKey(k => k === m.key ? null : m.key)}
                      style={{
                        padding: "3px 4px", fontSize: 12, fontWeight: 700,
                        fontFamily: "monospace", letterSpacing: "-0.01em",
                        color: isQual ? FG : G,
                        background: isExpanded ? G_MED : "transparent",
                        border: "none", borderRadius: 5, cursor: "pointer",
                        textAlign: "left", transition: "background 0.1s",
                      }}
                    >
                      {lbl}
                    </button>
                  ) : (
                    <div style={{
                      padding: isLandscapePhone ? "2px 3px" : "3px 4px",
                      fontSize: isLandscapePhone ? 10 : 12, fontWeight: 700,
                      fontFamily: "monospace", letterSpacing: "-0.01em",
                      color: isQual ? FG : G,
                    }}>
                      {lbl}
                    </div>
                  )}

                  {/* Position cells */}
                  {POSITIONS.map((p, i) => {
                    const savingKey = `${m.match_number}-${p}`;
                    const isSaving = saving.has(savingKey);
                    const assigned = row[p];
                    const isPinned = assigned?.scoutId === pinnedId;

                    let cellBg     = "transparent";
                    let cellBorder = `1.5px solid transparent`;
                    let textColor  = MUTED;

                    if (assigned) {
                      if (isPinned) {
                        cellBg = G_DIM;
                        cellBorder = `1.5px solid ${G_STR}`;
                        textColor = G;
                      } else {
                        cellBg = SURF_HVR;
                        cellBorder = `1.5px solid ${SURF_BORD}`;
                        textColor = FG;
                      }
                    } else if (pinnedId) {
                      cellBorder = `1.5px dashed ${SURF_BORD}`;
                    }

                    return (
                      <>
                        {i === 3 && (
                          <div key={`div-${m.key}`} style={{ width: "3px", alignSelf: "stretch", background: "oklch(1 0 0/5%)", margin: "2px 0" }} />
                        )}
                        <button key={p}
                          onClick={() => onCellClick(m.match_number, lbl, p)}
                          disabled={isSaving}
                          title={
                            assigned
                              ? `${assigned.name} (${POS_META[p].short}) — click to ${isPinned ? "unassign" : "replace"}`
                              : pinnedId ? `Assign to ${POS_META[p].label}` : "Pin a scout first"
                          }
                          style={{
                            margin: isLandscapePhone ? "1px" : "2px",
                            padding: cellPad, borderRadius: 6,
                            cursor: pinnedId ? "pointer" : "default",
                            background: cellBg, border: cellBorder,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: cellFontSize, fontWeight: 700, color: textColor,
                            transition: "all 0.1s", minHeight: cellMinH, minWidth: 0, overflow: "hidden",
                            opacity: isSaving ? 0.5 : 1,
                          }}
                          onMouseEnter={e => {
                            if (pinnedId && !isSaving) {
                              e.currentTarget.style.background = G_DIM;
                              e.currentTarget.style.border = `1.5px solid ${G_MED}`;
                            }
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.background = cellBg;
                            e.currentTarget.style.border = cellBorder;
                          }}
                        >
                          {isSaving
                            ? <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} />
                            : !assigned
                              ? (pinnedId ? <span style={{ opacity: 0.25, fontSize: 14, fontWeight: 300 }}>+</span> : null)
                              : <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%", padding: "0 2px" }}>
                                  {assigned.name}
                                </span>
                          }
                        </button>
                      </>
                    );
                  })}
                </div>

                {/* Expanded detail — renders immediately below this row */}
                {isExpanded && (
                  <div style={{
                    borderRadius: 12,
                    border: `1.5px solid ${G_MED}`,
                    background: "var(--card)",
                    overflow: "hidden",
                    boxShadow: `0 4px 20px oklch(0 0 0 / 30%)`,
                    margin: "2px 0 4px",
                  }}>
                    {/* Header */}
                    <div style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "9px 14px", background: G_DIM,
                      borderBottom: `1px solid ${G_MED}`,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace", color: isQual ? FG : G }}>{lbl}</span>
                        {!isQual && <span style={{ fontSize: 10, fontWeight: 700, background: G_MED, color: G, borderRadius: 20, padding: "2px 8px" }}>Playoff</span>}
                      </div>
                      <button
                        onClick={() => setExpandedMatchKey(null)}
                        style={{ background: SURF_HVR, border: `1px solid ${SURF_BORD}`, borderRadius: 6, padding: "3px 10px", fontSize: 12, fontWeight: 700, color: MUTED, cursor: "pointer" }}
                      >
                        ✕
                      </button>
                    </div>

                    {/* Alliance columns */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
                      {/* Red */}
                      <div style={{ padding: "10px 12px", borderRight: `1px solid ${SURF_BORD}` }}>
                        <div style={{ fontSize: 10, fontWeight: 800, color: "oklch(0.65 0.22 25)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Red Alliance</div>
                        {redPositions.map(p => {
                          const a = row[p];
                          const isPinned = a?.scoutId === pinnedId;
                          return (
                            <div key={p} style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 7 }}>
                              <span style={{ fontSize: 10, fontWeight: 800, color: "oklch(0.65 0.22 25)", background: "oklch(0.65 0.22 25 / 12%)", borderRadius: 5, padding: "2px 6px", flexShrink: 0, marginTop: 1 }}>
                                {POS_META[p].short}
                              </span>
                              <span style={{ fontSize: 13, fontWeight: isPinned ? 800 : 500, color: isPinned ? G : a ? FG : MUTED, lineHeight: 1.3 }}>
                                {a ? a.fullName : <span style={{ opacity: 0.35, fontSize: 11 }}>Unassigned</span>}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Blue */}
                      <div style={{ padding: "10px 12px" }}>
                        <div style={{ fontSize: 10, fontWeight: 800, color: "oklch(0.6 0.22 260)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Blue Alliance</div>
                        {bluePositions.map(p => {
                          const a = row[p];
                          const isPinned = a?.scoutId === pinnedId;
                          return (
                            <div key={p} style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 7 }}>
                              <span style={{ fontSize: 10, fontWeight: 800, color: "oklch(0.6 0.22 260)", background: "oklch(0.6 0.22 260 / 12%)", borderRadius: 5, padding: "2px 6px", flexShrink: 0, marginTop: 1 }}>
                                {POS_META[p].short}
                              </span>
                              <span style={{ fontSize: 13, fontWeight: isPinned ? 800 : 500, color: isPinned ? G : a ? FG : MUTED, lineHeight: 1.3 }}>
                                {a ? a.fullName : <span style={{ opacity: 0.35, fontSize: 11 }}>Unassigned</span>}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {pinnedId && (
                      <div style={{ padding: "7px 14px", borderTop: `1px solid ${SURF_BORD}`, background: G_DIM, fontSize: 11, color: MUTED, textAlign: "center" }}>
                        Tap a cell above to assign / unassign
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </ScrollArea>

      {/* Footer legend — hidden in landscape phone to save vertical space */}
      {!isLandscapePhone && (
        <div style={{ padding: "7px 14px", borderTop: `1px solid ${SURF_BORD}`, display: "flex", gap: 16, flexShrink: 0, background: "var(--card)", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 10, height: 10, borderRadius: 3, background: G, opacity: 0.9 }} />
          <span style={{ fontSize: 10, color: MUTED }}>Pinned scout</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 10, height: 10, borderRadius: 3, background: SURF_HVR, border: `1px solid ${SURF_BORD}` }} />
          <span style={{ fontSize: 10, color: MUTED }}>Other scout</span>
        </div>
        <span style={{ marginLeft: "auto", fontSize: 10, color: MUTED }}>
          {pinnedId ? "Click a cell to assign · click same scout again to unassign" : "← Pin a scout to start assigning"}
        </span>
      </div>
      )}
    </div>
  );
}

// ── Qual pit rotation card ────────────────────────────────────────────────────

function RotationCard({ rotation, users, onEdit, onDelete }: {
  rotation: PitRotation; users: User[]; onEdit: () => void; onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const userMap = useMemo(() => Object.fromEntries(users.map(u => [u._id, u])), [users]);
  const span = rotation.startMatch != null && rotation.endMatch != null
    ? rotation.endMatch - rotation.startMatch + 1 : null;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
      borderRadius: 12, border: `1px solid ${SURF_BORD}`, background: SURFACE,
    }}>
      {/* Range badge */}
      <div style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "6px 12px", borderRadius: 10, flexShrink: 0,
        background: G_DIM, border: `1px solid ${G_MED}`,
      }}>
        <Wrench size={11} style={{ color: G }} />
        <span style={{ fontSize: 13, fontWeight: 800, color: G, fontFamily: "monospace" }}>
          Q{rotation.startMatch}–Q{rotation.endMatch}
        </span>
      </div>

      {/* Label + span */}
      <div style={{ minWidth: 0 }}>
        {rotation.label && (
          <div style={{ fontSize: 13, fontWeight: 600, color: FG, marginBottom: 1 }}>{rotation.label}</div>
        )}
        {span != null && (
          <div style={{ fontSize: 11, color: MUTED }}>{span} match{span !== 1 ? "es" : ""}</div>
        )}
      </div>

      {/* Scout chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, flex: 1, minWidth: 0 }}>
        {rotation.scoutIds.map(id => {
          const u = userMap[id];
          return (
            <span key={id} style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "2px 9px", borderRadius: 20, fontSize: 12, fontWeight: 600,
              background: G_DIM, color: G, border: `1px solid ${G_MED}`,
            }}>
              {u ? firstName(u) : "?"}
            </span>
          );
        })}
        {rotation.scoutIds.length === 0 && (
          <span style={{ fontSize: 12, color: MUTED }}>No scouts assigned</span>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
        <button onClick={onEdit} style={{
          width: 30, height: 30, borderRadius: 8, border: `1.5px solid ${SURF_BORD}`,
          background: SURF_HVR, color: MUTED, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Pencil size={13} />
        </button>
        <button
          onClick={async () => { setDeleting(true); try { await onDelete(); } finally { setDeleting(false); } }}
          disabled={deleting}
          style={{
            width: 30, height: 30, borderRadius: 8,
            border: "1.5px solid oklch(0.577 0.245 27 / 30%)",
            background: "oklch(0.577 0.245 27 / 8%)",
            color: "var(--destructive)", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {deleting ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={13} />}
        </button>
      </div>
    </div>
  );
}

// ── Elims pit rotation panel ──────────────────────────────────────────────────
// Exactly one elims rotation per event, covering all playoff matches.

function ElimsRotationPanel({ rotation, users, allUsers: allUsersRaw, onSave, onDelete }: {
  rotation: PitRotation | null;
  users: User[];        // opted-in scouts
  allUsers?: User[];    // all scouts for manual override
  onSave: (scoutIds: Set<string>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(rotation?.scoutIds ?? []));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showAllElims, setShowAllElims] = useState(false);

  // Sync when rotation changes externally
  useEffect(() => { setSelected(new Set(rotation?.scoutIds ?? [])); }, [rotation]);

  const userMap = useMemo(() => Object.fromEntries(users.map(u => [u._id, u])), [users]);
  const optedInElimsIds = useMemo(() => new Set(users.map(u => u._id)), [users]);
  const othersElims = useMemo(() => (allUsersRaw ?? []).filter(u => !optedInElimsIds.has(u._id)), [allUsersRaw, optedInElimsIds]);

  function toggleScout(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handleSave() {
    setSaving(true);
    try { await onSave(selected); setEditing(false); } finally { setSaving(false); }
  }

  return (
    <div style={{
      borderRadius: 14, border: `1.5px solid ${G_STR}`,
      background: G_DIM, overflow: "hidden", flexShrink: 0,
    }}>
      {/* Header row */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "11px 16px", borderBottom: `1px solid ${G_MED}`,
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8, background: G, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 2px 8px ${G} / 40%`,
        }}>
          <Wrench size={14} color={G_TXT} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: G, letterSpacing: "-0.01em" }}>Elims Pit Rotation</div>
          <div style={{ fontSize: 11, color: MUTED }}>Covers all playoff matches (QF, SF, Finals)</div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, background: G_MED, color: G, borderRadius: 20, padding: "2px 9px" }}>
          Elims
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: "12px 16px 14px" }}>
        {!rotation && !editing ? (
          /* Not yet created */
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "8px 0 4px", textAlign: "center" }}>
            <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>No elims pit rotation set yet.</p>
            <button onClick={() => setEditing(true)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "7px 16px", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer",
                background: G, color: G_TXT, border: "none",
                boxShadow: `0 2px 8px ${G} / 30%`,
              }}
            >
              <Plus size={13} />Set Up Elims Rotation
            </button>
          </div>
        ) : editing || !rotation ? (
          /* Edit / create form */
          <>
            <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
              Scouts on elims pit duty
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: othersElims.length > 0 ? 6 : 12 }}>
              {users.length > 0
                ? users.map(u => {
                    const on = selected.has(u._id);
                    return (
                      <button key={u._id} onClick={() => toggleScout(u._id)}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 5,
                          padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                          background: on ? G : SURF_HVR,
                          color: on ? G_TXT : MUTED,
                          border: `1.5px solid ${on ? G_STR : SURF_BORD}`,
                          transition: "all 0.1s",
                        }}
                      >
                        {on && <Check size={11} />}
                        {firstName(u)}
                      </button>
                    );
                  })
                : <span style={{ fontSize: 12, color: MUTED }}>No scouts have opted into pit rotations.</span>
              }
            </div>
            {/* Non-opted-in scouts — manual override */}
            {othersElims.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <button
                  onClick={() => setShowAllElims(v => !v)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    fontSize: 11, fontWeight: 700, color: MUTED,
                    background: "transparent", border: "none", cursor: "pointer", padding: "2px 0",
                    textTransform: "uppercase", letterSpacing: "0.06em",
                  }}
                >
                  <ChevDown size={12} style={{ transform: showAllElims ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
                  {showAllElims ? "Hide" : "Add others"} ({othersElims.length} not opted in)
                </button>
                {showAllElims && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {othersElims.map(u => {
                      const on = selected.has(u._id);
                      return (
                        <button key={u._id} onClick={() => toggleScout(u._id)}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 5,
                            padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                            background: on ? G : SURF_HVR,
                            color: on ? G_TXT : MUTED,
                            border: `1.5px solid ${on ? G_STR : SURF_BORD}`,
                            transition: "all 0.1s",
                          }}
                        >
                          {on && <Check size={11} />}
                          {firstName(u)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleSave} disabled={saving || selected.size === 0}
                style={{
                  flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 13, fontWeight: 700,
                  background: selected.size > 0 && !saving ? G : SURF_HVR,
                  color: selected.size > 0 && !saving ? G_TXT : MUTED,
                  border: "none", cursor: selected.size > 0 ? "pointer" : "default",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}
              >
                {saving
                  ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />Saving…</>
                  : <><Check size={13} />{rotation ? "Save Changes" : "Create Rotation"}</>
                }
              </button>
              {rotation && (
                <button onClick={() => { setSelected(new Set(rotation.scoutIds)); setEditing(false); }}
                  style={{ padding: "8px 14px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", background: SURF_HVR, color: MUTED, border: `1.5px solid ${SURF_BORD}` }}
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        ) : (
          /* Display mode */
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, flex: 1, minWidth: 0 }}>
              {rotation.scoutIds.length === 0 ? (
                <span style={{ fontSize: 12, color: MUTED }}>No scouts assigned</span>
              ) : rotation.scoutIds.map(id => {
                const u = userMap[id];
                return (
                  <span key={id} style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                    background: G, color: G_TXT,
                    boxShadow: `0 1px 6px ${G} / 25%`,
                  }}>
                    {u ? firstName(u) : "?"}
                  </span>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
              <button onClick={() => setEditing(true)}
                style={{ width: 30, height: 30, borderRadius: 8, border: `1.5px solid ${SURF_BORD}`, background: SURF_HVR, color: MUTED, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Pencil size={13} />
              </button>
              <button
                onClick={async () => { setDeleting(true); try { await onDelete(); } finally { setDeleting(false); } }}
                disabled={deleting}
                style={{ width: 30, height: 30, borderRadius: 8, border: "1.5px solid oklch(0.577 0.245 27 / 30%)", background: "oklch(0.577 0.245 27 / 8%)", color: "var(--destructive)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                {deleting ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={13} />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Pit rotation form ─────────────────────────────────────────────────────────

interface RotationFormState {
  label: string;
  startMatch: string;
  endMatch: string;
  scoutIds: Set<string>;
}

function RotationForm({ users, allUsers: allUsersRaw, initial, onSave, onCancel, isEdit }: {
  users: User[];          // opted-in scouts
  allUsers?: User[];      // every scout (for manual override)
  initial?: RotationFormState;
  onSave: (form: RotationFormState) => Promise<void>;
  onCancel?: () => void;
  isEdit?: boolean;
}) {
  const [form, setForm] = useState<RotationFormState>(
    initial ?? { label: "", startMatch: "", endMatch: "", scoutIds: new Set() }
  );
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Scouts who haven't opted in but can be added manually
  const optedInIds = new Set(users.map(u => u._id));
  const othersAvail = (allUsersRaw ?? []).filter(u => !optedInIds.has(u._id));

  function toggleScout(id: string) {
    setForm(f => {
      const n = new Set(f.scoutIds);
      n.has(id) ? n.delete(id) : n.add(id);
      return { ...f, scoutIds: n };
    });
  }

  async function handleSubmit() {
    if (!form.startMatch || !form.endMatch) return;
    setSaving(true);
    try {
      await onSave(form);
      setForm({ label: "", startMatch: "", endMatch: "", scoutIds: new Set() });
    } finally { setSaving(false); }
  }

  const valid = !!form.startMatch && !!form.endMatch &&
    parseInt(form.startMatch) <= parseInt(form.endMatch) && form.scoutIds.size > 0;

  const inputStyle: React.CSSProperties = {
    flex: 1, padding: "7px 10px", borderRadius: 8, fontSize: 13,
    background: "var(--background)", border: `1.5px solid ${SURF_BORD}`,
    color: FG, outline: "none",
  };

  function ScoutChip({ u }: { u: User }) {
    const on = form.scoutIds.has(u._id);
    return (
      <button key={u._id} onClick={() => toggleScout(u._id)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
          background: on ? G : SURF_HVR,
          color: on ? G_TXT : MUTED,
          border: `1.5px solid ${on ? G_STR : SURF_BORD}`,
          transition: "all 0.1s",
        }}
      >
        {on && <Check size={11} />}
        {firstName(u)}
      </button>
    );
  }

  return (
    <div style={{
      padding: "14px 16px", borderRadius: 14,
      border: `1.5px solid ${isEdit ? G_STR : SURF_BORD}`,
      background: isEdit ? G_DIM : SURFACE,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
        {isEdit ? <Pencil size={14} style={{ color: G }} /> : <Plus size={14} style={{ color: MUTED }} />}
        <span style={{ fontSize: 13, fontWeight: 700, color: isEdit ? G : FG }}>
          {isEdit ? "Edit Rotation" : "New Pit Rotation"}
        </span>
      </div>

      {/* Range + label row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
          <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>Q</span>
          <input type="number" min={1} placeholder="Start"
            value={form.startMatch} onChange={e => setForm(f => ({ ...f, startMatch: e.target.value }))}
            style={{ ...inputStyle, width: 70, flex: "none" }}
          />
          <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>to Q</span>
          <input type="number" min={1} placeholder="End"
            value={form.endMatch} onChange={e => setForm(f => ({ ...f, endMatch: e.target.value }))}
            style={{ ...inputStyle, width: 70, flex: "none" }}
          />
        </div>
        <input type="text" placeholder="Label (optional — e.g. Morning shift)"
          value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
          style={{ ...inputStyle, flex: "1 1 200px" }}
        />
      </div>

      {/* Opted-in scouts */}
      <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
        Scouts on pit duty during this range
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: othersAvail.length > 0 ? 8 : 14 }}>
        {users.length > 0
          ? users.map(u => <ScoutChip key={u._id} u={u} />)
          : <span style={{ fontSize: 12, color: MUTED }}>No scouts have opted into pit rotations.</span>
        }
      </div>

      {/* Non-opted-in scouts — manual override section */}
      {othersAvail.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <button
            onClick={() => setShowAll(v => !v)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              fontSize: 11, fontWeight: 700, color: MUTED,
              background: "transparent", border: "none", cursor: "pointer", padding: "2px 0",
              textTransform: "uppercase", letterSpacing: "0.06em",
            }}
          >
            <ChevDown size={12} style={{ transform: showAll ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
            {showAll ? "Hide" : "Add others"} ({othersAvail.length} not opted in)
          </button>
          {showAll && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {othersAvail.map(u => <ScoutChip key={u._id} u={u} />)}
            </div>
          )}
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={handleSubmit} disabled={!valid || saving}
          style={{
            flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 13, fontWeight: 700,
            background: valid && !saving ? G : SURF_HVR,
            color: valid && !saving ? G_TXT : MUTED,
            border: "none", cursor: valid && !saving ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            transition: "all 0.15s",
          }}
        >
          {saving
            ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />Saving…</>
            : <><Check size={13} />{isEdit ? "Save Changes" : "Add Rotation"}</>
          }
        </button>
        {onCancel && (
          <button onClick={onCancel}
            style={{
              padding: "8px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600,
              cursor: "pointer", background: SURF_HVR, color: MUTED, border: `1.5px solid ${SURF_BORD}`,
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ── Auto-generate modal ───────────────────────────────────────────────────────

function AutoGenerateModal({
  result,
  onConfirm,
  onCancel,
  applying,
  applyError,
}: {
  result: SchedulerOutput;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  applying: boolean;
  applyError: string | null;
}) {
  const [showWarnings, setShowWarnings] = useState(false);
  const hasWarnings = result.warnings.length > 0;
  const blockCounts = Object.values(result.stats.scoutBlockCounts);
  const minBlocks = blockCounts.length ? Math.min(...blockCounts) : 0;
  const maxBlocks = blockCounts.length ? Math.max(...blockCounts) : 0;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 999,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "oklch(0 0 0 / 70%)",
      backdropFilter: "blur(4px)",
    }}>
      <div style={{
        width: "min(520px, 95vw)",
        borderRadius: 18,
        background: "var(--card, #111)",
        border: `1.5px solid ${G_STR}`,
        overflow: "hidden",
        boxShadow: `0 24px 80px oklch(0 0 0 / 60%), 0 0 0 1px ${G_MED}`,
      }}>
        {/* Header */}
        <div style={{
          padding: "18px 22px",
          background: G_DIM,
          borderBottom: `1px solid ${G_MED}`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: G, display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 4px 16px ${G} / 40%`, flexShrink: 0,
          }}>
            <Sparkles size={18} color={G_TXT} />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: G, letterSpacing: "-0.01em" }}>Auto-Generate Schedule</div>
            <div style={{ fontSize: 12, color: MUTED }}>Review before applying</div>
          </div>
        </div>

        {/* Stats grid */}
        <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              { label: "New pit rotations", value: result.stats.newPitRotationCount, icon: Wrench },
              { label: "Match slots filled", value: result.stats.assignedSlots, icon: LayoutGrid },
              { label: "Blocks per scout", value: `${minBlocks}–${maxBlocks}`, icon: Users },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} style={{
                padding: "12px 14px", borderRadius: 12,
                background: SURFACE, border: `1px solid ${SURF_BORD}`,
                display: "flex", flexDirection: "column", gap: 4,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, color: MUTED }}>
                  <Icon size={11} />
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</span>
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: G, letterSpacing: "-0.02em" }}>{value}</div>
              </div>
            ))}
          </div>

          {/* New pit rotations preview */}
          {result.newPitRotations.length > 0 && (
            <div style={{ borderRadius: 10, border: `1px solid ${SURF_BORD}`, overflow: "hidden" }}>
              <div style={{ padding: "8px 12px", background: G_DIM, borderBottom: `1px solid ${G_MED}`, fontSize: 11, fontWeight: 700, color: G, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                New pit rotations
              </div>
              <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
                {result.newPitRotations.map((r, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 800, color: G, background: G_DIM, padding: "2px 8px", borderRadius: 6, flexShrink: 0 }}>
                      Q{r.startMatch}–Q{r.endMatch}
                    </span>
                    <span style={{ color: MUTED }}>{r.scoutIds.length} scout{r.scoutIds.length !== 1 ? "s" : ""}</span>
                    <span style={{ fontSize: 11, color: "oklch(0.6 0 0)" }}>{r.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Warnings */}
          {hasWarnings && (
            <div style={{ borderRadius: 10, border: "1px solid oklch(0.65 0.18 55 / 40%)", overflow: "hidden" }}>
              <button
                onClick={() => setShowWarnings(w => !w)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px", background: "oklch(0.65 0.18 55 / 10%)",
                  border: "none", cursor: "pointer", textAlign: "left",
                }}
              >
                <TriangleAlert size={12} style={{ color: "oklch(0.75 0.18 55)" }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: "oklch(0.75 0.18 55)", flex: 1, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  {result.warnings.length} warning{result.warnings.length !== 1 ? "s" : ""}
                </span>
                <ChevDown size={12} style={{ color: "oklch(0.75 0.18 55)", transform: showWarnings ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
              </button>
              {showWarnings && (
                <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                  {result.warnings.map((w, i) => (
                    <div key={i} style={{ fontSize: 11, color: "oklch(0.7 0.12 55)" }}>• {w}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Error banner */}
          {applyError && (
            <div style={{
              margin: "0 0 8px", padding: "10px 14px", borderRadius: 9,
              background: "oklch(0.4 0.2 30 / 20%)",
              border: "1px solid oklch(0.55 0.22 30 / 50%)",
              fontSize: 12, color: "oklch(0.78 0.18 30)",
            }}>
              ⚠ {applyError}
            </div>
          )}

          {/* Empty-result note */}
          {result.matchAssignments.length === 0 && result.newPitRotations.length === 0 && (
            <div style={{
              margin: "0 0 8px", padding: "10px 14px", borderRadius: 9,
              background: "oklch(0.5 0.15 270 / 12%)",
              border: "1px solid oklch(0.6 0.15 270 / 30%)",
              fontSize: 12, color: "oklch(0.75 0.12 270)",
            }}>
              All slots are already assigned — nothing new to apply. Clear existing assignments first if you want to regenerate.
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onCancel}
              disabled={applying}
              style={{
                flex: 1, padding: "10px 0", borderRadius: 10, fontSize: 13, fontWeight: 600,
                background: SURF_HVR, color: MUTED, border: `1.5px solid ${SURF_BORD}`, cursor: "pointer",
              }}
            >Cancel</button>
            <button
              onClick={onConfirm}
              disabled={applying || (result.matchAssignments.length === 0 && result.newPitRotations.length === 0)}
              style={{
                flex: 2, padding: "10px 0", borderRadius: 10, fontSize: 13, fontWeight: 700,
                background: G, color: G_TXT, border: "none",
                cursor: (applying || (result.matchAssignments.length === 0 && result.newPitRotations.length === 0)) ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                boxShadow: `0 4px 14px ${G} / 35%`,
                opacity: (applying || (result.matchAssignments.length === 0 && result.newPitRotations.length === 0)) ? 0.45 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {applying
                ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />Applying…</>
                : <><Sparkles size={14} />Apply Schedule</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pit scouting tab (TBA-driven per-team assignments) ────────────────────────

interface TBATeamSimple {
  key: string;
  team_number: number;
  nickname: string;
}

function PitScoutingTab({
  tbaTeams,
  tbaLoading,
  tbaError,
  assignments,
  allUsers,
  onToggleScout,
  onClearAll,
  onAutoAssign,
  optedInCount,
  isMobile,
}: {
  tbaTeams: TBATeamSimple[];
  tbaLoading: boolean;
  tbaError: boolean;
  assignments: Map<number, string[]>;
  allUsers: User[];
  onToggleScout: (teamNumber: number, scoutId: string) => Promise<void>;
  onClearAll: () => Promise<void>;
  onAutoAssign: (teams: TBATeamSimple[]) => Promise<void>;
  optedInCount: number;
  isMobile: boolean;
}) {
  const [pinnedScoutId, setPinnedScoutId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState<Set<number>>(new Set());
  const [clearingAll, setClearingAll] = useState(false);
  const [autoAssigning, setAutoAssigning] = useState(false);

  const filtered = useMemo(() =>
    tbaTeams.filter(t =>
      !search ||
      String(t.team_number).includes(search) ||
      (t.nickname ?? "").toLowerCase().includes(search.toLowerCase())
    ), [tbaTeams, search]);

  const assignedCount = assignments.size;
  const totalCount    = tbaTeams.length;

  async function handleCellClick(teamNum: number) {
    if (!pinnedScoutId) return;
    setSaving(prev => new Set(prev).add(teamNum));
    try { await onToggleScout(teamNum, pinnedScoutId); }
    finally { setSaving(prev => { const n = new Set(prev); n.delete(teamNum); return n; }); }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>

      {/* ── Scout selector + stats row ── */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", flexShrink: 0, alignItems: "flex-start" }}>

        {/* Scout chips */}
        <div style={{
          flex: "1 1 200px", borderRadius: 12, border: `1px solid ${SURF_BORD}`,
          background: SURFACE, padding: "10px 12px",
        }}>
          <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em", color: MUTED, marginBottom: 8 }}>
            Pin a scout then click teams
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {allUsers.map(u => {
              const pinned = u._id === pinnedScoutId;
              const count  = [...assignments.values()].filter(ids => ids.includes(u._id)).length;
              return (
                <button key={u._id}
                  onClick={() => setPinnedScoutId(pinned ? null : u._id)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                    cursor: "pointer", transition: "all 0.12s",
                    background: pinned ? G : SURF_HVR,
                    color:      pinned ? G_TXT : MUTED,
                    border:     `1.5px solid ${pinned ? G_STR : SURF_BORD}`,
                    boxShadow:  pinned ? `0 2px 8px ${G} / 30%` : "none",
                  }}
                >
                  {u.image
                    ? <img src={u.image} alt="" style={{ width: 14, height: 14, borderRadius: "50%", objectFit: "cover" }} />
                    : <span style={{ width: 14, height: 14, borderRadius: "50%", background: pinned ? G_TXT+"30" : G_MED, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 800, color: pinned ? G_TXT : G, flexShrink: 0 }}>{avatarLetter(u)}</span>
                  }
                  {firstName(u)}
                  {count > 0 && (
                    <span style={{ background: pinned ? "oklch(0 0 0 / 20%)" : G_MED, borderRadius: 20, padding: "0 5px", fontSize: 10, fontWeight: 800, color: pinned ? G_TXT : G }}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Stats + clear */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{
            display: "flex", gap: 6,
            padding: "10px 12px", borderRadius: 12,
            background: SURFACE, border: `1px solid ${SURF_BORD}`,
          }}>
            {[
              { label: "Assigned", val: assignedCount,              col: G       },
              { label: "Total",    val: totalCount,                  col: MUTED   },
              { label: "Empty",    val: totalCount - assignedCount,  col: MUTED   },
            ].map(({ label, val, col }) => (
              <div key={label} style={{ textAlign: "center", padding: "0 10px" }}>
                <div style={{ fontSize: 20, fontWeight: 900, color: col, lineHeight: 1 }}>{val}</div>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: MUTED }}>{label}</div>
              </div>
            ))}
          </div>
          {/* Auto Assign */}
          {tbaTeams.length > 0 && (
            <button
              onClick={async () => {
                const msg = optedInCount > 0
                  ? `Auto-assign ${optedInCount} opted-in scouts into pairs of 2, covering ~5 teams each?`
                  : `No scouts have opted in yet — assign all ${allUsers.length} scouts into pairs of 2 anyway?`;
                if (!window.confirm(msg)) return;
                setAutoAssigning(true);
                try { await onAutoAssign(tbaTeams); } finally { setAutoAssigning(false); }
              }}
              disabled={autoAssigning}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                padding: "7px 12px", borderRadius: 9, fontSize: 12, fontWeight: 700,
                background: G_DIM, color: G, border: `1.5px solid ${G_STR}`, cursor: "pointer",
                boxShadow: `0 2px 8px ${G} / 20%`,
              }}
            >
              {autoAssigning
                ? <><Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />Assigning…</>
                : <><Zap size={12} />Auto Assign{optedInCount > 0 ? ` (${optedInCount} opted in)` : ""}</>
              }
            </button>
          )}
          {assignedCount > 0 && (
            <button
              onClick={async () => {
                if (!window.confirm(`Clear all ${assignedCount} pit scouting assignments for this event?`)) return;
                setClearingAll(true);
                try { await onClearAll(); } finally { setClearingAll(false); }
              }}
              disabled={clearingAll}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                padding: "7px 12px", borderRadius: 9, fontSize: 12, fontWeight: 700,
                background: "oklch(0.577 0.245 27 / 10%)", color: "var(--destructive)",
                border: "1.5px solid oklch(0.577 0.245 27 / 30%)", cursor: "pointer",
              }}
            >
              {clearingAll ? <><Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />Clearing…</> : <><Trash2 size={12} />Clear All</>}
            </button>
          )}
        </div>
      </div>

      {/* ── Search bar ── */}
      <input
        type="text"
        placeholder="Search by team number or name…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          padding: "8px 12px", borderRadius: 10, fontSize: 13,
          background: SURFACE, border: `1.5px solid ${SURF_BORD}`,
          color: FG, outline: "none", flexShrink: 0, width: "100%",
        }}
      />

      {/* ── Team grid ── */}
      {tbaLoading ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: MUTED }}>
          <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
          <span style={{ fontSize: 14 }}>Loading teams from TBA…</span>
        </div>
      ) : tbaError || tbaTeams.length === 0 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center", color: MUTED }}>
          <AlertCircle size={28} style={{ opacity: 0.4 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4, color: FG }}>
              {tbaTeams.length === 0 && !tbaError ? "No teams yet" : "Couldn't load teams"}
            </div>
            <div style={{ fontSize: 12 }}>Check your TBA API key in Settings.</div>
          </div>
        </div>
      ) : (
        <ScrollArea style={{ flex: 1 }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "repeat(auto-fill, minmax(130px, 1fr))" : "repeat(auto-fill, minmax(160px, 1fr))",
            gap: 6, paddingBottom: 16,
          }}>
            {filtered.map(team => {
              const scoutIds   = assignments.get(team.team_number) ?? [];
              const hasPinned  = pinnedScoutId ? scoutIds.includes(pinnedScoutId) : false;
              const isSaving   = saving.has(team.team_number);
              const hasAny     = scoutIds.length > 0;

              return (
                <button
                  key={team.team_number}
                  onClick={() => pinnedScoutId && handleCellClick(team.team_number)}
                  disabled={!pinnedScoutId || isSaving}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "flex-start",
                    padding: "10px 12px", borderRadius: 12, textAlign: "left",
                    cursor: pinnedScoutId ? "pointer" : "default",
                    background: hasPinned ? G : hasAny ? G_DIM : SURFACE,
                    border: `1.5px solid ${hasPinned ? G_STR : hasAny ? G_MED : SURF_BORD}`,
                    transition: "all 0.12s",
                    boxShadow: hasPinned ? `0 2px 10px ${G} / 30%` : "none",
                    opacity: isSaving ? 0.6 : 1,
                    position: "relative",
                    overflow: "hidden",
                  }}
                  onMouseEnter={e => { if (pinnedScoutId && !isSaving) (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-1px)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = "none"; }}
                >
                  {isSaving && (
                    <Loader2 size={12} style={{ position: "absolute", top: 8, right: 8, animation: "spin 1s linear infinite", color: hasPinned ? G_TXT : G }} />
                  )}
                  {/* Team number */}
                  <div style={{
                    fontSize: 20, fontWeight: 900, lineHeight: 1,
                    color: hasPinned ? G_TXT : G,
                    letterSpacing: "-0.02em",
                  }}>
                    {team.team_number}
                  </div>
                  {/* Nickname */}
                  <div style={{
                    fontSize: 10, color: hasPinned ? `${G_TXT}cc` : MUTED,
                    marginTop: 2, lineHeight: 1.3,
                    overflow: "hidden", textOverflow: "ellipsis",
                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                    maxWidth: "100%",
                  }}>
                    {team.nickname}
                  </div>
                  {/* Assigned scout chips */}
                  {scoutIds.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 6 }}>
                      {scoutIds.map(id => {
                        const u = allUsers.find(u => u._id === id);
                        return (
                          <span key={id} style={{
                            fontSize: 9, fontWeight: 700,
                            padding: "1px 6px", borderRadius: 20,
                            background: hasPinned ? "oklch(0 0 0 / 20%)" : G_MED,
                            color: hasPinned ? G_TXT : G,
                          }}>
                            {u ? firstName(u) : "?"}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "24px 0", color: MUTED, fontSize: 13 }}>
                No teams match "{search}"
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      {/* Hint when no scout pinned */}
      {!pinnedScoutId && tbaTeams.length > 0 && !tbaLoading && (
        <div style={{
          flexShrink: 0, textAlign: "center", fontSize: 12, color: MUTED,
          padding: "8px 0", borderTop: `1px solid ${SURF_BORD}`,
        }}>
          ↑ Pin a scout above, then click team cards to assign them
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SchedulingPage() {
  const { isAdminMode } = useUIStore();
  const [activeTab, setActiveTab] = useState<TabType>("matches");
  const [pinnedScoutId, setPinnedScoutId] = useState<string | null>(null);
  const [matches, setMatches] = useState<TBAMatch[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState(false);
  const [savingCells, setSavingCells] = useState<Set<string>>(new Set());
  const [editingRotation, setEditingRotation] = useState<PitRotation | null>(null);
  const [autoGenResult, setAutoGenResult] = useState<SchedulerOutput | null>(null);
  const [autoGenApplying, setAutoGenApplying] = useState(false);
  const [autoGenRunning, setAutoGenRunning] = useState(false);
  const [autoGenError, setAutoGenError] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [excludedScoutIds, setExcludedScoutIds] = useState<Set<string>>(new Set());
  const [showExcludePanel, setShowExcludePanel] = useState(false);

  // Responsive: track viewport size + orientation
  const getVp = () =>
    typeof window === "undefined"
      ? { mobile: false, landscape: false, shortScreen: false }
      : { mobile: window.innerWidth < 1024, landscape: window.innerWidth > window.innerHeight, shortScreen: window.innerHeight < 500 };
  const [vp, setVp] = useState(getVp);
  useEffect(() => {
    const fn = () => setVp(getVp());
    window.addEventListener("resize", fn);
    window.addEventListener("orientationchange", fn);
    return () => { window.removeEventListener("resize", fn); window.removeEventListener("orientationchange", fn); };
  }, []);

  const isMobile         = vp.mobile;                                    // < 1024px wide
  const isLandscapePhone = vp.landscape && vp.shortScreen;               // rotated phone (< 500px tall)
  const stackLayout      = vp.mobile && !vp.landscape;                   // portrait phone → stack vertically

  const currentEvent = useCached(useQuery(api.events.getCurrentEvent), "current_event");
  const allUsers     = useQuery(api.users.listUsers) as User[] | undefined;
  const allAssignments = useQuery(
    api.schedules.listMatchAssignments,
    currentEvent ? { eventKey: currentEvent.eventKey } : "skip"
  ) as MatchAssignment[] | undefined;
  const pitRotations = useQuery(
    api.schedules.listPitRotations,
    currentEvent ? { eventKey: currentEvent.eventKey } : "skip"
  ) as PitRotation[] | undefined;
  const allPreferences = useQuery(
    api.schedules.listAllPreferences,
    currentEvent ? { eventKey: currentEvent.eventKey } : "skip"
  );

  const setMatchAssignment       = useMutation(api.schedules.setMatchAssignment);
  const clearMatchAssignment     = useMutation(api.schedules.clearMatchAssignment);
  const clearAllMatchAssignments = useMutation(api.schedules.clearAllMatchAssignments);
  const batchSet                 = useMutation(api.schedules.batchSetMatchAssignments);
  const upsertRotation           = useMutation(api.schedules.upsertPitRotation);
  const deleteRotation           = useMutation(api.schedules.deletePitRotation);
  const togglePitScout           = useMutation(api.pitScouting.upsertPitScoutingAssignment);
  const clearAllPitScouting      = useMutation(api.pitScouting.clearAllPitScoutingAssignments);
  const batchUpsertPitScouting   = useMutation(api.pitScouting.batchUpsertPitScoutingAssignments);

  const pitScoutingTeams = useQuery(
    api.pitScouting.listPitScoutingTeams,
    currentEvent ? { eventKey: currentEvent.eventKey } : "skip"
  ) as PitScoutingTeam[] | undefined;

  // TBA event teams (for pit scouting tab)
  const [tbaTeams, setTbaTeams] = useState<TBATeam[]>([]);
  const [tbaTeamsLoading, setTbaTeamsLoading] = useState(false);
  const [tbaTeamsError, setTbaTeamsError] = useState(false);

  useEffect(() => {
    if (activeTab !== "pitScouting" || !currentEvent?.eventKey) return;
    setTbaTeamsLoading(true); setTbaTeamsError(false);
    fetchTBAEventTeams(currentEvent.eventKey)
      .then(data => {
        if (Array.isArray(data)) setTbaTeams([...data].sort((a, b) => a.team_number - b.team_number));
        else setTbaTeamsError(true);
      })
      .catch(() => setTbaTeamsError(true))
      .finally(() => setTbaTeamsLoading(false));
  }, [activeTab, currentEvent?.eventKey]);

  // Map teamNumber -> scoutIds from Convex pitScoutingTeams
  const pitAssignmentsMap = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const t of pitScoutingTeams ?? []) m.set(t.teamNumber, [...t.scoutIds]);
    return m;
  }, [pitScoutingTeams]);

  async function handleTogglePitScout(teamNumber: number, scoutId: string) {
    if (!currentEvent) return;
    const current = pitAssignmentsMap.get(teamNumber) ?? [];
    const next = current.includes(scoutId)
      ? current.filter(id => id !== scoutId)
      : [...current, scoutId];
    await togglePitScout({
      eventKey: currentEvent.eventKey,
      teamNumber,
      scoutIds: next as Id<"users">[],
    });
  }

  /**
   * Auto-assign pit scouting:
   * 1. Take scouts who opted in (wantsPitScouting=true). Fall back to all users if none opted in.
   * 2. Group into pairs of 2 (last group may be 2 or 3 depending on count).
   * 3. Distribute TBA teams sequentially across pairs, ~5 teams each.
   *    (actual count = ceil(totalTeams / numPairs))
   * 4. Batch-save to Convex.
   */
  async function handleAutoAssignPitScouting(teams: TBATeamSimple[]) {
    if (!currentEvent || teams.length === 0) return;
    const prefs = (allPreferences ?? []) as Array<{ scoutId: string; wantsPitScouting?: boolean }>;
    const optedIn = prefs.filter(p => p.wantsPitScouting === true).map(p => p.scoutId);
    // Fall back to all users if nobody has opted in yet
    const pool = optedIn.length > 0
      ? (allUsers ?? []).filter(u => optedIn.includes(u._id))
      : (allUsers ?? []);
    if (pool.length === 0) return;

    // Build pairs (groups of 2, last group may be 3 if odd)
    const pairs: string[][] = [];
    for (let i = 0; i < pool.length; i += 2) {
      if (i + 1 < pool.length) {
        pairs.push([pool[i]._id, pool[i + 1]._id]);
      } else {
        // Odd scout: add to last pair to make a trio
        if (pairs.length > 0) pairs[pairs.length - 1].push(pool[i]._id);
        else pairs.push([pool[i]._id]);
      }
    }

    // Distribute teams: ~5 per pair
    const teamsPerPair = Math.ceil(teams.length / pairs.length);
    const assignments: { teamNumber: number; scoutIds: Id<"users">[] }[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const slice = teams.slice(i * teamsPerPair, (i + 1) * teamsPerPair);
      for (const t of slice) {
        assignments.push({ teamNumber: t.team_number, scoutIds: pairs[i] as Id<"users">[] });
      }
    }

    await batchUpsertPitScouting({ eventKey: currentEvent.eventKey, assignments });
  }

  // Load / persist excluded scout IDs per event
  useEffect(() => {
    if (!currentEvent?.eventKey) return;
    try {
      const saved = localStorage.getItem(`falconscout_excluded_scouts_${currentEvent.eventKey}`);
      setExcludedScoutIds(saved ? new Set(JSON.parse(saved) as string[]) : new Set());
    } catch { setExcludedScoutIds(new Set()); }
  }, [currentEvent?.eventKey]);

  function toggleExcluded(id: string) {
    setExcludedScoutIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      if (currentEvent?.eventKey) {
        try {
          localStorage.setItem(
            `falconscout_excluded_scouts_${currentEvent.eventKey}`,
            JSON.stringify([...next])
          );
        } catch { /* ignore */ }
      }
      return next;
    });
  }

  // Load TBA matches
  useEffect(() => {
    if (!currentEvent?.eventKey) { setMatches([]); return; }
    setMatchesLoading(true); setMatchesError(false);
    fetchTBAEventMatches(currentEvent.eventKey)
      .then(data => {
        if (Array.isArray(data)) setMatches([...data].sort((a, b) => matchSortKey(a) - matchSortKey(b)));
        else setMatchesError(true);
      })
      .catch(() => setMatchesError(true))
      .finally(() => setMatchesLoading(false));
  }, [currentEvent?.eventKey]);

  const userMap = useMemo(() => Object.fromEntries((allUsers ?? []).map(u => [u._id, u])), [allUsers]);

  // Scouts who opted into pit rotations (wantsPitRotation === true)
  // If no preferences exist at all, fall back to showing everyone.
  const pitUsers = useMemo(() => {
    const prefs = allPreferences as Array<{ scoutId: string; wantsPitRotation: boolean }> | undefined;
    if (!prefs || prefs.length === 0) return allUsers ?? [];
    const optedIn = new Set(prefs.filter(p => p.wantsPitRotation).map(p => p.scoutId));
    return (allUsers ?? []).filter(u => optedIn.has(u._id));
  }, [allUsers, allPreferences]);

  const pitHiddenCount = (allUsers?.length ?? 0) - pitUsers.length;

  const assignMap = useMemo(() => {
    const map: Record<number, Partial<Record<Position, { scoutId: string; name: string; fullName: string }>>> = {};
    for (const a of allAssignments ?? []) {
      if (!map[a.matchNumber]) map[a.matchNumber] = {};
      const u = userMap[a.scoutId];
      map[a.matchNumber][a.position] = { scoutId: a.scoutId, name: u ? firstName(u) : "?", fullName: u ? displayName(u) : "?" };
    }
    return map;
  }, [allAssignments, userMap]);

  const matchCounts = useMemo(() => {
    const cnt: Record<string, number> = {};
    for (const a of allAssignments ?? []) cnt[a.scoutId] = (cnt[a.scoutId] ?? 0) + 1;
    return cnt;
  }, [allAssignments]);

  async function handleCellClick(matchNum: number, matchLbl: string, pos: Position) {
    if (!currentEvent || !pinnedScoutId) return;
    const key = `${matchNum}-${pos}`;
    setSavingCells(p => new Set(p).add(key));
    try {
      const current = assignMap[matchNum]?.[pos];
      if (current?.scoutId === pinnedScoutId) {
        await clearMatchAssignment({ eventKey: currentEvent.eventKey, matchNumber: matchNum, position: pos });
      } else {
        await setMatchAssignment({
          eventKey: currentEvent.eventKey, matchNumber: matchNum, matchLabel: matchLbl,
          position: pos, scoutId: pinnedScoutId as Id<"users">,
        });
      }
    } finally {
      setSavingCells(p => { const n = new Set(p); n.delete(key); return n; });
    }
  }

  async function handleBatchAssign(start: number, end: number, positions: Set<Position>) {
    if (!currentEvent || !pinnedScoutId) return;
    const inRange = matches.filter(m => m.comp_level === "qm" && m.match_number >= start && m.match_number <= end);
    const assignments: Parameters<typeof batchSet>[0]["assignments"] = [];
    for (const m of inRange) {
      for (const pos of positions) {
        assignments.push({
          matchNumber: m.match_number, matchLabel: tbaMatchLabel(m),
          position: pos, scoutId: pinnedScoutId as Id<"users">,
        });
      }
    }
    if (assignments.length > 0) await batchSet({ eventKey: currentEvent.eventKey, assignments });
  }

  async function handleSaveRotation(form: RotationFormState, id?: string) {
    if (!currentEvent) return;
    await upsertRotation({
      id: id as Id<"pitRotations"> | undefined,
      eventKey: currentEvent.eventKey,
      label: form.label || undefined,
      startMatch: parseInt(form.startMatch),
      endMatch: parseInt(form.endMatch),
      scoutIds: Array.from(form.scoutIds) as Id<"users">[],
    });
    setEditingRotation(null);
  }

  async function handleClearAll() {
    if (!currentEvent) return;
    const count = (allAssignments ?? []).length;
    if (count === 0) return;
    const confirmed = window.confirm(
      `Clear all ${count} match assignment${count !== 1 ? "s" : ""} for this event? This cannot be undone.`
    );
    if (!confirmed) return;
    setClearingAll(true);
    try {
      await clearAllMatchAssignments({ eventKey: currentEvent.eventKey });
    } finally {
      setClearingAll(false);
    }
  }

  // ── Auto-generate handler ─────────────────────────────────────────────────
  const handleAutoGenerate = useCallback(async () => {
    if (!currentEvent || !allUsers || !matches.length) return;
    setAutoGenRunning(true);
    try {
      const qualMatches = matches
        .filter(m => m.comp_level === "qm")
        .map(m => ({ matchNumber: m.match_number, matchLabel: tbaMatchLabel(m) }));

      const prefs = (allPreferences as Array<{
        scoutId: string;
        preferredPartners: string[];
        wantsMoreMatches: boolean;
        wantsPitRotation: boolean;
      }> | undefined) ?? [];

      const existingAssigns = (allAssignments ?? []).map(a => ({
        matchNumber: a.matchNumber,
        position: a.position as GenPosition,
        scoutId: a.scoutId,
      }));

      const existingPit = (pitRotations ?? []).map(r => ({
        _id: r._id,
        startMatch: r.startMatch,
        endMatch: r.endMatch,
        isElims: r.isElims,
        scoutIds: r.scoutIds,
      }));

      const result = generateSchedule({
        qualMatches,
        scouts: allUsers,
        preferences: prefs,
        existingPitRotations: existingPit,
        existingMatchAssignments: existingAssigns,
        excludedScoutIds: [...excludedScoutIds],
      });

      setAutoGenResult(result);
    } finally {
      setAutoGenRunning(false);
    }
  }, [currentEvent, allUsers, matches, allPreferences, allAssignments, pitRotations, excludedScoutIds]);

  const handleAutoApply = useCallback(async () => {
    if (!autoGenResult || !currentEvent) return;
    setAutoGenApplying(true);
    setAutoGenError(null);
    try {
      // 1. Create new pit rotations
      for (const rot of autoGenResult.newPitRotations) {
        await upsertRotation({
          id: undefined,
          eventKey: currentEvent.eventKey,
          label: rot.label,
          startMatch: rot.startMatch,
          endMatch: rot.endMatch,
          scoutIds: rot.scoutIds as Id<"users">[],
        });
      }
      // 2. Batch create match assignments in chunks of 50
      const allNew = autoGenResult.matchAssignments;
      const CHUNK = 50;
      for (let i = 0; i < allNew.length; i += CHUNK) {
        const slice = allNew.slice(i, i + CHUNK);
        await batchSet({
          eventKey: currentEvent.eventKey,
          assignments: slice.map(a => ({
            matchNumber: a.matchNumber,
            matchLabel: a.matchLabel,
            position: a.position as import("../../convex/_generated/dataModel").Doc<"matchAssignments">["position"],
            scoutId: a.scoutId as Id<"users">,
          })),
        });
      }
      setAutoGenResult(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setAutoGenError(`Failed to apply: ${msg}`);
      console.error("[AutoApply] error:", err);
    } finally {
      setAutoGenApplying(false);
    }
  }, [autoGenResult, currentEvent, upsertRotation, batchSet]);

  if (!isAdminMode) return <AdminLockScreen />;

  const totalSlots  = matches.length * 6;
  const filledSlots = (allAssignments ?? []).length;
  const pct = totalSlots > 0 ? Math.round((filledSlots / totalSlots) * 100) : 0;

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", gap: 16 }}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0 }}>
        {/* Top row: icon + title + progress bar */}
        <div style={{ display: "flex", alignItems: "center", gap: isLandscapePhone ? 8 : 12, marginBottom: isLandscapePhone ? 4 : (currentEvent && (allUsers || filledSlots > 0) ? 8 : 4) }}>
          {!isLandscapePhone && (
            <div style={{
              width: 38, height: 38, borderRadius: 10, background: G, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: `0 4px 16px ${G} / 45%`,
            }}>
              <LayoutGrid size={19} color={G_TXT} />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ fontSize: isLandscapePhone ? 15 : isMobile ? 18 : 22, fontWeight: 800, color: FG, margin: 0, lineHeight: 1.2, letterSpacing: "-0.02em" }}>
              Scheduling
            </h1>
            {!isLandscapePhone && (
              <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>
                {currentEvent
                  ? `${currentEvent.eventName ?? currentEvent.eventKey} · ${filledSlots}/${totalSlots} slots filled`
                  : "Set an event in Settings to build a schedule"}
              </p>
            )}
          </div>
          {currentEvent && totalSlots > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <div style={{ width: isLandscapePhone ? 60 : isMobile ? 70 : 120, height: 5, borderRadius: 999, background: SURF_BORD, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 999, background: G, width: `${pct}%`, transition: "width 0.4s ease" }} />
              </div>
              <span style={{ fontSize: isLandscapePhone ? 11 : 12, fontWeight: 700, color: G, minWidth: 28 }}>{pct}%</span>
            </div>
          )}
        </div>
        {/* Action buttons row — hidden in landscape phone to save space (use auto-gen sparingly) */}
        {!isLandscapePhone && currentEvent && (allUsers && matches.length > 0 || filledSlots > 0) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {allUsers && matches.length > 0 && (
                <button
                  onClick={handleAutoGenerate}
                  disabled={autoGenRunning}
                  style={{
                    display: "flex", alignItems: "center", gap: 7,
                    padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 700,
                    background: G, color: G_TXT, border: "none",
                    cursor: autoGenRunning ? "wait" : "pointer",
                    boxShadow: `0 4px 14px ${G} / 35%`,
                    flexShrink: 0, opacity: autoGenRunning ? 0.7 : 1,
                    transition: "opacity 0.15s, box-shadow 0.15s",
                    flex: isMobile ? "1 1 auto" : "none",
                  }}
                  onMouseEnter={e => { if (!autoGenRunning) (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 6px 20px ${G} / 50%`; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 14px ${G} / 35%`; }}
                >
                  {autoGenRunning
                    ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />Generating…</>
                    : <><Sparkles size={14} />Auto-Generate</>}
                </button>
              )}
              {/* Exclude scouts toggle button */}
              {allUsers && allUsers.length > 0 && matches.length > 0 && (
                <button
                  onClick={() => setShowExcludePanel(v => !v)}
                  title="Select scouts to exclude from auto-schedule generation"
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "8px 14px", borderRadius: 10, fontSize: 13, fontWeight: 700,
                    background: excludedScoutIds.size > 0
                      ? "oklch(0.55 0.18 30 / 15%)"
                      : SURF_HVR,
                    color: excludedScoutIds.size > 0
                      ? "oklch(0.75 0.18 30)"
                      : MUTED,
                    border: excludedScoutIds.size > 0
                      ? "1.5px solid oklch(0.55 0.18 30 / 40%)"
                      : `1.5px solid ${SURF_BORD}`,
                    cursor: "pointer", flexShrink: 0,
                    transition: "all 0.15s",
                  }}
                >
                  <Users size={13} />
                  Exclude
                  {excludedScoutIds.size > 0 && (
                    <span style={{
                      background: "oklch(0.55 0.18 30 / 25%)",
                      borderRadius: 20, padding: "0 6px", fontSize: 11, fontWeight: 800,
                      color: "oklch(0.75 0.18 30)",
                    }}>
                      {excludedScoutIds.size}
                    </span>
                  )}
                </button>
              )}
              {filledSlots > 0 && (
                <button
                  onClick={handleClearAll}
                  disabled={clearingAll}
                  title="Remove all match assignments for this event"
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "8px 14px", borderRadius: 10, fontSize: 13, fontWeight: 700,
                    background: "oklch(0.577 0.245 27 / 12%)",
                    color: "var(--destructive)",
                    border: "1.5px solid oklch(0.577 0.245 27 / 35%)",
                    cursor: clearingAll ? "wait" : "pointer",
                    flexShrink: 0, opacity: clearingAll ? 0.6 : 1,
                    transition: "opacity 0.15s, background 0.15s",
                    flex: isMobile ? "1 1 auto" : "none",
                  }}
                  onMouseEnter={e => { if (!clearingAll) (e.currentTarget as HTMLButtonElement).style.background = "oklch(0.577 0.245 27 / 20%)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "oklch(0.577 0.245 27 / 12%)"; }}
                >
                  {clearingAll
                    ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />Clearing…</>
                    : <><Trash2 size={13} />Clear All</>}
                </button>
              )}
            </div>

            {/* ── Exclude from auto-schedule panel ── */}
            {showExcludePanel && allUsers && allUsers.length > 0 && (
              <div style={{
                padding: "12px 14px",
                borderRadius: 12,
                border: `1.5px solid oklch(0.55 0.18 30 / 35%)`,
                background: "oklch(0.55 0.18 30 / 6%)",
                display: "flex", flexDirection: "column", gap: 10,
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <Users size={13} style={{ color: "oklch(0.72 0.18 30)" }} />
                    <span style={{
                      fontSize: 11, fontWeight: 700, textTransform: "uppercase",
                      letterSpacing: "0.08em", color: "oklch(0.72 0.18 30)",
                    }}>
                      Exclude from Auto-Schedule
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {excludedScoutIds.size > 0 && (
                      <button
                        onClick={() => {
                          setExcludedScoutIds(new Set());
                          if (currentEvent?.eventKey) {
                            try { localStorage.removeItem(`falconscout_excluded_scouts_${currentEvent.eventKey}`); } catch { /* ignore */ }
                          }
                        }}
                        style={{
                          fontSize: 11, fontWeight: 700, color: "oklch(0.72 0.18 30)",
                          background: "transparent", border: "none", cursor: "pointer",
                          textDecoration: "underline", textUnderlineOffset: 2,
                        }}
                      >
                        Clear all
                      </button>
                    )}
                    <button
                      onClick={() => setShowExcludePanel(false)}
                      style={{
                        fontSize: 16, lineHeight: 1, background: SURF_HVR,
                        border: `1px solid ${SURF_BORD}`, borderRadius: 6,
                        padding: "1px 7px", color: MUTED, cursor: "pointer",
                      }}
                    >×</button>
                  </div>
                </div>
                <p style={{ fontSize: 11, color: MUTED, margin: 0, lineHeight: 1.4 }}>
                  Scouts toggled below will be skipped when auto-generating — they won't receive any new match assignments or pit rotations.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {(allUsers ?? []).map(u => {
                    const excluded = excludedScoutIds.has(u._id);
                    return (
                      <button
                        key={u._id}
                        onClick={() => toggleExcluded(u._id)}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6,
                          padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                          cursor: "pointer", transition: "all 0.12s",
                          background: excluded ? "oklch(0.55 0.18 30 / 18%)" : SURF_HVR,
                          color: excluded ? "oklch(0.75 0.18 30)" : MUTED,
                          border: excluded
                            ? "1.5px solid oklch(0.55 0.18 30 / 50%)"
                            : `1.5px solid ${SURF_BORD}`,
                        }}
                      >
                        {u.image
                          ? <img src={u.image} alt="" style={{ width: 16, height: 16, borderRadius: "50%", objectFit: "cover" }} />
                          : <span style={{
                              width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
                              background: excluded ? "oklch(0.55 0.18 30 / 40%)" : G_MED,
                              color: excluded ? "oklch(0.75 0.18 30)" : G,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 9, fontWeight: 800,
                            }}>
                              {avatarLetter(u)}
                            </span>
                        }
                        <span style={{
                          textDecoration: excluded ? "line-through" : "none",
                          opacity: excluded ? 0.75 : 1,
                        }}>
                          {firstName(u)}
                        </span>
                        {excluded && (
                          <span style={{
                            fontSize: 9, fontWeight: 800, textTransform: "uppercase",
                            letterSpacing: "0.05em", color: "oklch(0.72 0.18 30)",
                          }}>✕</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {!currentEvent && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, textAlign: "center" }}>
          <CalendarDays size={40} style={{ color: MUTED, opacity: 0.3 }} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: FG, marginBottom: 6 }}>No Event Selected</div>
            <div style={{ fontSize: 13, color: MUTED }}>Set a current event in Settings to start scheduling.</div>
          </div>
        </div>
      )}

      {currentEvent && (
        <>
          {/* ── Tab bar ─────────────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 4, flexShrink: 0, background: SURFACE, borderRadius: 10, padding: 4, width: isMobile ? "100%" : "fit-content", border: `1px solid ${SURF_BORD}` }}>
            {([
              { id: "matches"     as TabType, label: "Match Assignments", icon: LayoutGrid    },
              { id: "pit"         as TabType, label: "Pit Rotations",     icon: Wrench        },
              { id: "pitScouting" as TabType, label: "Pit Scouting",      icon: ClipboardList },
            ]).map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setActiveTab(id)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  padding: "7px 14px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer",
                  background: activeTab === id ? G : "transparent",
                  color: activeTab === id ? G_TXT : MUTED,
                  border: "none", transition: "all 0.15s",
                  flex: isMobile ? 1 : "none",
                }}
              >
                <Icon size={14} />
                {!isMobile && label}
                {id === "pit" && (pitRotations?.length ?? 0) > 0 && (
                  <span style={{ background: "oklch(0 0 0 / 20%)", borderRadius: 20, padding: "0 6px", fontSize: 11, fontWeight: 700 }}>
                    {pitRotations!.length}
                  </span>
                )}
                {id === "pitScouting" && (pitScoutingTeams?.length ?? 0) > 0 && (
                  <span style={{ background: "oklch(0 0 0 / 20%)", borderRadius: 20, padding: "0 6px", fontSize: 11, fontWeight: 700 }}>
                    {pitScoutingTeams!.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* ── Match assignments tab ───────────────────────────────────── */}
          {activeTab === "matches" && (
            <div style={{ flex: 1, display: "flex", flexDirection: stackLayout ? "column" : "row", gap: isLandscapePhone ? 6 : 12, minHeight: 0 }}>
              {matchesLoading ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: MUTED }}>
                  <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
                  <span style={{ fontSize: 14 }}>Loading matches from TBA…</span>
                </div>
              ) : matchesError ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center" }}>
                  <AlertCircle size={28} style={{ color: MUTED, opacity: 0.5 }} />
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4, color: FG }}>Couldn't load matches</div>
                    <div style={{ fontSize: 12, color: MUTED }}>Check your TBA API key in Settings.</div>
                  </div>
                </div>
              ) : (
                <>
                  <ScoutSelector
                    users={allUsers ?? []}
                    pinnedId={pinnedScoutId}
                    onPin={setPinnedScoutId}
                    matchCounts={matchCounts}
                    matches={matches}
                    onBatchAssign={handleBatchAssign}
                    isMobile={isMobile}
                    isLandscapePhone={isLandscapePhone}
                  />
                  <MatchGrid
                    matches={matches}
                    assignMap={assignMap}
                    pinnedId={pinnedScoutId}
                    onCellClick={handleCellClick}
                    saving={savingCells}
                    isMobile={isMobile}
                    isLandscapePhone={isLandscapePhone}
                  />
                </>
              )}
            </div>
          )}

          {/* ── Pit rotations tab ───────────────────────────────────────── */}
          {activeTab === "pit" && (() => {
            const allRots   = pitRotations ?? [];
            const elimsRot  = allRots.find(r => r.isElims) ?? null;
            const qualRots  = allRots.filter(r => !r.isElims).sort((a, b) => (a.startMatch ?? 0) - (b.startMatch ?? 0));

            return (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>

                {/* Elims rotation — fixed single block at the top */}
                <ElimsRotationPanel
                  rotation={elimsRot}
                  users={pitUsers}
                  allUsers={allUsers}
                  onSave={async (scoutIds) => {
                    if (!currentEvent) return;
                    await upsertRotation({
                      id: elimsRot?._id as Id<"pitRotations"> | undefined,
                      eventKey: currentEvent.eventKey,
                      label: "Elims Pit Rotation",
                      isElims: true,
                      scoutIds: Array.from(scoutIds) as Id<"users">[],
                    });
                  }}
                  onDelete={async () => {
                    if (elimsRot) await deleteRotation({ id: elimsRot._id as Id<"pitRotations"> });
                  }}
                />

                {/* Divider */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, height: 1, background: SURF_BORD }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap" }}>
                    Qual Pit Rotations
                  </span>
                  <div style={{ flex: 1, height: 1, background: SURF_BORD }} />
                </div>

                {/* Opt-in note */}
                {pitHiddenCount > 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 12px", borderRadius: 9,
                    background: "oklch(0.65 0.18 270 / 8%)",
                    border: "1px solid oklch(0.65 0.18 270 / 25%)",
                    fontSize: 12, color: "oklch(0.7 0.15 270)",
                    flexShrink: 0,
                  }}>
                    <Wrench size={12} style={{ flexShrink: 0 }} />
                    <span>
                      Showing <strong>{pitUsers.length}</strong> scout{pitUsers.length !== 1 ? "s" : ""} who opted into pit rotations.
                      {" "}<strong>{pitHiddenCount}</strong> scout{pitHiddenCount !== 1 ? "s have" : " has"} not opted in and are hidden.
                    </span>
                  </div>
                )}

                {/* Qual rotation form (only when not editing) */}
                {!editingRotation && (
                  <RotationForm users={pitUsers} allUsers={allUsers} onSave={form => handleSaveRotation(form)} />
                )}

                {/* Qual rotation list */}
                <ScrollArea style={{ flex: 1 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 16 }}>
                    {qualRots.length === 0 && !editingRotation && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "24px 16px", textAlign: "center", color: MUTED }}>
                        <Wrench size={24} style={{ opacity: 0.3 }} />
                        <span style={{ fontSize: 13 }}>No qual rotations yet. Add one above.</span>
                      </div>
                    )}
                    {editingRotation && (
                      <RotationForm
                        users={pitUsers} allUsers={allUsers} isEdit
                        initial={{
                          label: editingRotation.label ?? "",
                          startMatch: String(editingRotation.startMatch ?? ""),
                          endMatch: String(editingRotation.endMatch ?? ""),
                          scoutIds: new Set(editingRotation.scoutIds),
                        }}
                        onSave={form => handleSaveRotation(form, editingRotation._id)}
                        onCancel={() => setEditingRotation(null)}
                      />
                    )}
                    {qualRots
                      .filter(r => r._id !== editingRotation?._id)
                      .map(r => (
                        <RotationCard
                          key={r._id} rotation={r} users={allUsers ?? []}
                          onEdit={() => setEditingRotation(r)}
                          onDelete={async () => { await deleteRotation({ id: r._id as Id<"pitRotations"> }); }}
                        />
                      ))}
                  </div>
                </ScrollArea>
              </div>
            );
          })()}
          {/* ── Pit scouting teams tab ──────────────────────────────────── */}
          {activeTab === "pitScouting" && (
            <PitScoutingTab
              tbaTeams={tbaTeams}
              tbaLoading={tbaTeamsLoading}
              tbaError={tbaTeamsError}
              assignments={pitAssignmentsMap}
              allUsers={allUsers ?? []}
              onToggleScout={handleTogglePitScout}
              onClearAll={async () => {
                if (!currentEvent) return;
                await clearAllPitScouting({ eventKey: currentEvent.eventKey });
              }}
              onAutoAssign={handleAutoAssignPitScouting}
              optedInCount={(allPreferences ?? []).filter((p: any) => p.wantsPitScouting === true).length}
              isMobile={isMobile}
            />
          )}
        </>
      )}
      </div>

      {autoGenResult && (
        <AutoGenerateModal
          result={autoGenResult}
          onConfirm={handleAutoApply}
          onCancel={() => { setAutoGenResult(null); setAutoGenError(null); }}
          applying={autoGenApplying}
          applyError={autoGenError}
        />
      )}
    </>
  );
}
