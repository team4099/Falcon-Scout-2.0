import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useUIStore } from "@/store/uiStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchTBAEventMatches } from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import {
  Users, ShieldAlert, Lock, CalendarDays, Wrench, Loader2,
  AlertCircle, Plus, Trash2, Pencil, Check,
  Zap, LayoutGrid, Sparkles, TriangleAlert, ChevronDown as ChevDown,
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

type Position = "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";
type TabType = "matches" | "pit";

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
}

function ScoutSelector({ users, pinnedId, onPin, matchCounts, matches, onBatchAssign }: ScoutSelectorProps) {
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
      width: 248, flexShrink: 0, display: "flex", flexDirection: "column",
      minHeight: 0, borderRadius: 14, border: `1px solid ${SURF_BORD}`,
      background: SURFACE, overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ padding: "11px 14px", borderBottom: `1px solid ${SURF_BORD}`, background: G_DIM, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Users size={13} style={{ color: G }} />
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: G }}>
            Pin a Scout
          </span>
          <span style={{ marginLeft: "auto", background: G_MED, color: G, borderRadius: 20, padding: "1px 8px", fontSize: 11, fontWeight: 700 }}>
            {users.length}
          </span>
        </div>
        <p style={{ fontSize: 11, color: MUTED, margin: "4px 0 0", lineHeight: 1.3 }}>
          Select a scout, then click grid cells to assign.
        </p>
      </div>

      {/* Scout list */}
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

      {/* Batch assign — only when a scout is pinned */}
      {pinned && (
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
  assignMap: Record<number, Partial<Record<Position, { scoutId: string; name: string }>>>;
  pinnedId: string | null;
  onCellClick: (matchNum: number, matchLbl: string, pos: Position) => void;
  saving: Set<string>;
}

function MatchGrid({ matches, assignMap, pinnedId, onCellClick, saving }: MatchGridProps) {
  if (matches.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: MUTED }}>
        <CalendarDays size={30} style={{ opacity: 0.3 }} />
        <span style={{ fontSize: 14 }}>No matches found for this event yet.</span>
      </div>
    );
  }

  // Column widths — label + 3 red + divider + 3 blue
  const COL = "50px 1fr 1fr 1fr 3px 1fr 1fr 1fr";

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRadius: 14, border: `1px solid ${SURF_BORD}`, background: SURFACE, overflow: "hidden" }}>
      {/* Sticky header */}
      <div style={{
        display: "grid", gridTemplateColumns: COL,
        alignItems: "stretch", padding: "0 10px", flexShrink: 0,
        borderBottom: `1px solid ${SURF_BORD}`, background: "var(--card)",
      }}>
        <div style={{ padding: "9px 4px", fontSize: 10, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Match
        </div>
        {POSITIONS.map((p, i) => (
          <>
            {i === 3 && (
              <div key="divider-h" style={{ background: SURF_BORD, width: "100%", alignSelf: "stretch" }} />
            )}
            <div key={p} style={{
              padding: "9px 4px", textAlign: "center",
              fontSize: 10, fontWeight: 800, letterSpacing: "0.07em", color: G,
              borderBottom: `2px solid ${G}`,
            }}>
              {POS_META[p].short}
            </div>
          </>
        ))}
      </div>

      {/* Rows */}
      <ScrollArea style={{ flex: 1 }}>
        <div style={{ padding: "4px 10px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
          {matches.map(m => {
            const lbl = tbaMatchLabel(m);
            const row = assignMap[m.match_number] ?? {};
            const isQual = m.comp_level === "qm";

            return (
              <div key={m.key} style={{
                display: "grid", gridTemplateColumns: COL,
                gap: 0, alignItems: "center",
                borderRadius: 8,
                background: !isQual ? G_DIM : "transparent",
                borderLeft: !isQual ? `2px solid ${G_MED}` : "2px solid transparent",
              }}>
                {/* Match label */}
                <div style={{
                  padding: "3px 4px", fontSize: 12, fontWeight: 700,
                  fontFamily: "monospace", letterSpacing: "-0.01em",
                  color: isQual ? FG : G,
                }}>
                  {lbl}
                </div>

                {/* Position cells */}
                {POSITIONS.map((p, i) => {
                  const savingKey = `${m.match_number}-${p}`;
                  const isSaving = saving.has(savingKey);
                  const assigned = row[p];
                  const isPinned = assigned?.scoutId === pinnedId;

                  // Cell styling based on state
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
                          margin: "2px",
                          padding: "4px 3px", borderRadius: 6,
                          cursor: pinnedId ? "pointer" : "default",
                          background: cellBg, border: cellBorder,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 11, fontWeight: 700, color: textColor,
                          transition: "all 0.1s", minHeight: 28, minWidth: 0, overflow: "hidden",
                          opacity: isSaving ? 0.5 : 1,
                        }}
                        onMouseEnter={e => {
                          if (pinnedId && !isSaving) {
                            e.currentTarget.style.background = assigned ? G_DIM : G_DIM;
                            e.currentTarget.style.borderColor = G_MED;
                          }
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.background = cellBg;
                          e.currentTarget.style.borderColor = cellBorder.split(" ")[2];
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
            );
          })}
        </div>
      </ScrollArea>

      {/* Footer legend */}
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

function ElimsRotationPanel({ rotation, users, onSave, onDelete }: {
  rotation: PitRotation | null;
  users: User[];
  onSave: (scoutIds: Set<string>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(rotation?.scoutIds ?? []));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Sync when rotation changes externally
  useEffect(() => { setSelected(new Set(rotation?.scoutIds ?? [])); }, [rotation]);

  const userMap = useMemo(() => Object.fromEntries(users.map(u => [u._id, u])), [users]);

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
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {users.map(u => {
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

function RotationForm({ users, initial, onSave, onCancel, isEdit }: {
  users: User[];
  initial?: RotationFormState;
  onSave: (form: RotationFormState) => Promise<void>;
  onCancel?: () => void;
  isEdit?: boolean;
}) {
  const [form, setForm] = useState<RotationFormState>(
    initial ?? { label: "", startMatch: "", endMatch: "", scoutIds: new Set() }
  );
  const [saving, setSaving] = useState(false);

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

      {/* Scout multi-select */}
      <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
        Scouts on pit duty during this range
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {users.map(u => {
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
        })}
      </div>

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
}: {
  result: SchedulerOutput;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  applying: boolean;
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
                cursor: applying ? "wait" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                boxShadow: `0 4px 14px ${G} / 35%`,
                opacity: applying ? 0.7 : 1,
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

  const setMatchAssignment   = useMutation(api.schedules.setMatchAssignment);
  const clearMatchAssignment = useMutation(api.schedules.clearMatchAssignment);
  const batchSet             = useMutation(api.schedules.batchSetMatchAssignments);
  const upsertRotation       = useMutation(api.schedules.upsertPitRotation);
  const deleteRotation       = useMutation(api.schedules.deletePitRotation);

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
    const map: Record<number, Partial<Record<Position, { scoutId: string; name: string }>>> = {};
    for (const a of allAssignments ?? []) {
      if (!map[a.matchNumber]) map[a.matchNumber] = {};
      const u = userMap[a.scoutId];
      map[a.matchNumber][a.position] = { scoutId: a.scoutId, name: u ? firstName(u) : "?" };
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
      });

      setAutoGenResult(result);
    } finally {
      setAutoGenRunning(false);
    }
  }, [currentEvent, allUsers, matches, allPreferences, allAssignments, pitRotations]);

  const handleAutoApply = useCallback(async () => {
    if (!autoGenResult || !currentEvent) return;
    setAutoGenApplying(true);
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
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, background: G, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 4px 16px ${G} / 45%`,
          }}>
            <LayoutGrid size={19} color={G_TXT} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: FG, margin: 0, lineHeight: 1.2, letterSpacing: "-0.02em" }}>
              Scheduling
            </h1>
            <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>
              {currentEvent
                ? `${currentEvent.eventName ?? currentEvent.eventKey} · ${filledSlots}/${totalSlots} slots filled`
                : "Set an event in Settings to build a schedule"}
            </p>
          </div>
          {currentEvent && allUsers && matches.length > 0 && (
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
              }}
              onMouseEnter={e => { if (!autoGenRunning) (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 6px 20px ${G} / 50%`; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 14px ${G} / 35%`; }}
            >
              {autoGenRunning
                ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />Generating…</>
                : <><Sparkles size={14} />Auto-Generate</>}
            </button>
          )}
          {currentEvent && totalSlots > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <div style={{ width: 120, height: 6, borderRadius: 999, background: SURF_BORD, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 999, background: G, width: `${pct}%`, transition: "width 0.4s ease" }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: G, minWidth: 32 }}>{pct}%</span>
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
          <div style={{ display: "flex", gap: 4, flexShrink: 0, background: SURFACE, borderRadius: 10, padding: 4, width: "fit-content", border: `1px solid ${SURF_BORD}` }}>
            {([
              { id: "matches" as TabType, label: "Match Assignments", icon: LayoutGrid },
              { id: "pit"     as TabType, label: "Pit Rotations",     icon: Wrench    },
            ]).map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setActiveTab(id)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 14px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer",
                  background: activeTab === id ? G : "transparent",
                  color: activeTab === id ? G_TXT : MUTED,
                  border: "none", transition: "all 0.15s",
                }}
              >
                <Icon size={14} />
                {label}
                {id === "pit" && (pitRotations?.length ?? 0) > 0 && (
                  <span style={{ background: "oklch(0 0 0 / 20%)", borderRadius: 20, padding: "0 6px", fontSize: 11, fontWeight: 700 }}>
                    {pitRotations!.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* ── Match assignments tab ───────────────────────────────────── */}
          {activeTab === "matches" && (
            <div style={{ flex: 1, display: "flex", gap: 12, minHeight: 0 }}>
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
                  />
                  <MatchGrid
                    matches={matches}
                    assignMap={assignMap}
                    pinnedId={pinnedScoutId}
                    onCellClick={handleCellClick}
                    saving={savingCells}
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
                  <RotationForm users={pitUsers} onSave={form => handleSaveRotation(form)} />
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
                        users={pitUsers} isEdit
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
        </>
      )}
      </div>

      {/* Auto-generate modal overlay */}
      {autoGenResult && (
        <AutoGenerateModal
          result={autoGenResult}
          onConfirm={handleAutoApply}
          onCancel={() => setAutoGenResult(null)}
          applying={autoGenApplying}
        />
      )}
    </>
  );
}
