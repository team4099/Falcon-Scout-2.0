import { useState, useEffect, useMemo, useCallback, Fragment } from "react";
import { useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useAdminMutation } from "@/hooks/useAdminMutation";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useUIStore } from "@/store/uiStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchTBAEventMatches, fetchTBAEventTeams } from "@/lib/api";
import type { TBAMatch, TBATeam } from "@/lib/api";
import { lsGet, lsGetStale } from "@/lib/persistentCache";
import {
  Users, CalendarDays, Wrench, Loader2,
  AlertCircle, Plus, Trash2, Pencil, Check,
  Zap, LayoutGrid, Sparkles, TriangleAlert, ChevronDown as ChevDown,
  ClipboardList, Car, GripVertical, X, Heart,
} from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  generateSchedule,
  generatePitScoutingTeams,
  type SchedulerOutput,
  type Position as GenPosition,
  type ScoutPref as GenScoutPref,
} from "@/lib/scheduleGenerator";

// ── Types ─────────────────────────────────────────────────────────────────────

interface User {
  _id: string;
  name?: string;
  email?: string;
  image?: string;
  /** Set by users.listUsers: on the current event's roster (convex/roster.ts). */
  onRoster?: boolean;
  /** Set by users.listUsers for approved guests from other teams. */
  isGuest?: boolean;
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
  driveTeamScoutIds?: string[];
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

// Drive team red — the one place this page departs from gold/black, so a
// rotation's drivers are findable at a glance in a wall of gold chips.
const R     = "oklch(0.62 0.23 25)";        // drive team red
const R_DIM = "oklch(0.62 0.23 25 / 12%)";  // red tint bg
const R_MED = "oklch(0.62 0.23 25 / 32%)";  // red border / mid
const R_STR = "oklch(0.62 0.23 25 / 55%)";  // red strong border
const R_TXT = "oklch(0.99 0 0)";            // text on red

const SURFACE   = "oklch(1 0 0 / 3%)";       // card surface
const SURF_BORD = "oklch(1 0 0 / 8%)";       // card border
const SURF_HVR  = "oklch(1 0 0 / 6%)";       // hover surface
const MUTED     = "var(--muted-foreground)";

/** Scouts rotate in blocks of this many matches. */
const SCOUT_CYCLE = 5;
const FG        = "var(--foreground)";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The server refuses match assignments inside a scout's pit rotation; show why. */
function warnAssignRefused(e: unknown) {
  if (e instanceof ConvexError && typeof e.data === "string") window.alert(`⚠ Not assigned\n\n${e.data}`);
  else throw e;
}

function displayName(u: User) { return u.name ?? u.email ?? "?"; }
function avatarLetter(u: User) { return displayName(u).charAt(0).toUpperCase(); }

/** Tiny "G" marker shown next to a guest's name. */
function GuestTag() {
  return (
    <span title="Guest" style={{
      flexShrink: 0, marginLeft: 3, padding: "0 3px", borderRadius: 4, fontSize: 8, lineHeight: "12px",
      fontWeight: 800, verticalAlign: "middle", background: "oklch(0.7 0.15 200 / 18%)",
      color: "oklch(0.78 0.13 200)", border: "1px solid oklch(0.7 0.15 200 / 35%)",
    }}>G</span>
  );
}

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

/** Build stand-in qual matches 1..count for an event TBA hasn't scheduled yet.
 *
 *  TBA typically posts the qual schedule only hours before the event starts,
 *  which left this grid empty and un-assignable until then. These placeholders
 *  carry no alliance or timing data — the grid never renders any — so the only
 *  fields that matter are comp_level and match_number. Their labels are what
 *  tbaMatchLabel() would produce for the real match ("Q17"), so an assignment
 *  saved against a placeholder is indistinguishable from one saved after TBA
 *  publishes: the real matches simply replace these and the saved rows line up
 *  by match number.
 */
function synthesizeQualMatches(eventKey: string, count: number): TBAMatch[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `${eventKey}_planned_qm${i + 1}`,
    comp_level: "qm" as const,
    set_number: 1,
    match_number: i + 1,
    time: null,
    predicted_time: null,
    actual_time: null,
    winning_alliance: "" as const,
    alliances: {
      red:  { team_keys: [], score: -1 },
      blue: { team_keys: [], score: -1 },
    },
  }));
}

// ── Avatar ────────────────────────────────────────────────────────────────────

function Avatar({ user, size = 36 }: { user: User; size?: number }) {
  if (user.image) {
    return (
      <img src={user.image} alt={displayName(user)}
        referrerPolicy="no-referrer"
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

// ── Scout selector panel ──────────────────────────────────────────────────────

type PrefMap = Map<string, { wantsMoreMatches?: boolean; wantsPitScouting?: boolean; preferredPartners?: string[] }>;

/** Scouts the pinned scout listed as preferred partners (empty if none pinned). */
function partnerSet(prefs: PrefMap | undefined, pinnedId: string | null): Set<string> {
  return new Set(pinnedId ? prefs?.get(pinnedId)?.preferredPartners ?? [] : []);
}

const PARTNER_BORD = "oklch(0.78 0.16 75)";
const PARTNER_BG   = "oklch(0.78 0.16 75 / 14%)";

/** Marks a scout the pinned scout asked to work with. */
function PartnerMark({ size = 10 }: { size?: number }) {
  return (
    <span title="Preferred partner of the selected scout" style={{ display: "inline-flex", flexShrink: 0 }}>
      <Heart size={size} fill={PARTNER_BORD} style={{ color: PARTNER_BORD }} />
    </span>
  );
}

interface ScoutSelectorProps {
  users: User[];
  prefsByScout?: PrefMap;
  pinnedId: string | null;
  onPin: (id: string | null) => void;
  matchCounts: Record<string, number>;
  matches: TBAMatch[];
  onBatchAssign: (start: number, end: number, positions: Set<Position>) => Promise<void>;
  isLandscapePhone?: boolean;
  /** True only when the parent is actually stacking panels in a column (narrow
   *  AND portrait). A narrow-but-landscape window — e.g. a half-screened
   *  laptop — keeps the parent in row layout, so this panel must NOT switch
   *  to its "width: 100%" mobile styling there or it swallows the whole row
   *  and squeezes the match grid down to nothing. */
  stackLayout?: boolean;
  readOnly?: boolean;
}

/** Small inline icon marking a scout's preference relevant to the current tab:
 *  "wants more matches" on the match tab, "wants pit scouting" on the pit-scouting tab. */
function PrefBadges({ prefs, kind, dim }: { prefs?: { wantsMoreMatches?: boolean; wantsPitScouting?: boolean }; kind: "matches" | "pit"; dim?: string }) {
  const on = kind === "matches" ? prefs?.wantsMoreMatches : prefs?.wantsPitScouting;
  if (!on) return null;
  const Icon = kind === "matches" ? Zap : Wrench;
  return (
    <span title={kind === "matches" ? "Wants more matches" : "Wants pit scouting"} style={{ display: "inline-flex", flexShrink: 0 }}>
      <Icon size={10} style={{ color: dim ?? G }} />
    </span>
  );
}

function ScoutSelector({ users, prefsByScout, pinnedId, onPin, matchCounts, matches, onBatchAssign, isLandscapePhone, stackLayout, readOnly }: ScoutSelectorProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // In landscape phone mode the panel is always open (side-by-side, never collapsed)
  const bodyVisible = isLandscapePhone ? true : (!stackLayout || mobileOpen);
  const [batchStart, setBatchStart] = useState("");
  const [batchEnd, setBatchEnd]     = useState("");
  const [batchPos, setBatchPos]     = useState<Set<Position>>(new Set());
  const [batchBusy, setBatchBusy]   = useState(false);

  const pinned = users.find(u => u._id === pinnedId) ?? null;
  const partners = partnerSet(prefsByScout, pinnedId);

  function togglePos(p: Position) {
    setBatchPos(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
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
      width: isLandscapePhone ? 130 : stackLayout ? "100%" : 248,
      flexShrink: 0, display: "flex", flexDirection: "column",
      minHeight: 0, borderRadius: 14, border: `1px solid ${SURF_BORD}`,
      background: SURFACE, overflow: "hidden",
      maxHeight: stackLayout && !mobileOpen ? 52 : undefined,
      transition: "max-height 0.25s ease",
    }}>
      {/* Header — tappable toggle on portrait-mobile only */}
      <div
        style={{
          padding: isLandscapePhone ? "8px 10px" : "11px 14px",
          borderBottom: bodyVisible ? `1px solid ${SURF_BORD}` : "none",
          background: G_DIM, flexShrink: 0,
          cursor: stackLayout ? "pointer" : "default",
        }}
        onClick={stackLayout ? () => setMobileOpen(o => !o) : undefined}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Users size={13} style={{ color: G }} />
          {!isLandscapePhone && (
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: G }}>
              {stackLayout && pinnedId
                ? `Scout: ${pinned ? displayName(pinned) : "?"}`
                : "Pin a Scout"}
            </span>
          )}
          <span style={{ marginLeft: isLandscapePhone ? 0 : "auto", background: G_MED, color: G, borderRadius: 20, padding: "1px 8px", fontSize: 11, fontWeight: 700 }}>
            {isLandscapePhone
              ? users.length
              : stackLayout ? (mobileOpen ? "Close ▲" : `${users.length} scouts ▼`) : users.length}
          </span>
        </div>
        {!stackLayout && !isLandscapePhone && (
          <p style={{ fontSize: 11, color: MUTED, margin: "4px 0 0", lineHeight: 1.3 }}>
            {readOnly ? "Select a scout to highlight their matches." : "Select a scout, then click grid cells to assign."}
          </p>
        )}
        {!stackLayout && !isLandscapePhone && (
          <p style={{ fontSize: 10, color: MUTED, margin: "5px 0 0", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Zap size={10} style={{ color: G }} />wants more matches</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Heart size={10} fill={PARTNER_BORD} style={{ color: PARTNER_BORD }} />their picks</span>
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
                const pref = !active && partners.has(u._id);
                return (
                  <button key={u._id} onClick={() => onPin(active ? null : u._id)}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 6,
                      padding: "5px 6px", borderRadius: 8, cursor: "pointer",
                      background: active ? G_DIM : pref ? PARTNER_BG : "transparent",
                      border: `1.5px solid ${active ? G_STR : pref ? PARTNER_BORD : "transparent"}`,
                      outline: "none", transition: "all 0.1s",
                    }}
                    onMouseEnter={e => { if (!active && !pref) e.currentTarget.style.background = SURF_HVR; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = pref ? PARTNER_BG : "transparent"; }}
                  >
                    <Avatar user={u} size={22} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: active ? G : FG, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                      {displayName(u)}{u.isGuest && <GuestTag />}
                    </span>
                    {pref && <PartnerMark />}
                    <PrefBadges prefs={prefsByScout?.get(u._id)} kind="matches" />
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
        ) : stackLayout ? (
          /* Portrait phone: horizontal scrolling carousel */
          <div style={{ overflowX: "auto", overflowY: "hidden", display: "flex", gap: 6, padding: "8px 10px", flexShrink: 0 }}>
            {users.length === 0 && (
              <div style={{ padding: "12px", color: MUTED, fontSize: 13, whiteSpace: "nowrap" }}>No scouts yet</div>
            )}
            {users.map(u => {
              const active = pinnedId === u._id;
              const cnt = matchCounts[u._id] ?? 0;
              const pref = !active && partners.has(u._id);
              return (
                <button key={u._id} onClick={() => { onPin(active ? null : u._id); setMobileOpen(false); }}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    padding: "8px 10px", borderRadius: 12, cursor: "pointer", flexShrink: 0,
                    background: active ? G_DIM : pref ? PARTNER_BG : SURF_HVR,
                    border: `1.5px solid ${active ? G_STR : pref ? PARTNER_BORD : SURF_BORD}`,
                    outline: "none", transition: "all 0.12s", minWidth: 58, maxWidth: 104,
                  }}
                >
                  <Avatar user={u} size={32} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: active ? G : FG, whiteSpace: "nowrap", maxWidth: 92, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {displayName(u)}{u.isGuest && <GuestTag />}
                  </span>
                  {pref && <PartnerMark />}
                  <PrefBadges prefs={prefsByScout?.get(u._id)} kind="matches" />
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
                const pref = !active && partners.has(u._id);
                return (
                  <button key={u._id} onClick={() => onPin(active ? null : u._id)}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 9,
                      padding: "8px 9px", borderRadius: 10, cursor: "pointer", textAlign: "left",
                      background: active ? G_DIM : pref ? PARTNER_BG : "transparent",
                      border: `1.5px solid ${active ? G_STR : pref ? PARTNER_BORD : "transparent"}`,
                      outline: "none", transition: "all 0.12s",
                    }}
                    onMouseEnter={e => { if (!active && !pref) e.currentTarget.style.background = SURF_HVR; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = pref ? PARTNER_BG : "transparent"; }}
                  >
                    <Avatar user={u} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: FG, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 6 }}>
                        {displayName(u)}{u.isGuest && <GuestTag />}
                        {pref && <PartnerMark />}
                        <PrefBadges prefs={prefsByScout?.get(u._id)} kind="matches" />
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

      {/* Batch assign — desktop only, admin editing only */}
      {pinned && bodyVisible && !stackLayout && !isLandscapePhone && !readOnly && (
        <div style={{ borderTop: `1px solid ${G_MED}`, padding: "12px 12px 14px", background: G_DIM, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}>
            <Zap size={13} style={{ color: G }} />
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: G }}>
              Batch Assign — {displayName(pinned)}
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
  assignMap: Record<number, Partial<Record<Position, { scoutId: string; name: string; guest?: boolean }>>>;
  pinnedId: string | null;
  onCellClick: (matchNum: number, matchLbl: string, pos: Position) => void;
  onCycleClick: (cycleMatches: TBAMatch[], pos: Position) => void;
  saving: Set<string>;
  isMobile?: boolean;
  isLandscapePhone?: boolean;
  stackLayout?: boolean;
  readOnly?: boolean;
}

/** A qual-match grid row is either a single match (playoffs), or a merged
 *  block of up to 5 consecutive quals covering a scouting cycle — so
 *  admins assign a cycle in one tap instead of once per match within it. */
type GridRow =
  | { type: "single"; match: TBAMatch }
  | { type: "cycle"; matches: TBAMatch[]; cycleNumber: number };

function buildGridRows(matches: TBAMatch[]): GridRow[] {
  const rows: GridRow[] = [];
  let cycleNumber = 0;
  for (let i = 0; i < matches.length; ) {
    // Take up to 5 consecutive quals; a shorter run (leftovers at the end of
    // quals) still forms a single cycle rather than one row per match.
    let end = i;
    while (end < matches.length && end - i < SCOUT_CYCLE && matches[end].comp_level === "qm") end++;
    if (end > i) {
      cycleNumber += 1;
      rows.push({ type: "cycle", matches: matches.slice(i, end), cycleNumber });
      i = end;
    } else {
      rows.push({ type: "single", match: matches[i] });
      i += 1;
    }
  }
  return rows;
}

function MatchGrid({ matches, assignMap, pinnedId, onCellClick, onCycleClick, saving, isMobile, isLandscapePhone, stackLayout, readOnly }: MatchGridProps) {
  const [expandedMatchKey, setExpandedMatchKey] = useState<string | null>(null);
  const canExpand = !!(stackLayout && !readOnly);
  const gridRows = useMemo(() => buildGridRows(matches), [matches]);
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
  // Label column must fit the widest range label a cycle row can show
  // ("Q76–Q80", 8 chars) at this font size — 36/44px was too narrow and let
  // the label spill into the first scout-name cell instead of wrapping.
  const COL = isLandscapePhone
    ? "54px 1fr 1fr 1fr 2px 1fr 1fr 1fr"
    : isMobile
    ? "50px 1fr 1fr 1fr 2px 1fr 1fr 1fr"
    : "58px 1fr 1fr 1fr 3px 1fr 1fr 1fr";

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
          {gridRows.map((row) => row.type === "cycle" ? (
            <CycleRow
              key={`cycle-${row.matches[0].key}`}
              cycleMatches={row.matches}
              cycleNumber={row.cycleNumber}
              assignMap={assignMap}
              pinnedId={pinnedId}
              onCycleClick={onCycleClick}
              saving={saving}
              readOnly={readOnly}
              COL={COL}
              cellPad={cellPad}
              cellMinH={cellMinH}
              cellFontSize={cellFontSize}
              isLandscapePhone={isLandscapePhone}
            />
          ) : (
          <SingleMatchRow
            key={row.match.key}
            m={row.match}
            lbl={tbaMatchLabel(row.match)}
            row={assignMap[row.match.match_number] ?? {}}
            pinnedId={pinnedId}
            onCellClick={onCellClick}
            saving={saving}
            readOnly={readOnly}
            canExpand={canExpand}
            isExpanded={canExpand && expandedMatchKey === row.match.key}
            onToggleExpand={() => setExpandedMatchKey(k => k === row.match.key ? null : row.match.key)}
            onCloseExpand={() => setExpandedMatchKey(null)}
            COL={COL}
            cellPad={cellPad}
            cellMinH={cellMinH}
            cellFontSize={cellFontSize}
            isLandscapePhone={isLandscapePhone}
          />
          ))}
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
          {readOnly
            ? "View only — enable admin mode to edit assignments"
            : pinnedId ? "Click a cell to assign · click same scout again to unassign" : "← Pin a scout to start assigning"}
        </span>
      </div>
      )}
    </div>
  );
}

// ── Match plan panel ──────────────────────────────────────────────────────────
// Shown above the grid whenever TBA has no qual schedule for the event. Lets an
// admin enter how many quals the competition runs so the grid can be built and
// assigned against plain match numbers ahead of TBA posting anything.

interface MatchPlanPanelProps {
  plannedCount: number;
  readOnly: boolean;
  onSave: (count: number) => Promise<void>;
}

function MatchPlanPanel({ plannedCount, readOnly, onSave }: MatchPlanPanelProps) {
  const [draft, setDraft]   = useState(plannedCount > 0 ? String(plannedCount) : "");
  const [editing, setEditing] = useState(plannedCount === 0);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  // A count set from another device (or another admin) should land here rather
  // than leaving this input showing a stale number.
  useEffect(() => {
    setDraft(plannedCount > 0 ? String(plannedCount) : "");
    setEditing(plannedCount === 0);
  }, [plannedCount]);

  const parsed = parseInt(draft, 10);
  const valid  = Number.isInteger(parsed) && parsed > 0 && parsed <= 400;

  async function save(count: number) {
    setSaving(true); setError(null);
    try {
      await onSave(count);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save match count");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      flexShrink: 0, padding: "10px 14px", borderRadius: 10,
      background: G_DIM, border: `1.5px solid ${G_MED}`,
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
    }}>
      <AlertCircle size={17} style={{ color: G, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: FG }}>
          {plannedCount > 0
            ? `Planning ${plannedCount} qual matches`
            : "TBA hasn't posted this event's schedule yet"}
        </div>
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>
          {plannedCount > 0
            ? "Assignments save against match numbers and carry over automatically once TBA publishes."
            : readOnly
              ? "An admin can enter the qual match count to start assigning now."
              : "Enter how many qual matches the competition runs to start assigning now."}
        </div>
        {error && (
          <div style={{ fontSize: 11.5, color: "var(--destructive)", marginTop: 4 }}>{error}</div>
        )}
      </div>

      {!readOnly && (editing ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <input
            type="number" min={1} max={400} value={draft} autoFocus
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && valid && !saving) void save(parsed); }}
            placeholder="e.g. 78"
            style={{
              width: 92, padding: "7px 10px", borderRadius: 8, fontSize: 13, fontWeight: 700,
              background: SURFACE, border: `1.5px solid ${SURF_BORD}`, color: FG, outline: "none",
            }}
          />
          <button
            onClick={() => { if (valid) void save(parsed); }}
            disabled={!valid || saving}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "7px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700,
              background: G, color: G_TXT, border: "none",
              cursor: !valid || saving ? "not-allowed" : "pointer",
              opacity: !valid || saving ? 0.5 : 1,
            }}
          >
            {saving
              ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />Saving…</>
              : <><Check size={13} />Build grid</>}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button
            onClick={() => setEditing(true)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "7px 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 700,
              background: SURFACE, color: FG, border: `1.5px solid ${SURF_BORD}`, cursor: "pointer",
            }}
          >
            <Pencil size={12} />Change count
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Orphaned-assignment warning ───────────────────────────────────────────────
// TBA published fewer quals than were planned for, so these assignments point at
// matches that will never be played. Deleting them is destructive and always the
// admin's call — it's real planning work — so this only offers the button.

function OrphanWarning({
  count, maxMatchNumber, readOnly, onClear,
}: { count: number; maxMatchNumber: number; readOnly: boolean; onClear: () => Promise<void> }) {
  const [clearing, setClearing] = useState(false);

  return (
    <div style={{
      flexShrink: 0, padding: "10px 14px", borderRadius: 10,
      background: "oklch(0.577 0.245 27 / 10%)",
      border: "1.5px solid oklch(0.577 0.245 27 / 32%)",
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
    }}>
      <TriangleAlert size={17} style={{ color: "var(--destructive)", flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: FG }}>
          {count} assignment{count === 1 ? "" : "s"} past the real schedule
        </div>
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>
          TBA's schedule ends at Q{maxMatchNumber}. These were planned for later matches that don't exist, so they no longer appear on the grid.
        </div>
      </div>
      {!readOnly && (
        <button
          onClick={async () => { setClearing(true); try { await onClear(); } finally { setClearing(false); } }}
          disabled={clearing}
          style={{
            display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
            padding: "7px 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 700,
            background: "oklch(0.577 0.245 27 / 14%)", color: "var(--destructive)",
            border: "1.5px solid oklch(0.577 0.245 27 / 38%)",
            cursor: clearing ? "wait" : "pointer", opacity: clearing ? 0.6 : 1,
          }}
        >
          {clearing
            ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />Clearing…</>
            : <><Trash2 size={13} />Clear them</>}
        </button>
      )}
    </div>
  );
}

// ── Single-match grid row (used for individual matches — playoffs and any
// leftover quals that don't fill a full 5-match cycle) ─────────────────────

interface SingleMatchRowProps {
  m: TBAMatch;
  lbl: string;
  row: Partial<Record<Position, { scoutId: string; name: string; guest?: boolean }>>;
  pinnedId: string | null;
  onCellClick: (matchNum: number, matchLbl: string, pos: Position) => void;
  saving: Set<string>;
  readOnly?: boolean;
  canExpand: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onCloseExpand: () => void;
  COL: string;
  cellPad: string;
  cellMinH: number;
  cellFontSize: number;
  isLandscapePhone?: boolean;
}

function SingleMatchRow({
  m, lbl, row, pinnedId, onCellClick, saving, readOnly,
  canExpand, isExpanded, onToggleExpand, onCloseExpand,
  COL, cellPad, cellMinH, cellFontSize, isLandscapePhone,
}: SingleMatchRowProps) {
  const isQual = m.comp_level === "qm";
  const redPositions: Position[]  = ["red1",  "red2",  "red3"];
  const bluePositions: Position[] = ["blue1", "blue2", "blue3"];

  return (
    <Fragment>
      {/* Divider bar — leftover quals that don't fill a full cycle (e.g. the
       *  last 1-4 matches of an event) still get the same separator CycleRow
       *  draws, so the grid's rhythm doesn't just stop once cycles run out. */}
      {isQual && (
        <div aria-hidden style={{ margin: "5px 0 3px" }}>
          <div style={{ height: 2, borderRadius: 2, background: G_MED }} />
        </div>
      )}
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
                      onClick={onToggleExpand}
                      style={{
                        padding: "3px 4px", fontSize: 12, fontWeight: 700,
                        fontFamily: "monospace", letterSpacing: "-0.01em",
                        color: isQual ? FG : G,
                        background: isExpanded ? G_MED : "transparent",
                        border: "none", borderRadius: 5, cursor: "pointer",
                        textAlign: "left", transition: "background 0.1s",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
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
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
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

                    // Keyed on the Fragment, not its children: a shorthand <>
                    // fragment cannot carry a key, so React saw this list as
                    // unkeyed and could reuse the wrong cell's DOM (and its
                    // isSaving state) when rows re-ordered.
                    return (
                      <Fragment key={p}>
                        {i === 3 && (
                          <div style={{ width: "3px", alignSelf: "stretch", background: "oklch(1 0 0/5%)", margin: "2px 0" }} />
                        )}
                        <button
                          onClick={readOnly ? undefined : () => onCellClick(m.match_number, lbl, p)}
                          disabled={isSaving || readOnly}
                          title={
                            assigned
                              ? `${assigned.name} (${POS_META[p].short})${readOnly ? "" : ` — click to ${isPinned ? "unassign" : "replace"}`}`
                              : readOnly ? "Unassigned" : pinnedId ? `Assign to ${POS_META[p].label}` : "Pin a scout first"
                          }
                          style={{
                            margin: isLandscapePhone ? "1px" : "2px",
                            padding: cellPad, borderRadius: 6,
                            cursor: pinnedId && !readOnly ? "pointer" : "default",
                            background: cellBg, border: cellBorder,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: cellFontSize, fontWeight: 700, color: textColor,
                            transition: "all 0.1s", minHeight: cellMinH, minWidth: 0, overflow: "hidden",
                            opacity: isSaving ? 0.5 : 1,
                          }}
                          onMouseEnter={e => {
                            if (pinnedId && !isSaving && !readOnly) {
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
                              ? (pinnedId && !readOnly ? <span style={{ opacity: 0.25, fontSize: 14, fontWeight: 300 }}>+</span> : null)
                              : <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%", padding: "0 2px" }}>
                                  {assigned.name}{assigned.guest && <GuestTag />}
                                </span>
                          }
                        </button>
                      </Fragment>
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
                        onClick={onCloseExpand}
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
                                {a ? <>{a.name}{a.guest && <GuestTag />}</> : <span style={{ opacity: 0.35, fontSize: 11 }}>Unassigned</span>}
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
                                {a ? <>{a.name}{a.guest && <GuestTag />}</> : <span style={{ opacity: 0.35, fontSize: 11 }}>Unassigned</span>}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {pinnedId && !readOnly && (
                      <div style={{ padding: "7px 14px", borderTop: `1px solid ${SURF_BORD}`, background: G_DIM, fontSize: 11, color: MUTED, textAlign: "center" }}>
                        Tap a cell above to assign / unassign
                      </div>
                    )}
                  </div>
                )}
    </Fragment>
  );
}

// ── Cycle grid row — merges a 5-match block into one row so an admin taps
// once per position to cover the whole cycle instead of once per match ─────

interface CycleRowProps {
  cycleMatches: TBAMatch[];
  cycleNumber: number;
  assignMap: Record<number, Partial<Record<Position, { scoutId: string; name: string; guest?: boolean }>>>;
  pinnedId: string | null;
  onCycleClick: (cycleMatches: TBAMatch[], pos: Position) => void;
  saving: Set<string>;
  readOnly?: boolean;
  COL: string;
  cellPad: string;
  cellMinH: number;
  cellFontSize: number;
  isLandscapePhone?: boolean;
}

function CycleRow({
  cycleMatches, assignMap, pinnedId, onCycleClick, saving, readOnly,
  COL, cellPad, cellMinH, cellFontSize, isLandscapePhone,
}: CycleRowProps) {
  const first = cycleMatches[0];
  const last = cycleMatches[cycleMatches.length - 1];
  const rangeLbl = `${tbaMatchLabel(first)}–${tbaMatchLabel(last)}`;
  const cycleKey = `cycle-${first.match_number}`;

  return (
    <Fragment>
      <div
        aria-hidden
        style={{ margin: "5px 0 3px" }}
      >
        <div style={{ height: 2, borderRadius: 2, background: G_MED }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: COL, gap: 0, alignItems: "center", borderRadius: 8 }}>
        <div style={{
          padding: isLandscapePhone ? "2px 3px" : "3px 4px",
          fontSize: isLandscapePhone ? 9 : 11, fontWeight: 700,
          fontFamily: "monospace", letterSpacing: "-0.02em", color: FG, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis", minWidth: 0,
        }}>
          {rangeLbl}
        </div>

        {POSITIONS.map((p, i) => {
          const savingKey = `${cycleKey}-${p}`;
          const isSaving = saving.has(savingKey);
          const slots = cycleMatches.map(m => assignMap[m.match_number]?.[p]);
          const allAssigned = slots.every(s => s != null);
          const uniformScoutId = allAssigned && slots.every(s => s!.scoutId === slots[0]!.scoutId)
            ? slots[0]!.scoutId
            : null;
          const isPinned = uniformScoutId != null && uniformScoutId === pinnedId;
          const isMixed = !allAssigned && slots.some(s => s != null);

          let cellBg     = "transparent";
          let cellBorder = `1.5px solid transparent`;
          let textColor  = MUTED;

          if (uniformScoutId) {
            if (isPinned) { cellBg = G_DIM; cellBorder = `1.5px solid ${G_STR}`; textColor = G; }
            else { cellBg = SURF_HVR; cellBorder = `1.5px solid ${SURF_BORD}`; textColor = FG; }
          } else if (isMixed) {
            cellBorder = `1.5px dashed ${SURF_BORD}`;
          } else if (pinnedId) {
            cellBorder = `1.5px dashed ${SURF_BORD}`;
          }

          return (
            <Fragment key={p}>
              {i === 3 && (
                <div style={{ width: "3px", alignSelf: "stretch", background: "oklch(1 0 0/5%)", margin: "2px 0" }} />
              )}
              <button
                onClick={readOnly ? undefined : () => onCycleClick(cycleMatches, p)}
                disabled={isSaving || readOnly}
                title={
                  readOnly
                    ? (uniformScoutId ? slots[0]!.name : isMixed ? "Mixed assignment across this cycle" : "Unassigned")
                    : uniformScoutId
                      ? `${slots[0]!.name} (${POS_META[p].short}) for the whole cycle — click to ${isPinned ? "unassign" : "replace"}`
                      : isMixed
                        ? "Mixed within this cycle — click to overwrite with the pinned scout"
                        : pinnedId ? `Assign whole cycle to ${POS_META[p].label}` : "Pin a scout first"
                }
                style={{
                  margin: isLandscapePhone ? "1px" : "2px",
                  padding: cellPad, borderRadius: 6,
                  cursor: pinnedId && !readOnly ? "pointer" : "default",
                  background: cellBg, border: cellBorder,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: cellFontSize, fontWeight: 700, color: textColor,
                  transition: "all 0.1s", minHeight: cellMinH, minWidth: 0, overflow: "hidden",
                  opacity: isSaving ? 0.5 : 1,
                }}
                onMouseEnter={e => {
                  if (pinnedId && !isSaving && !readOnly) {
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
                  : uniformScoutId
                    ? <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%", padding: "0 2px" }}>
                        {slots[0]!.name}{slots[0]!.guest && <GuestTag />}
                      </span>
                    : isMixed
                      ? <span style={{ fontSize: cellFontSize - 1, opacity: 0.6 }}>···</span>
                      : (pinnedId && !readOnly ? <span style={{ opacity: 0.25, fontSize: 14, fontWeight: 300 }}>+</span> : null)
                }
              </button>
            </Fragment>
          );
        })}
      </div>
    </Fragment>
  );
}

// ── Pit rotation scout picker pieces ─────────────────────────────────────────

/** A scout toggle in the pick-lists below the roster — membership only.
 *  Drive team flagging and ordering live on the roster strip instead. */
function PitScoutChip({ user, selected, onToggle }: {
  user: User;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button onClick={onToggle}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
        background: selected ? G : SURF_HVR,
        color: selected ? G_TXT : MUTED,
        border: `1.5px solid ${selected ? G_STR : SURF_BORD}`,
        transition: "all 0.1s",
      }}
    >
      {selected && <Check size={11} />}
      {displayName(user)}{user.isGuest && <GuestTag />}
    </button>
  );
}

/** One draggable scout on the rotation roster: grip to reorder, car to flag
 *  drive team (red), ✕ to drop them from the rotation. */
function RosterChip({ user, driveTeam, onToggleDriveTeam, onRemove }: {
  user: User;
  driveTeam: boolean;
  onToggleDriveTeam: () => void;
  onRemove: () => void;
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef,
    transform, transition, isDragging,
  } = useSortable({ id: user._id });

  return (
    <span
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 50 : undefined,
        display: "inline-flex", alignItems: "center", borderRadius: 20, overflow: "hidden",
        background: driveTeam ? R : G,
        border: `1.5px solid ${driveTeam ? R_STR : G_STR}`,
      }}
    >
      <button
        ref={setActivatorNodeRef} {...attributes} {...listeners}
        title={`Drag to reorder ${displayName(user)}`}
        aria-label={`Drag to reorder ${displayName(user)}`}
        style={{
          display: "inline-flex", alignItems: "center", alignSelf: "stretch",
          padding: "0 1px 0 6px", background: "transparent", border: "none",
          cursor: "grab", touchAction: "none",
          color: driveTeam ? R_TXT : G_TXT, opacity: 0.55,
        }}
      >
        <GripVertical size={12} />
      </button>

      <span style={{
        padding: "5px 4px", fontSize: 12, fontWeight: 700,
        color: driveTeam ? R_TXT : G_TXT, whiteSpace: "nowrap",
      }}>
        {displayName(user)}{user.isGuest && <GuestTag />}
      </span>

      <button onClick={onToggleDriveTeam}
        title={driveTeam
          ? `${displayName(user)} is drive team for this rotation — click to unflag`
          : `Flag ${displayName(user)} as drive team for this rotation`}
        style={{
          display: "inline-flex", alignItems: "center", alignSelf: "stretch",
          padding: "0 5px", background: "transparent", border: "none", cursor: "pointer",
          color: driveTeam ? R_TXT : G_TXT, opacity: driveTeam ? 1 : 0.4,
        }}
      >
        <Car size={12} />
      </button>

      <button onClick={onRemove}
        title={`Remove ${displayName(user)} from this rotation`}
        style={{
          display: "inline-flex", alignItems: "center", alignSelf: "stretch",
          padding: "0 8px 0 3px", background: "transparent", border: "none", cursor: "pointer",
          color: driveTeam ? R_TXT : G_TXT, opacity: 0.5,
        }}
      >
        <X size={11} />
      </button>
    </span>
  );
}

/** The ordered roster for a rotation. Order is the stored scoutIds order —
 *  flagging someone drive team moves them to the front as a starting point,
 *  but nothing is pinned there: drag anyone anywhere afterwards. */
function RosterStrip({ scoutIds, driveTeamIds, userMap, onReorder, onToggleDriveTeam, onRemove }: {
  scoutIds: string[];
  driveTeamIds: Set<string>;
  userMap: Record<string, User>;
  onReorder: (from: number, to: number) => void;
  onToggleDriveTeam: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  // A few px of movement before a drag starts, so the car / ✕ / grip still
  // register as ordinary clicks.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  if (scoutIds.length === 0) return null;

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = scoutIds.indexOf(String(active.id));
    const to   = scoutIds.indexOf(String(over.id));
    if (from !== -1 && to !== -1) onReorder(from, to);
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>
        Roster order — drag to arrange
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={scoutIds} strategy={rectSortingStrategy}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {scoutIds.map(id => {
              const u = userMap[id] ?? { _id: id };
              return (
                <RosterChip
                  key={id} user={u}
                  driveTeam={driveTeamIds.has(id)}
                  onToggleDriveTeam={() => onToggleDriveTeam(id)}
                  onRemove={() => onRemove(id)}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
      <div style={{ fontSize: 10.5, color: MUTED, marginTop: 6, display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Car size={11} style={{ color: R }} />Tap the car to mark someone drive team — they turn red and jump to the front.
      </div>
    </div>
  );
}

/** Scouts who aren't on pit duty by choice, split by whether they answered the
 *  preferences form at all: an explicit "no" is a different conversation from
 *  someone who simply never filled it out, so staffing a short rotation needs
 *  to tell them apart. Both groups can still be added by hand. */
function OtherScoutsDisclosure({ optedOut, noResponse, renderChip }: {
  optedOut: User[];
  noResponse: User[];
  renderChip: (u: User) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const total = optedOut.length + noResponse.length;
  if (total === 0) return null;

  const groups = [
    { key: "out",  label: `Opted out — said no (${optedOut.length})`,        users: optedOut },
    { key: "none", label: `No response — never answered (${noResponse.length})`, users: noResponse },
  ].filter(g => g.users.length > 0);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          fontSize: 11, fontWeight: 700, color: MUTED,
          background: "transparent", border: "none", cursor: "pointer", padding: "2px 0",
          textTransform: "uppercase", letterSpacing: "0.06em",
        }}
      >
        <ChevDown size={12} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
        {open ? "Hide" : "Add others"} ({total} not opted in)
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
          {groups.map(g => (
            <div key={g.key}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                {g.label}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {g.users.map(u => renderChip(u))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Qual pit rotation card ────────────────────────────────────────────────────

function RotationCard({ rotation, users, onEdit, onDelete, readOnly }: {
  rotation: PitRotation; users: User[]; onEdit: () => void; onDelete: () => Promise<void>; readOnly?: boolean;
}) {
  const [deleting, setDeleting] = useState(false);
  const userMap = useMemo(() => Object.fromEntries(users.map(u => [u._id, u])), [users]);
  const driveSet = useMemo(() => new Set(rotation.driveTeamScoutIds ?? []), [rotation.driveTeamScoutIds]);
  const span = rotation.startMatch != null && rotation.endMatch != null
    ? rotation.endMatch - rotation.startMatch + 1 : null;

  const iconBtn: React.CSSProperties = {
    width: 28, height: 28, borderRadius: 7, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  };

  // Two rows so the chips get the full card width on a phone: header (range,
  // match count, actions) on top, one-line name chips wrapping below. The
  // optional label is only a tooltip — Q-range + count is what scouts scan for.
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px",
      borderRadius: 12, border: `1px solid ${SURF_BORD}`, background: SURFACE,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div title={rotation.label || undefined} style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "4px 10px", borderRadius: 8, flexShrink: 0,
          background: G_DIM, border: `1px solid ${G_MED}`,
        }}>
          <Wrench size={11} style={{ color: G }} />
          <span style={{ fontSize: 13, fontWeight: 800, color: G, fontFamily: "monospace" }}>
            Q{rotation.startMatch}–Q{rotation.endMatch}
          </span>
        </div>
        {span != null && (
          <span style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>{span} match{span !== 1 ? "es" : ""}</span>
        )}
        <span style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>· {rotation.scoutIds.length} scout{rotation.scoutIds.length !== 1 ? "s" : ""}</span>

        {!readOnly && (
          <div style={{ display: "flex", gap: 5, flexShrink: 0, marginLeft: "auto" }}>
            <button onClick={onEdit} aria-label="Edit rotation" style={{
              ...iconBtn, border: `1.5px solid ${SURF_BORD}`, background: SURF_HVR, color: MUTED,
            }}>
              <Pencil size={13} />
            </button>
            <button
              onClick={async () => { setDeleting(true); try { await onDelete(); } finally { setDeleting(false); } }}
              disabled={deleting}
              aria-label="Delete rotation"
              style={{
                ...iconBtn,
                border: "1.5px solid oklch(0.577 0.245 27 / 30%)",
                background: "oklch(0.577 0.245 27 / 8%)",
                color: "var(--destructive)",
              }}
            >
              {deleting ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={13} />}
            </button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {/* Stored order, not alphabetical — the admin arranged this deliberately. */}
        {rotation.scoutIds.map(id => {
          const u = userMap[id];
          const isDrive = driveSet.has(id);
          return (
            <span key={id}
              title={isDrive ? "Drive team for this rotation" : undefined}
              style={{
                display: "inline-flex", alignItems: "center", gap: 3,
                padding: "1px 8px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis",
                background: isDrive ? R_DIM : G_DIM,
                color: isDrive ? R : G,
                border: `1px solid ${isDrive ? R_MED : G_MED}`,
              }}>
              {isDrive && <Car size={11} style={{ flexShrink: 0 }} />}
              {u ? displayName(u) : "?"}{u?.isGuest && <GuestTag />}
            </span>
          );
        })}
        {rotation.scoutIds.length === 0 && (
          <span style={{ fontSize: 12, color: MUTED }}>No scouts assigned</span>
        )}
      </div>
    </div>
  );
}

// ── Elims pit rotation panel ──────────────────────────────────────────────────
// Exactly one elims rotation per event, covering all playoff matches.

function ElimsRotationPanel({ rotation, users, optedOut, noResponse, allUsers: allUsersRaw, onSave, onDelete, readOnly }: {
  rotation: PitRotation | null;
  users: User[];        // opted-in scouts
  optedOut: User[];     // answered the form and said no
  noResponse: User[];   // never answered the form
  allUsers?: User[];    // every scout, for resolving names in display mode
  onSave: (scoutIds: string[], driveTeamIds: Set<string>) => Promise<void>;
  onDelete: () => Promise<void>;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  // Ordered, not a Set — the roster's arrangement is meaningful and is what
  // gets persisted as scoutIds.
  const [selected, setSelected] = useState<string[]>(rotation?.scoutIds ?? []);
  const [selectedDrive, setSelectedDrive] = useState<Set<string>>(new Set(rotation?.driveTeamScoutIds ?? []));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Sync when rotation changes externally
  useEffect(() => {
    setSelected(rotation?.scoutIds ?? []);
    setSelectedDrive(new Set(rotation?.driveTeamScoutIds ?? []));
  }, [rotation]);

  const userMap = useMemo(
    () => Object.fromEntries([...(allUsersRaw ?? []), ...users].map(u => [u._id, u])),
    [allUsersRaw, users]
  );
  const driveSet = useMemo(() => new Set(rotation?.driveTeamScoutIds ?? []), [rotation]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggleScout(id: string) {
    if (selectedSet.has(id)) {
      setSelected(prev => prev.filter(s => s !== id));
      // Dropping a scout from the rotation drops their drive team flag with them.
      setSelectedDrive(prev => { const n = new Set(prev); n.delete(id); return n; });
    } else {
      setSelected(prev => [...prev, id]);
    }
  }

  function toggleDrive(id: string) {
    const turningOn = !selectedDrive.has(id);
    setSelectedDrive(prev => { const n = new Set(prev); if (turningOn) n.add(id); else n.delete(id); return n; });
    // Newly-flagged drivers jump to the front as a starting point — not pinned,
    // so they can be dragged anywhere afterwards.
    if (turningOn) setSelected(prev => [id, ...prev.filter(s => s !== id)]);
  }

  const renderChip = (u: User) => (
    <PitScoutChip
      key={u._id} user={u}
      selected={selectedSet.has(u._id)}
      onToggle={() => toggleScout(u._id)}
    />
  );

  async function handleSave() {
    setSaving(true);
    try { await onSave(selected, selectedDrive); setEditing(false); } finally { setSaving(false); }
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
            {!readOnly && (
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
            )}
          </div>
        ) : editing || !rotation ? (
          /* Edit / create form */
          <>
            <RosterStrip
              scoutIds={selected}
              driveTeamIds={selectedDrive}
              userMap={userMap}
              onReorder={(from, to) => setSelected(prev => arrayMove(prev, from, to))}
              onToggleDriveTeam={toggleDrive}
              onRemove={toggleScout}
            />
            <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
              Scouts on elims pit duty
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {users.length > 0
                ? users.map(u => renderChip(u))
                : <span style={{ fontSize: 12, color: MUTED }}>No scouts have opted into pit rotations.</span>
              }
            </div>
            {/* Non-opted-in scouts — manual override */}
            <OtherScoutsDisclosure optedOut={optedOut} noResponse={noResponse} renderChip={renderChip} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleSave} disabled={saving || selected.length === 0}
                style={{
                  flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 13, fontWeight: 700,
                  background: selected.length > 0 && !saving ? G : SURF_HVR,
                  color: selected.length > 0 && !saving ? G_TXT : MUTED,
                  border: "none", cursor: selected.length > 0 ? "pointer" : "default",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}
              >
                {saving
                  ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />Saving…</>
                  : <><Check size={13} />{rotation ? "Save Changes" : "Create Rotation"}</>
                }
              </button>
              {rotation && (
                <button onClick={() => {
                  setSelected(rotation.scoutIds);
                  setSelectedDrive(new Set(rotation.driveTeamScoutIds ?? []));
                  setEditing(false);
                }}
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
              ) : /* Stored order, not alphabetical — the arrangement is deliberate. */
                rotation.scoutIds.map(id => {
                const u = userMap[id];
                const isDrive = driveSet.has(id);
                return (
                  <span key={id}
                    title={isDrive ? "Drive team for this rotation" : undefined}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 4,
                      padding: "2px 9px", borderRadius: 20, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
                      background: isDrive ? R : G,
                      color: isDrive ? R_TXT : G_TXT,
                      boxShadow: `0 1px 6px ${isDrive ? R : G} / 25%`,
                    }}>
                    {isDrive && <Car size={11} />}
                    {u ? displayName(u) : "?"}{u?.isGuest && <GuestTag />}
                  </span>
                );
              })}
            </div>
            {!readOnly && (
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
            )}
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
  /** Ordered — this is the roster arrangement, persisted as scoutIds. */
  scoutIds: string[];
  /** Subset of scoutIds flagged as drive team for this rotation. */
  driveTeamIds: Set<string>;
}

const emptyRotationForm = (): RotationFormState => ({
  label: "", startMatch: "", endMatch: "", scoutIds: [], driveTeamIds: new Set(),
});

function RotationForm({ users, optedOut, noResponse, allUsers, initial, onSave, onCancel, isEdit }: {
  users: User[];          // opted-in scouts
  optedOut: User[];       // answered the form and said no
  noResponse: User[];     // never answered the form
  allUsers: User[];       // every scout, for resolving roster names
  initial?: RotationFormState;
  onSave: (form: RotationFormState) => Promise<void>;
  onCancel?: () => void;
  isEdit?: boolean;
}) {
  const [form, setForm] = useState<RotationFormState>(initial ?? emptyRotationForm());
  const [saving, setSaving] = useState(false);

  const userMap = useMemo(() => Object.fromEntries(allUsers.map(u => [u._id, u])), [allUsers]);
  const selectedSet = useMemo(() => new Set(form.scoutIds), [form.scoutIds]);

  function toggleScout(id: string) {
    setForm(f => {
      const d = new Set(f.driveTeamIds);
      // Dropping a scout from the rotation drops their drive team flag too.
      if (f.scoutIds.includes(id)) {
        d.delete(id);
        return { ...f, scoutIds: f.scoutIds.filter(s => s !== id), driveTeamIds: d };
      }
      return { ...f, scoutIds: [...f.scoutIds, id] };
    });
  }

  function toggleDrive(id: string) {
    setForm(f => {
      const d = new Set(f.driveTeamIds);
      if (d.has(id)) {
        d.delete(id);
        return { ...f, driveTeamIds: d };
      }
      d.add(id);
      // Newly-flagged drivers jump to the front as a starting point — not
      // pinned, so they can be dragged anywhere afterwards.
      return { ...f, scoutIds: [id, ...f.scoutIds.filter(s => s !== id)], driveTeamIds: d };
    });
  }

  async function handleSubmit() {
    if (!form.startMatch || !form.endMatch) return;
    setSaving(true);
    try {
      await onSave(form);
      setForm(emptyRotationForm());
    } finally { setSaving(false); }
  }

  const valid = !!form.startMatch && !!form.endMatch &&
    parseInt(form.startMatch) <= parseInt(form.endMatch) && form.scoutIds.length > 0;

  const inputStyle: React.CSSProperties = {
    flex: 1, padding: "7px 10px", borderRadius: 8, fontSize: 13,
    background: "var(--background)", border: `1.5px solid ${SURF_BORD}`,
    color: FG, outline: "none",
  };

  const renderChip = (u: User) => (
    <PitScoutChip
      key={u._id} user={u}
      selected={selectedSet.has(u._id)}
      onToggle={() => toggleScout(u._id)}
    />
  );

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

      {/* Ordered roster */}
      <RosterStrip
        scoutIds={form.scoutIds}
        driveTeamIds={form.driveTeamIds}
        userMap={userMap}
        onReorder={(from, to) => setForm(f => ({ ...f, scoutIds: arrayMove(f.scoutIds, from, to) }))}
        onToggleDriveTeam={toggleDrive}
        onRemove={toggleScout}
      />

      {/* Opted-in scouts */}
      <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
        Scouts on pit duty during this range
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {users.length > 0
          ? users.map(u => renderChip(u))
          : <span style={{ fontSize: 12, color: MUTED }}>No scouts have opted into pit rotations.</span>
        }
      </div>

      {/* Non-opted-in scouts — manual override section */}
      <OtherScoutsDisclosure optedOut={optedOut} noResponse={noResponse} renderChip={renderChip} />

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

// ── Shared "exclude from auto-schedule" controls ────────────────────────────
// One shared exclusion list (localStorage-backed, plus a permanent
// event-wide list from the DB) feeds all three generators — match
// assignments, pit rotations, and pit scouting all check it. Each tab gets
// its own toggle button + panel so an admin doesn't have to switch to the
// Match Assignments tab to adjust who's excluded while working on pit setup.

function ExcludeToggleButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Select scouts to exclude from auto-schedule generation"
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "7px 12px", borderRadius: 9, fontSize: 12, fontWeight: 700,
        background: count > 0 ? "oklch(0.55 0.18 30 / 15%)" : SURF_HVR,
        color: count > 0 ? "oklch(0.75 0.18 30)" : MUTED,
        border: count > 0 ? "1.5px solid oklch(0.55 0.18 30 / 40%)" : `1.5px solid ${SURF_BORD}`,
        cursor: "pointer", flexShrink: 0, transition: "all 0.15s",
      }}
    >
      <Users size={13} />
      Exclude
      {count > 0 && (
        <span style={{
          background: "oklch(0.55 0.18 30 / 25%)",
          borderRadius: 20, padding: "0 6px", fontSize: 11, fontWeight: 800,
          color: "oklch(0.75 0.18 30)",
        }}>
          {count}
        </span>
      )}
    </button>
  );
}

function ExcludePanel({
  allUsers, excludedScoutIds, dbExcludedSet, toggleExcluded, onClearLocal, onClose,
}: {
  allUsers: User[];
  excludedScoutIds: Set<string>;
  dbExcludedSet: Set<string>;
  toggleExcluded: (id: string) => void;
  onClearLocal: () => void;
  onClose: () => void;
}) {
  if (allUsers.length === 0) return null;
  return (
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
              onClick={onClearLocal}
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
            onClick={onClose}
            style={{
              fontSize: 16, lineHeight: 1, background: SURF_HVR,
              border: `1px solid ${SURF_BORD}`, borderRadius: 6,
              padding: "1px 7px", color: MUTED, cursor: "pointer",
            }}
          >×</button>
        </div>
      </div>
      <p style={{ fontSize: 11, color: MUTED, margin: 0, lineHeight: 1.4 }}>
        Scouts toggled below will be skipped when auto-generating — they won't receive any new match assignments, pit rotations, or pit scouting pairs.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {allUsers.map(u => {
          const excluded = excludedScoutIds.has(u._id);
          const dbExcluded = dbExcludedSet.has(u._id);
          return (
            <button
              key={u._id}
              onClick={() => !dbExcluded && toggleExcluded(u._id)}
              disabled={dbExcluded}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                cursor: dbExcluded ? "not-allowed" : "pointer", transition: "all 0.12s",
                background: dbExcluded
                  ? "oklch(0.55 0.18 30 / 12%)"
                  : excluded ? "oklch(0.55 0.18 30 / 18%)" : SURF_HVR,
                color: (dbExcluded || excluded)
                  ? "oklch(0.75 0.18 30)" : MUTED,
                border: (dbExcluded || excluded)
                  ? "1.5px solid oklch(0.55 0.18 30 / 50%)"
                  : `1.5px solid ${SURF_BORD}`,
                opacity: dbExcluded ? 0.7 : 1,
              }}
            >
              {u.image
                ? <img src={u.image} alt="" referrerPolicy="no-referrer" style={{ width: 16, height: 16, borderRadius: "50%", objectFit: "cover" }} />
                : <span style={{
                    width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
                    background: (dbExcluded || excluded) ? "oklch(0.55 0.18 30 / 40%)" : G_MED,
                    color: (dbExcluded || excluded) ? "oklch(0.75 0.18 30)" : G,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 800,
                  }}>
                    {avatarLetter(u)}
                  </span>
              }
              <span style={{
                textDecoration: (dbExcluded || excluded) ? "line-through" : "none",
                opacity: (dbExcluded || excluded) ? 0.75 : 1,
              }}>
                {displayName(u)}{u.isGuest && <GuestTag />}
              </span>
              {dbExcluded && (
                <span style={{
                  fontSize: 9, fontWeight: 800, textTransform: "uppercase",
                  letterSpacing: "0.05em", color: "oklch(0.6 0.18 30)",
                  background: "oklch(0.55 0.18 30 / 15%)",
                  padding: "1px 5px", borderRadius: 8,
                }}>Permanent</span>
              )}
              {!dbExcluded && excluded && (
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
  prefsByScout,
  onToggleScout,
  isMobile,
  readOnly,
}: {
  tbaTeams: TBATeamSimple[];
  tbaLoading: boolean;
  tbaError: boolean;
  assignments: Map<number, string[]>;
  allUsers: User[];
  prefsByScout?: PrefMap;
  onToggleScout: (teamNumber: number, scoutId: string) => Promise<void>;
  isMobile: boolean;
  readOnly?: boolean;
}) {
  const [pinnedScoutId, setPinnedScoutId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState<Set<number>>(new Set());
  const partners = partnerSet(prefsByScout, pinnedScoutId);

  const filtered = useMemo(() =>
    tbaTeams.filter(t =>
      !search ||
      String(t.team_number).includes(search) ||
      (t.nickname ?? "").toLowerCase().includes(search.toLowerCase())
    ), [tbaTeams, search]);

  const assignedCount = assignments.size;
  const totalCount    = tbaTeams.length;

  async function handleCellClick(teamNum: number) {
    if (!pinnedScoutId || readOnly) return;
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
            {readOnly ? "Pin a scout to highlight their teams" : "Pin a scout then click teams"}
            {pinnedScoutId && partners.size > 0 && <span style={{ color: PARTNER_BORD, marginLeft: 8, textTransform: "none", letterSpacing: 0 }}>♥ = their preferred partners</span>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {allUsers.map(u => {
              const pinned = u._id === pinnedScoutId;
              const pref   = !pinned && partners.has(u._id);
              const count  = [...assignments.values()].filter(ids => ids.includes(u._id)).length;
              return (
                <button key={u._id}
                  onClick={() => setPinnedScoutId(pinned ? null : u._id)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                    cursor: "pointer", transition: "all 0.12s",
                    background: pinned ? G : pref ? PARTNER_BG : SURF_HVR,
                    color:      pinned ? G_TXT : MUTED,
                    border:     `1.5px solid ${pinned ? G_STR : pref ? PARTNER_BORD : SURF_BORD}`,
                    boxShadow:  pinned ? `0 2px 8px ${G} / 30%` : "none",
                  }}
                >
                  {u.image
                    ? <img src={u.image} alt="" referrerPolicy="no-referrer" style={{ width: 14, height: 14, borderRadius: "50%", objectFit: "cover" }} />
                    : <span style={{ width: 14, height: 14, borderRadius: "50%", background: pinned ? G_TXT+"30" : G_MED, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 800, color: pinned ? G_TXT : G, flexShrink: 0 }}>{avatarLetter(u)}</span>
                  }
                  {displayName(u)}{u.isGuest && <GuestTag />}
                  {pref && <PartnerMark />}
                  <PrefBadges prefs={prefsByScout?.get(u._id)} kind="pit" />
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
                  onClick={() => !readOnly && pinnedScoutId && handleCellClick(team.team_number)}
                  disabled={readOnly || !pinnedScoutId || isSaving}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "flex-start",
                    padding: "10px 12px", borderRadius: 12, textAlign: "left",
                    cursor: pinnedScoutId && !readOnly ? "pointer" : "default",
                    background: hasPinned ? G : hasAny ? G_DIM : SURFACE,
                    border: `1.5px solid ${hasPinned ? G_STR : hasAny ? G_MED : SURF_BORD}`,
                    transition: "all 0.12s",
                    boxShadow: hasPinned ? `0 2px 10px ${G} / 30%` : "none",
                    opacity: isSaving ? 0.6 : 1,
                    position: "relative",
                    overflow: "hidden",
                  }}
                  onMouseEnter={e => { if (pinnedScoutId && !isSaving && !readOnly) (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-1px)"; }}
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
                      {[...scoutIds]
                        .sort((a, b) => displayName(allUsers.find(u => u._id === a) ?? { _id: a }).localeCompare(displayName(allUsers.find(u => u._id === b) ?? { _id: b })))
                        .map(id => {
                        const u = allUsers.find(u => u._id === id);
                        return (
                          <span key={id} style={{
                            fontSize: 9, fontWeight: 700,
                            padding: "1px 6px", borderRadius: 20,
                            background: hasPinned ? "oklch(0 0 0 / 20%)" : G_MED,
                            color: hasPinned ? G_TXT : G,
                          }}>
                            {u ? displayName(u) : "?"}{u?.isGuest && <GuestTag />}
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
          {readOnly
            ? "View only — enable admin mode to edit assignments"
            : "↑ Pin a scout above, then click team cards to assign them"}
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
  // Collapsed by default so the rotation list is visible on a phone; stays
  // open after each save so several rotations can be added in a row.
  const [showNewRotation, setShowNewRotation] = useState(false);
  const [autoGenResult, setAutoGenResult] = useState<SchedulerOutput | null>(null);
  const [autoGenApplying, setAutoGenApplying] = useState(false);
  const [autoGenRunning, setAutoGenRunning] = useState(false);
  const [autoGenError, setAutoGenError] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [clearingAllPit, setClearingAllPit] = useState(false);
  const [autoAssigningPitScouting, setAutoAssigningPitScouting] = useState(false);
  const [clearingAllPitScouting, setClearingAllPitScouting] = useState(false);
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
  const eventKey = currentEvent?.eventKey ?? "";

  const everyUser = useCached(
    useQuery(api.users.listUsers) as User[] | undefined,
    "all_users"
  ) as User[] | undefined;
  // Only the current event's roster (Manage Scouts) is schedulable. A cached
  // list from a pre-roster server has no flag, so it keeps everyone.
  const allUsers = useMemo(
    () => everyUser?.filter(u => u.onRoster !== false),
    [everyUser]
  );

  const allAssignments = useCached(
    useQuery(
      api.schedules.listMatchAssignments,
      eventKey ? { eventKey } : "skip"
    ) as MatchAssignment[] | undefined,
    `sched_match_assignments_${eventKey || "none"}`
  ) as MatchAssignment[] | undefined;

  const pitRotations = useCached(
    useQuery(
      api.schedules.listPitRotations,
      eventKey ? { eventKey } : "skip"
    ) as PitRotation[] | undefined,
    `sched_pit_rotations_${eventKey || "none"}`
  ) as PitRotation[] | undefined;

  const matchPlan = useCached(
    useQuery(
      api.schedules.getMatchPlan,
      eventKey ? { eventKey } : "skip"
    ) as { qualMatchCount: number } | null | undefined,
    `sched_match_plan_${eventKey || "none"}`
  ) as { qualMatchCount: number } | null | undefined;

  const allPreferences = useCached(
    useQuery(
      api.schedules.listAllPreferences,
      eventKey ? { eventKey } : "skip"
    ),
    `sched_all_preferences_${eventKey || "none"}`
  );

  const dbExcludedScoutIds = useQuery(
    api.schedules.getScheduleExclusions,
    eventKey ? { eventKey } : "skip"
  ) as string[] | undefined;
  const dbExcludedSet = useMemo(() => new Set(dbExcludedScoutIds ?? []), [dbExcludedScoutIds]);

  // Drive team: excluded from match scouting entirely, placed on every
  // auto-generated qual pit rotation (tagged in Manage Scouts).
  const driveTeamIds = useQuery(api.admin.listDriveTeamIds) as string[] | undefined;

  const setMatchAssignment       = useAdminMutation(api.schedules.setMatchAssignment);
  const clearMatchAssignment     = useAdminMutation(api.schedules.clearMatchAssignment);
  const clearAllMatchAssignments = useAdminMutation(api.schedules.clearAllMatchAssignments);
  const batchSet                 = useAdminMutation(api.schedules.batchSetMatchAssignments);
  const batchClear               = useAdminMutation(api.schedules.batchClearMatchAssignments);
  const upsertRotation           = useAdminMutation(api.schedules.upsertPitRotation);
  const deleteRotation           = useAdminMutation(api.schedules.deletePitRotation);
  const togglePitScout           = useAdminMutation(api.pitScouting.upsertPitScoutingAssignment);
  const clearAllPitScouting      = useAdminMutation(api.pitScouting.clearAllPitScoutingAssignments);
  const batchUpsertPitScouting   = useAdminMutation(api.pitScouting.batchUpsertPitScoutingAssignments);
  const setMatchPlan             = useAdminMutation(api.schedules.setMatchPlan);
  const clearAssignmentsAbove    = useAdminMutation(api.schedules.clearMatchAssignmentsAbove);

  const pitScoutingTeams = useCached(
    useQuery(
      api.pitScouting.listPitScoutingTeams,
      eventKey ? { eventKey } : "skip"
    ) as PitScoutingTeam[] | undefined,
    `sched_pit_scouting_teams_${eventKey || "none"}`
  ) as PitScoutingTeam[] | undefined;

  // TBA event teams (for pit scouting tab)
  const [tbaTeams, setTbaTeams] = useState<TBATeam[]>([]);
  const [tbaTeamsLoading, setTbaTeamsLoading] = useState(false);
  const [tbaTeamsError, setTbaTeamsError] = useState(false);

  useEffect(() => {
    if (activeTab !== "pitScouting" || !eventKey) return;
    // Seed from cache for instant / offline rendering
    const cached = lsGet<TBATeam[]>(`tba_teams_${eventKey}`)
                ?? lsGetStale<TBATeam[]>(`tba_teams_${eventKey}`);
    if (cached) setTbaTeams([...cached].sort((a, b) => a.team_number - b.team_number));

    setTbaTeamsLoading(true); setTbaTeamsError(false);
    fetchTBAEventTeams(eventKey)
      .then(data => {
        if (Array.isArray(data)) setTbaTeams([...data].sort((a, b) => a.team_number - b.team_number));
        else setTbaTeamsError(true);
      })
      .catch(() => setTbaTeamsError(true))
      .finally(() => setTbaTeamsLoading(false));
  }, [activeTab, eventKey]);

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
   * Auto-assign pit scouting via generatePitScoutingTeams (src/lib/scheduleGenerator.ts):
   * wantsPitScouting opt-ins are paired first (preference-aware), each pair
   * covers 6-8 TBA teams, extra pairs are recruited from zero-preference
   * scouts first (then fewest-preferences) if needed to stay under 8/pair,
   * and teams that already have a manual assignment are left untouched.
   */
  async function handleAutoAssignPitScouting(teams: TBATeamSimple[]) {
    if (!currentEvent || teams.length === 0 || !allUsers) return;
    const prefs = (allPreferences ?? []) as GenScoutPref[];
    const existingAssignments = [...pitAssignmentsMap.entries()].map(([teamNumber, scoutIds]) => ({ teamNumber, scoutIds }));

    const result = generatePitScoutingTeams({
      teamNumbers: teams.map(t => t.team_number),
      scouts: allUsers,
      preferences: prefs,
      existingAssignments,
      excludedScoutIds: [...new Set([...excludedScoutIds, ...dbExcludedSet])],
    });

    if (result.teamAssignments.length === 0) return;
    const assignments = result.teamAssignments.map(a => ({
      teamNumber: a.teamNumber,
      scoutIds: a.scoutIds as Id<"users">[],
    }));
    await batchUpsertPitScouting({ eventKey: currentEvent.eventKey, assignments });
    // Scheduling never edits scout preferences — admins do that in Manage Scouts.
    if (result.warnings.length > 0) window.alert(result.warnings.join("\n\n"));
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
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  // Seed TBA matches from cache immediately, then refresh in background
  useEffect(() => {
    if (!eventKey) { setMatches([]); return; }
    // Seed from cache so the grid appears instantly / offline
    const cached = lsGet<TBAMatch[]>(`tba_matches_full_${eventKey}`)
                ?? lsGetStale<TBAMatch[]>(`tba_matches_full_${eventKey}`);
    if (cached) setMatches([...cached].sort((a, b) => matchSortKey(a) - matchSortKey(b)));

    setMatchesLoading(true); setMatchesError(false);
    fetchTBAEventMatches(eventKey)
      .then(data => {
        if (Array.isArray(data)) setMatches([...data].sort((a, b) => matchSortKey(a) - matchSortKey(b)));
        else setMatchesError(true);
      })
      .catch(() => setMatchesError(true))
      .finally(() => setMatchesLoading(false));
  }, [eventKey]);

  // ── Planned vs. real matches ────────────────────────────────────────────────
  // TBA is the source of truth the moment it has one. Until then the grid runs
  // on placeholders built from the admin-entered qual count, so scouts can be
  // assigned to match numbers before the schedule is posted. The handover needs
  // no migration: assignments key on match number, and the placeholder labels
  // ("Q17") are exactly what tbaMatchLabel() produces for the real match.
  const tbaQualCount  = useMemo(() => matches.filter(m => m.comp_level === "qm").length, [matches]);
  const plannedCount  = matchPlan?.qualMatchCount ?? 0;
  const usingPlanned  = tbaQualCount === 0 && plannedCount > 0;

  const effectiveMatches = useMemo(
    () => (usingPlanned ? synthesizeQualMatches(eventKey, plannedCount) : matches),
    [usingPlanned, eventKey, plannedCount, matches]
  );

  // Assignments TBA's real schedule has no match for — left behind when the
  // planned count overshot the actual qual count. Only meaningful once TBA has
  // published; never computed against placeholders.
  const orphanedAssignments = useMemo(
    () => (tbaQualCount === 0
      ? []
      : (allAssignments ?? []).filter(a => a.matchNumber > tbaQualCount)),
    [allAssignments, tbaQualCount]
  );

  // Names resolve for everyone, so an assignment for someone since taken off
  // the roster still shows who it was.
  const userMap = useMemo(() => Object.fromEntries((everyUser ?? []).map(u => [u._id, u])), [everyUser]);

  // Alphabetized copy of allUsers — used everywhere scouts are listed for
  // admin selection (order-preserving filters downstream stay alphabetized too).
  const sortedAllUsers = useMemo(
    () => [...(allUsers ?? [])].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [allUsers]
  );

  // scoutId -> preference flags, for badging opted-in scouts across the page.
  const prefsByScout = useMemo(() => {
    const m = new Map<string, { wantsMoreMatches?: boolean; wantsPitScouting?: boolean; wantsPitRotation?: boolean; preferredPartners?: string[] }>();
    for (const p of (allPreferences ?? []) as Array<{ scoutId: string; wantsMoreMatches?: boolean; wantsPitScouting?: boolean; wantsPitRotation?: boolean; preferredPartners?: string[] }>) {
      m.set(p.scoutId, p);
    }
    return m;
  }, [allPreferences]);

  // Scouts split by what they actually said about pit rotations. "Said no" and
  // "never answered the form" are the same absence in the data (neither shows
  // up as an opt-in) but not the same thing when staffing a shift, so they're
  // kept apart: only a missing scoutPreferences row means no response.
  // If nobody has answered at all, fall back to treating everyone as available.
  const { pitUsers, pitOptedOut, pitNoResponse } = useMemo(() => {
    const prefs = allPreferences as Array<{ scoutId: string; wantsPitRotation: boolean }> | undefined;
    if (!prefs || prefs.length === 0) {
      return { pitUsers: sortedAllUsers, pitOptedOut: [] as User[], pitNoResponse: [] as User[] };
    }
    const answered = new Map(prefs.map(p => [p.scoutId, p.wantsPitRotation]));
    return {
      pitUsers:      sortedAllUsers.filter(u => answered.get(u._id) === true),
      pitOptedOut:   sortedAllUsers.filter(u => answered.get(u._id) === false),
      pitNoResponse: sortedAllUsers.filter(u => !answered.has(u._id)),
    };
  }, [sortedAllUsers, allPreferences]);

  const pitHiddenCount = pitOptedOut.length + pitNoResponse.length;

  const assignMap = useMemo(() => {
    const map: Record<number, Partial<Record<Position, { scoutId: string; name: string; guest?: boolean }>>> = {};
    for (const a of allAssignments ?? []) {
      if (!map[a.matchNumber]) map[a.matchNumber] = {};
      const u = userMap[a.scoutId];
      map[a.matchNumber][a.position] = { scoutId: a.scoutId, name: u ? displayName(u) : "?", guest: u?.isGuest };
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
    } catch (e) {
      warnAssignRefused(e);
    } finally {
      setSavingCells(p => { const n = new Set(p); n.delete(key); return n; });
    }
  }

  async function handleSaveMatchPlan(count: number) {
    if (!currentEvent) return;
    await setMatchPlan({ eventKey: currentEvent.eventKey, qualMatchCount: count });
  }

  async function handleClearOrphans() {
    if (!currentEvent || tbaQualCount === 0) return;
    await clearAssignmentsAbove({ eventKey: currentEvent.eventKey, maxMatchNumber: tbaQualCount });
  }

  async function handleBatchAssign(start: number, end: number, positions: Set<Position>) {
    if (!currentEvent || !pinnedScoutId) return;
    const inRange = effectiveMatches.filter(m => m.comp_level === "qm" && m.match_number >= start && m.match_number <= end);
    const assignments: Parameters<typeof batchSet>[0]["assignments"] = [];
    for (const m of inRange) {
      for (const pos of positions) {
        assignments.push({
          matchNumber: m.match_number, matchLabel: tbaMatchLabel(m),
          position: pos, scoutId: pinnedScoutId as Id<"users">,
        });
      }
    }
    if (assignments.length > 0) {
      try {
        await batchSet({ eventKey: currentEvent.eventKey, assignments });
      } catch (e) {
        warnAssignRefused(e);
      }
    }
  }

  /** Assigns (or clears) the pinned scout across every match in one 5-match
   *  cycle for a given position, in a single round trip. */
  async function handleCycleClick(cycleMatches: TBAMatch[], pos: Position) {
    if (!currentEvent || !pinnedScoutId) return;
    const key = `cycle-${cycleMatches[0].match_number}-${pos}`;
    setSavingCells(p => new Set(p).add(key));
    try {
      const allAssignedToPinned = cycleMatches.every(
        m => assignMap[m.match_number]?.[pos]?.scoutId === pinnedScoutId
      );
      if (allAssignedToPinned) {
        await batchClear({
          eventKey: currentEvent.eventKey,
          slots: cycleMatches.map(m => ({ matchNumber: m.match_number, position: pos })),
        });
      } else {
        await batchSet({
          eventKey: currentEvent.eventKey,
          assignments: cycleMatches.map(m => ({
            matchNumber: m.match_number, matchLabel: tbaMatchLabel(m),
            position: pos, scoutId: pinnedScoutId as Id<"users">,
          })),
        });
      }
    } catch (e) {
      warnAssignRefused(e);
    } finally {
      setSavingCells(p => { const n = new Set(p); n.delete(key); return n; });
    }
  }

  async function handleSaveRotation(form: RotationFormState, id?: string) {
    if (!currentEvent) return;
    await upsertRotation({
      id: id as Id<"pitRotations"> | undefined,
      eventKey: currentEvent.eventKey,
      label: form.label || undefined,
      startMatch: parseInt(form.startMatch),
      endMatch: parseInt(form.endMatch),
      scoutIds: form.scoutIds as Id<"users">[],
      driveTeamScoutIds: Array.from(form.driveTeamIds) as Id<"users">[],
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

  /** Clear All for the Pit Rotations tab — qual rotations only; the elims
   *  rotation is a separate, always-manual single block and isn't touched. */
  async function handleClearAllQualPit() {
    if (!currentEvent) return;
    const qualRots = (pitRotations ?? []).filter(r => !r.isElims);
    if (qualRots.length === 0) return;
    const confirmed = window.confirm(
      `Clear all ${qualRots.length} qual pit rotation${qualRots.length !== 1 ? "s" : ""} for this event? ` +
      `This cannot be undone. (The elims rotation is not affected.)`
    );
    if (!confirmed) return;
    setClearingAllPit(true);
    try {
      await Promise.all(qualRots.map(r => deleteRotation({ id: r._id as Id<"pitRotations"> })));
    } finally {
      setClearingAllPit(false);
    }
  }

  /** Clear All for the Pit Scouting tab — mirrors handleClearAll /
   *  handleClearAllQualPit so all three tabs' Clear All buttons behave the
   *  same way (confirm, loading state, then the mutation). */
  async function handleClearAllPitScouting() {
    if (!currentEvent) return;
    const count = pitAssignmentsMap.size;
    if (count === 0) return;
    const confirmed = window.confirm(`Clear all ${count} pit scouting assignment${count !== 1 ? "s" : ""} for this event?`);
    if (!confirmed) return;
    setClearingAllPitScouting(true);
    try {
      await clearAllPitScouting({ eventKey: currentEvent.eventKey });
    } finally {
      setClearingAllPitScouting(false);
    }
  }

  /** Auto Assign for the Pit Scouting tab — confirm dialog + loading state
   *  lifted up here (was previously local to PitScoutingTab) so the button
   *  can live in the shared action row alongside the other two tabs. */
  async function handleAutoAssignPitScoutingClick() {
    const optedInCount = (allPreferences ?? []).filter((p: any) => p.wantsPitScouting === true).length;
    const msg = optedInCount > 0
      ? `Auto-assign ${optedInCount} opted-in scouts into pairs of 2, covering 6-8 teams each? ` +
        `Extra pairs will be recruited from scouts with no preferences if needed.`
      : `No scouts have opted in yet — recruit scouts with no preferences into pairs of 2, ` +
        `covering 6-8 teams each?`;
    if (!window.confirm(msg)) return;
    setAutoAssigningPitScouting(true);
    try {
      await handleAutoAssignPitScouting(tbaTeams);
    } finally {
      setAutoAssigningPitScouting(false);
    }
  }

  // ── Auto-generate handler ─────────────────────────────────────────────────
  // The underlying generateSchedule() call always plans pit rotations first
  // (pit always wins over match scouting), but each tab only ever applies
  // its own half of the result — they're independent actions from the
  // admin's point of view, matching the separate Auto-Generate/Clear All
  // controls per tab:
  //  - "matchOnly": Match Assignments tab's Auto-Generate. Strips
  //    newPitRotations from the result so Apply only touches match slots.
  //  - "pitOnly": Pit Rotations tab's Auto-Assign. Strips matchAssignments
  //    so Apply only touches pit rotations.
  const handleAutoGenerate = useCallback(async (mode: "matchOnly" | "pitOnly") => {
    if (!currentEvent || !allUsers || !effectiveMatches.length) return;
    setAutoGenRunning(true);
    try {
      const qualMatches = effectiveMatches
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

      // Who's actually got a real pit scouting assignment already (not just
      // the preference checkbox) — feeds the match step's "idle scouts get
      // ~1.5x more blocks" rule. Meant to be run last, after pit scouting
      // and pit rotations are generated and applied, so this reflects the
      // real, already-saved state of the event.
      const pitScoutingAssignedScoutIds = [...new Set([...pitAssignmentsMap.values()].flat())];

      const result = generateSchedule({
        qualMatches,
        scouts: allUsers,
        preferences: prefs,
        existingPitRotations: existingPit,
        existingMatchAssignments: existingAssigns,
        excludedScoutIds: [...new Set([...excludedScoutIds, ...dbExcludedSet])],
        driveTeamScoutIds: driveTeamIds ?? [],
        pitScoutingAssignedScoutIds,
      });

      setAutoGenResult(mode === "pitOnly"
        ? {
            ...result, matchAssignments: [],
            warnings: result.warnings.filter(w => /pit|drive team/i.test(w)),
            stats: { ...result.stats, assignedSlots: 0 },
          }
        : {
            ...result, newPitRotations: [],
            warnings: result.warnings.filter(w => !/pit|drive team/i.test(w)),
            stats: { ...result.stats, newPitRotationCount: 0 },
          });
    } finally {
      setAutoGenRunning(false);
    }
  }, [currentEvent, allUsers, effectiveMatches, allPreferences, allAssignments, pitRotations, excludedScoutIds, dbExcludedSet, driveTeamIds, pitAssignmentsMap]);

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
          driveTeamScoutIds: rot.driveTeamScoutIds as Id<"users">[],
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

  const readOnly = !isAdminMode;

  // Match scouting only ever covers qual matches — elims are always manual
  // (ElimsRotationPanel), so they're excluded from the grid, the scout
  // selector's per-scout counts, and the "N/M slots filled" progress stat.
  const qualMatches = useMemo(() => effectiveMatches.filter(m => m.comp_level === "qm"), [effectiveMatches]);

  const totalSlots  = qualMatches.length * 6;
  const filledSlots = (allAssignments ?? []).length;
  const pct = totalSlots > 0 ? Math.min(100, Math.round((filledSlots / totalSlots) * 100)) : 0;

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
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 style={{ fontSize: isLandscapePhone ? 15 : isMobile ? 18 : 22, fontWeight: 800, color: FG, margin: 0, lineHeight: 1.2, letterSpacing: "-0.02em" }}>
                Scheduling
              </h1>
              {readOnly && (
                <span style={{
                  fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em",
                  color: MUTED, background: SURF_HVR, border: `1px solid ${SURF_BORD}`,
                  borderRadius: 20, padding: "2px 8px", flexShrink: 0,
                }}>
                  View only
                </span>
              )}
            </div>
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

          {/* ── Shared action row: Auto-Generate/Assign, Exclude, Clear All ──
              One row, rendered in the same spot right below the tab bar for
              all three tabs, so the controls don't jump around when
              switching tabs. Which primary/clear action fires depends on
              activeTab; admin editing only. */}
          {!readOnly && !isLandscapePhone && currentEvent && allUsers && allUsers.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {activeTab === "matches" && allUsers && effectiveMatches.length > 0 && (
                  <button
                    onClick={() => handleAutoGenerate("matchOnly")}
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
                      : <><Sparkles size={14} />Auto-Generate Matches</>}
                  </button>
                )}
                {activeTab === "pit" && allUsers && effectiveMatches.length > 0 && (
                  <button
                    onClick={() => handleAutoGenerate("pitOnly")}
                    disabled={autoGenRunning}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                      padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 700,
                      background: G_DIM, color: G, border: `1.5px solid ${G_STR}`,
                      cursor: autoGenRunning ? "wait" : "pointer", flexShrink: 0,
                      opacity: autoGenRunning ? 0.7 : 1,
                      flex: isMobile ? "1 1 auto" : "none",
                    }}
                  >
                    {autoGenRunning
                      ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />Generating…</>
                      : <><Zap size={14} />Auto-Assign Pit Rotations{driveTeamIds && driveTeamIds.length > 0 ? ` (${driveTeamIds.length} drive team)` : ""}</>}
                  </button>
                )}
                {activeTab === "pitScouting" && tbaTeams.length > 0 && (
                  <button
                    onClick={handleAutoAssignPitScoutingClick}
                    disabled={autoAssigningPitScouting}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                      padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 700,
                      background: G_DIM, color: G, border: `1.5px solid ${G_STR}`,
                      cursor: autoAssigningPitScouting ? "wait" : "pointer", flexShrink: 0,
                      opacity: autoAssigningPitScouting ? 0.7 : 1,
                      flex: isMobile ? "1 1 auto" : "none",
                    }}
                  >
                    {autoAssigningPitScouting
                      ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />Assigning…</>
                      : <><Zap size={14} />Auto Assign Pit Scouting</>}
                  </button>
                )}

                {/* Exclude scouts toggle button — same control, all tabs */}
                {allUsers && allUsers.length > 0 && (
                  <ExcludeToggleButton
                    count={new Set([...excludedScoutIds, ...dbExcludedSet]).size}
                    onClick={() => setShowExcludePanel(v => !v)}
                  />
                )}

                {activeTab === "matches" && filledSlots > 0 && (
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
                {activeTab === "pit" && (pitRotations ?? []).filter(r => !r.isElims).length > 0 && (
                  <button
                    onClick={handleClearAllQualPit}
                    disabled={clearingAllPit}
                    title="Remove all qual pit rotations for this event (elims rotation is not affected)"
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 14px", borderRadius: 10, fontSize: 13, fontWeight: 700,
                      background: "oklch(0.577 0.245 27 / 12%)",
                      color: "var(--destructive)",
                      border: "1.5px solid oklch(0.577 0.245 27 / 35%)",
                      cursor: clearingAllPit ? "wait" : "pointer",
                      flexShrink: 0, opacity: clearingAllPit ? 0.6 : 1,
                      flex: isMobile ? "1 1 auto" : "none",
                    }}
                  >
                    {clearingAllPit
                      ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />Clearing…</>
                      : <><Trash2 size={13} />Clear All</>}
                  </button>
                )}
                {activeTab === "pitScouting" && pitAssignmentsMap.size > 0 && (
                  <button
                    onClick={handleClearAllPitScouting}
                    disabled={clearingAllPitScouting}
                    title="Remove all pit scouting assignments for this event"
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 14px", borderRadius: 10, fontSize: 13, fontWeight: 700,
                      background: "oklch(0.577 0.245 27 / 12%)",
                      color: "var(--destructive)",
                      border: "1.5px solid oklch(0.577 0.245 27 / 35%)",
                      cursor: clearingAllPitScouting ? "wait" : "pointer",
                      flexShrink: 0, opacity: clearingAllPitScouting ? 0.6 : 1,
                      flex: isMobile ? "1 1 auto" : "none",
                    }}
                  >
                    {clearingAllPitScouting
                      ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />Clearing…</>
                      : <><Trash2 size={13} />Clear All</>}
                  </button>
                )}
              </div>

              {/* ── Exclude from auto-schedule panel ── */}
              {showExcludePanel && allUsers && allUsers.length > 0 && (
                <ExcludePanel
                  allUsers={sortedAllUsers}
                  excludedScoutIds={excludedScoutIds}
                  dbExcludedSet={dbExcludedSet}
                  toggleExcluded={toggleExcluded}
                  onClearLocal={() => {
                    setExcludedScoutIds(new Set());
                    if (currentEvent?.eventKey) {
                      try { localStorage.removeItem(`falconscout_excluded_scouts_${currentEvent.eventKey}`); } catch { /* ignore */ }
                    }
                  }}
                  onClose={() => setShowExcludePanel(false)}
                />
              )}
            </div>
          )}

          {/* ── Match assignments tab ───────────────────────────────────── */}
          {activeTab === "matches" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: isLandscapePhone ? 6 : 10, minHeight: 0 }}>
              {/* A TBA fetch that's still in flight no longer blocks the grid —
                  planned matches (or cached ones) are already assignable, and
                  the real schedule swaps in underneath when it arrives. */}
              {matchesLoading && qualMatches.length === 0 ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: MUTED }}>
                  <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
                  <span style={{ fontSize: 14 }}>Loading matches from TBA…</span>
                </div>
              ) : (
                <>
                  {tbaQualCount === 0 && !matchesLoading && (
                    <MatchPlanPanel
                      plannedCount={plannedCount}
                      readOnly={readOnly}
                      onSave={handleSaveMatchPlan}
                    />
                  )}

                  {orphanedAssignments.length > 0 && (
                    <OrphanWarning
                      count={orphanedAssignments.length}
                      maxMatchNumber={tbaQualCount}
                      readOnly={readOnly}
                      onClear={handleClearOrphans}
                    />
                  )}

                  {matchesError && tbaQualCount === 0 && plannedCount === 0 && (
                    <div style={{ fontSize: 11.5, color: MUTED, textAlign: "center", padding: "2px 0" }}>
                      Couldn't reach TBA — check your API key in Settings.
                    </div>
                  )}

                  <div style={{ flex: 1, display: "flex", flexDirection: stackLayout ? "column" : "row", gap: isLandscapePhone ? 6 : 12, minHeight: 0 }}>
                    <ScoutSelector
                      users={sortedAllUsers}
                      prefsByScout={prefsByScout}
                      pinnedId={pinnedScoutId}
                      onPin={setPinnedScoutId}
                      matchCounts={matchCounts}
                      matches={qualMatches}
                      onBatchAssign={handleBatchAssign}
                      isLandscapePhone={isLandscapePhone}
                      stackLayout={stackLayout}
                      readOnly={readOnly}
                    />
                    <MatchGrid
                      matches={qualMatches}
                      assignMap={assignMap}
                      pinnedId={pinnedScoutId}
                      onCellClick={handleCellClick}
                      onCycleClick={handleCycleClick}
                      saving={savingCells}
                      isMobile={isMobile}
                      isLandscapePhone={isLandscapePhone}
                      stackLayout={stackLayout}
                      readOnly={readOnly}
                    />
                  </div>
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
                  optedOut={pitOptedOut}
                  noResponse={pitNoResponse}
                  allUsers={sortedAllUsers}
                  onSave={async (scoutIds, driveTeamIds) => {
                    if (!currentEvent) return;
                    await upsertRotation({
                      id: elimsRot?._id as Id<"pitRotations"> | undefined,
                      eventKey: currentEvent.eventKey,
                      label: "Elims Pit Rotation",
                      isElims: true,
                      scoutIds: scoutIds as Id<"users">[],
                      driveTeamScoutIds: Array.from(driveTeamIds) as Id<"users">[],
                    });
                  }}
                  onDelete={async () => {
                    if (elimsRot) await deleteRotation({ id: elimsRot._id as Id<"pitRotations"> });
                  }}
                  readOnly={readOnly}
                />

                {/* Divider */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, height: 1, background: SURF_BORD }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap" }}>
                    Qual Pit Rotations
                  </span>
                  <div style={{ flex: 1, height: 1, background: SURF_BORD }} />
                </div>


                {/* Opt-in breakdown — an explicit "no" and never answering the
                    form both leave a scout off pit duty, but only one of them
                    is a decision, so the counts are reported separately. */}
                {pitHiddenCount > 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 12px", borderRadius: 9,
                    background: "oklch(0.65 0.18 270 / 8%)",
                    border: "1px solid oklch(0.65 0.18 270 / 25%)",
                    fontSize: 12, color: "oklch(0.7 0.15 270)",
                    flexShrink: 0, flexWrap: "wrap",
                  }}>
                    <Wrench size={12} style={{ flexShrink: 0 }} />
                    <span>
                      <strong>{pitUsers.length}</strong> opted in
                      {pitOptedOut.length > 0 && <> · <strong>{pitOptedOut.length}</strong> said no</>}
                      {pitNoResponse.length > 0 && <> · <strong>{pitNoResponse.length}</strong> never answered the form</>}
                      . Both hidden groups are under “Add others” below.
                    </span>
                  </div>
                )}

                {/* Qual rotation form (only when not editing, admin editing only) */}
                {!readOnly && !editingRotation && (showNewRotation ? (
                  <RotationForm
                    users={pitUsers} optedOut={pitOptedOut} noResponse={pitNoResponse}
                    allUsers={sortedAllUsers}
                    onSave={form => handleSaveRotation(form)}
                    onCancel={() => setShowNewRotation(false)}
                  />
                ) : (
                  <button onClick={() => setShowNewRotation(true)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 6, flexShrink: 0,
                      padding: "9px 0", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer",
                      background: "transparent", color: G, border: `1.5px dashed ${G_MED}`,
                    }}
                  >
                    <Plus size={13} />New Pit Rotation
                  </button>
                ))}

                {/* Qual rotation list */}
                <ScrollArea style={{ flex: 1 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 16 }}>
                    {qualRots.length === 0 && !editingRotation && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "24px 16px", textAlign: "center", color: MUTED }}>
                        <Wrench size={24} style={{ opacity: 0.3 }} />
                        <span style={{ fontSize: 13 }}>No qual rotations yet.</span>
                      </div>
                    )}
                    {editingRotation && (
                      <RotationForm
                        key={editingRotation._id}
                        users={pitUsers} optedOut={pitOptedOut} noResponse={pitNoResponse}
                        allUsers={sortedAllUsers} isEdit
                        initial={{
                          label: editingRotation.label ?? "",
                          startMatch: String(editingRotation.startMatch ?? ""),
                          endMatch: String(editingRotation.endMatch ?? ""),
                          scoutIds: editingRotation.scoutIds,
                          driveTeamIds: new Set(editingRotation.driveTeamScoutIds ?? []),
                        }}
                        onSave={form => handleSaveRotation(form, editingRotation._id)}
                        onCancel={() => setEditingRotation(null)}
                      />
                    )}
                    {qualRots
                      .filter(r => r._id !== editingRotation?._id)
                      .map(r => (
                        <RotationCard
                          key={r._id} rotation={r} users={sortedAllUsers}
                          onEdit={() => setEditingRotation(r)}
                          onDelete={async () => { await deleteRotation({ id: r._id as Id<"pitRotations"> }); }}
                          readOnly={readOnly}
                        />
                      ))}
                  </div>
                </ScrollArea>
              </div>
            );
          })()}
          {/* ── Pit scouting teams tab ──────────────────────────────────── */}
          {activeTab === "pitScouting" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
              <PitScoutingTab
                tbaTeams={tbaTeams}
                tbaLoading={tbaTeamsLoading}
                tbaError={tbaTeamsError}
                assignments={pitAssignmentsMap}
                allUsers={sortedAllUsers}
                prefsByScout={prefsByScout}
                onToggleScout={handleTogglePitScout}
                isMobile={isMobile}
                readOnly={readOnly}
              />
            </div>
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
