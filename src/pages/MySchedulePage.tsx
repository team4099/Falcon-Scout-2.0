import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useMutation } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchTBAEventMatches } from "@/lib/api";
import { lsGet, lsGetStale } from "@/lib/persistentCache";
import type { TBAMatch } from "@/lib/api";
import type { FormField } from "@/types";
import {
  CalendarDays, CalendarCheck, ClipboardList, Wrench, Coffee,
  Loader2, CheckCircle2, Users, ClipboardCheck,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Position = "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";

interface MatchAssignment {
  _id: string;
  matchNumber: number;
  matchLabel: string;
  position: Position;
}

interface PitRotation {
  _id: string;
  eventKey?: string;
  label?: string;
  startMatch?: number;
  endMatch?: number;
  isElims?: boolean;
  scoutIds: string[];
}

interface ChecklistTemplate {
  _id: string;
  name: string;
  fields: FormField[];
  isActive: boolean;
}

interface ChecklistAssignment {
  matchNumber: number;
  templateId: string;
  templateName: string;
  isCompleted: boolean;
}

interface PitScoutingAssignment {
  _id: string;
  eventKey: string;
  teamNumber: number;   // FRC team number from TBA
  scoutIds: string[];
}

// ── Position labels ───────────────────────────────────────────────────────────

const POS_LABEL: Record<Position, string> = {
  red1: "Red 1", red2: "Red 2", red3: "Red 3",
  blue1: "Blue 1", blue2: "Blue 2", blue3: "Blue 3",
};

// ── Theme tokens — gold / black only ─────────────────────────────────────────

const G       = "oklch(0.85 0.18 95)";
const G_DIM   = "oklch(0.85 0.18 95 / 10%)";
const G_MED   = "oklch(0.85 0.18 95 / 25%)";
const G_STR   = "oklch(0.85 0.18 95 / 45%)";
const G_TXT   = "oklch(0.1 0 0)";
const SURFACE   = "oklch(1 0 0 / 3%)";
const SURF_BORD = "oklch(1 0 0 / 8%)";
const MUTED     = "var(--muted-foreground)";
const FG        = "var(--foreground)";

// ── Checklist assignment algorithm (mirrors ChecklistPage) ───────────────────

const OUR_TEAM_KEY = "frc4099";

function computeMyChecklistAssignments(
  tbaMatches: TBAMatch[],
  allPitRotations: PitRotation[],
  templates: ChecklistTemplate[],
  myUserId: string,
  completedSet: Set<string>,
): ChecklistAssignment[] {
  const qualMatchNums = tbaMatches
    .filter(m =>
      m.comp_level === "qm" &&
      (m.alliances.red.team_keys.includes(OUR_TEAM_KEY) ||
       m.alliances.blue.team_keys.includes(OUR_TEAM_KEY))
    )
    .map(m => m.match_number)
    .sort((a, b) => a - b);

  const results: ChecklistAssignment[] = [];

  for (const matchNum of qualMatchNums) {
    const lookback = Math.max(1, matchNum - 4);
    const pitScoutIds: string[] = [];
    const seen = new Set<string>();
    for (const rot of allPitRotations) {
      if (rot.isElims || rot.startMatch == null || rot.endMatch == null) continue;
      if (lookback >= rot.startMatch && lookback <= rot.endMatch) {
        for (const sid of rot.scoutIds) {
          if (!seen.has(sid)) { seen.add(sid); pitScoutIds.push(sid); }
        }
      }
    }
    if (pitScoutIds.length === 0) continue;

    for (let i = 0; i < templates.length; i++) {
      const tpl = templates[i];
      const assignedTo = pitScoutIds[i % pitScoutIds.length];
      if (assignedTo !== myUserId) continue; // only mine
      results.push({
        matchNumber: matchNum,
        templateId: tpl._id,
        templateName: tpl.name,
        isCompleted: completedSet.has(`${matchNum}-${tpl._id}`),
      });
    }
  }
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchSortKey(m: TBAMatch) {
  const lvl: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
  return (lvl[m.comp_level] ?? 99) * 1_000_000 + m.set_number * 10_000 + m.match_number;
}

function formatTime(m: TBAMatch): string | null {
  const ts = m.predicted_time ?? m.time;
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Given a TBAMatch and a Position, returns the team number (e.g. 4099) or null. */
function teamNumberForPosition(match: TBAMatch, position: Position): number | null {
  const alliance = position.startsWith("red") ? "red" : "blue";
  const idx = parseInt(position.slice(-1), 10) - 1; // red1→0, blue3→2
  const key = match.alliances[alliance]?.team_keys?.[idx];
  if (!key) return null;
  const num = parseInt(key.replace("frc", ""), 10);
  return isNaN(num) ? null : num;
}

// ── Checklist card ────────────────────────────────────────────────────────────

function ChecklistCard({ assignment }: { assignment: ChecklistAssignment }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
        borderRadius: 12,
        background: SURFACE,
        border: `1px solid ${SURF_BORD}`,
        transition: "transform 0.1s ease", cursor: "default",
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      {/* Icon */}
      <div style={{
        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
        background: assignment.isCompleted ? G : G_DIM,
        border: `1.5px solid ${assignment.isCompleted ? G_STR : G_MED}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: assignment.isCompleted ? `0 2px 10px ${G} / 35%` : "none",
      }}>
        {assignment.isCompleted
          ? <CheckCircle2 size={16} color={G_TXT} />
          : <ClipboardCheck size={16} style={{ color: G }} />}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: FG, letterSpacing: "-0.01em",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {assignment.templateName}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
          For Match {assignment.matchNumber}
          {" · "}
          <span style={{ color: assignment.isCompleted ? G : MUTED, fontWeight: assignment.isCompleted ? 700 : 400 }}>
            {assignment.isCompleted ? "Done" : "Pending"}
          </span>
        </div>
      </div>

      {/* Match badge */}
      <div style={{ padding: "3px 10px", borderRadius: 8, flexShrink: 0,
        background: G_DIM, border: `1px solid ${G_MED}` }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: G, textTransform: "uppercase", letterSpacing: "0.06em", lineHeight: 1 }}>Match</div>
        <div style={{ fontSize: 18, fontWeight: 900, color: G, lineHeight: 1.1, letterSpacing: "-0.02em", textAlign: "center" }}>
          {assignment.matchNumber}
        </div>
      </div>


    </div>
  );
}

// ── Unified schedule item type ────────────────────────────────────────────────

type UnifiedItem =
  | { kind: "scout";    assignment: MatchAssignment;    match: TBAMatch | null; sortKey: number; ts: number | null }
  | { kind: "checklist"; assignment: ChecklistAssignment; sortKey: number; ts: number | null }
  | { kind: "pit";      rotation: PitRotation;           sortKey: number; ts: number | null }
  | { kind: "elims";    rotation: PitRotation;           sortKey: number; ts: number | null };

// ── Pre-competition pit scouting card ─────────────────────────────────────────

const PS_COLOR  = "oklch(0.80 0.15 75)";
// amber/warm gold, distinct from match-pit gold
const PS_DIM    = "oklch(0.80 0.15 75 / 10%)";
const PS_MED    = "oklch(0.80 0.15 75 / 28%)";
const PS_STR    = "oklch(0.80 0.15 75 / 50%)";
const PS_TXT    = "oklch(0.12 0 0)";

function PreCompetitionCard({
  assignments, allUsers,
}: {
  assignments: PitScoutingAssignment[];
  allUsers: { _id: string; name?: string; email?: string; image?: string }[];
}) {
  const userMap = Object.fromEntries(allUsers.map(u => [u._id, u]));
  const getFirst = (u: { name?: string; email?: string } | undefined) => {
    const n = u?.name ?? u?.email ?? "?";
    return n.split(" ")[0] ?? n.slice(0, 8);
  };

  // All unique teammate IDs across all assigned teams
  const teammateIds = [...new Set(assignments.flatMap(a => a.scoutIds))];
  // All team numbers sorted
  const teamNums = [...assignments.map(a => a.teamNumber)].sort((a, b) => a - b);

  return (
    <div
      style={{
        borderRadius: 16, overflow: "hidden",
        background: PS_DIM,
        border: `1.5px solid ${PS_STR}`,
        boxShadow: `0 4px 20px ${PS_COLOR} / 15%`,
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 16px",
        borderBottom: `1px solid ${PS_MED}`,
        background: `linear-gradient(135deg, ${PS_DIM} 0%, oklch(0.75 0.18 85 / 12%) 100%)`,
      }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, background: PS_COLOR, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 3px 12px ${PS_COLOR} / 40%`,
        }}>
          <ClipboardList size={18} color={PS_TXT} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: FG, letterSpacing: "-0.01em", lineHeight: 1.2 }}>
            Pit Scouting
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            {teamNums.length} team{teamNums.length !== 1 ? "s" : ""} assigned to you
          </div>
        </div>
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          padding: "5px 12px", borderRadius: 10,
          background: PS_MED, border: `1px solid ${PS_STR}`,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.07em", color: PS_COLOR, lineHeight: 1 }}>Pit</span>
          <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.07em", color: PS_COLOR, lineHeight: 1 }}>Scout</span>
        </div>
      </div>

      {/* Body: team numbers */}
      <div style={{ padding: "12px 16px" }}>
        <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em", color: PS_COLOR, marginBottom: 8 }}>
          Your teams
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 }}>
          {teamNums.map(num => (
            <span key={num} style={{
              display: "inline-flex", alignItems: "center",
              padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: 800,
              background: PS_COLOR, color: PS_TXT,
              boxShadow: `0 1px 6px ${PS_COLOR} / 25%`,
              letterSpacing: "-0.01em",
            }}>
              {num}
            </span>
          ))}
        </div>

        {/* Teammates */}
        {teammateIds.length > 0 && (
          <>
            <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em", color: PS_COLOR, marginBottom: 6 }}>
              Your team
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {teammateIds.map(id => {
                const u = userMap[id];
                return (
                  <span key={id} style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                    background: PS_MED, border: `1px solid ${PS_STR}`,
                    color: PS_COLOR,
                  }}>
                    {u?.image && (
                      <img src={u.image} alt="" style={{ width: 13, height: 13, borderRadius: "50%", objectFit: "cover" }} />
                    )}
                    {getFirst(u)}
                  </span>
                );
              })}
            </div>
          </>
        )}

        <div style={{ marginTop: 10, fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          Visit each assigned team's pit <strong>before quals start</strong> and fill out the Pit Scouting form.
        </div>
      </div>
    </div>
  );
}

function formatDay(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });
}

function localDateKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ── Scouting match card ───────────────────────────────────────────────────────

function ScoutingCard({ assignment, match }: { assignment: MatchAssignment; match: TBAMatch | null }) {
  const time = match ? formatTime(match) : null;
  const isRed = assignment.position.startsWith("red");
  const allianceColor = isRed ? "oklch(0.62 0.22 25)" : "oklch(0.55 0.22 255)";
  const allianceBg    = isRed ? "oklch(0.62 0.22 25 / 14%)" : "oklch(0.55 0.22 255 / 14%)";
  const allianceBord  = isRed ? "oklch(0.62 0.22 25 / 35%)" : "oklch(0.55 0.22 255 / 35%)";
  const teamNumber = match ? teamNumberForPosition(match, assignment.position) : null;

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
        borderRadius: 12, background: SURFACE, border: `1px solid ${SURF_BORD}`,
        transition: "transform 0.1s ease", cursor: "default",
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      {/* Alliance color stripe */}
      <div style={{
        width: 4, height: 44, borderRadius: 3, flexShrink: 0,
        background: allianceColor,
        boxShadow: `0 0 8px ${allianceColor} / 60%`,
      }} />

      {/* Match label + position */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: FG, fontFamily: "monospace", letterSpacing: "-0.01em" }}>
          {assignment.matchLabel}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
          {POS_LABEL[assignment.position]}{time ? ` · ${time}` : ""}
        </div>
      </div>

      {/* Team number — pulled from TBA */}
      <div style={{ flexShrink: 0, width: 72 }}>
        {teamNumber !== null ? (
          <div style={{
            background: allianceBg,
            border: `1.5px solid ${allianceBord}`,
            borderRadius: 10,
            padding: "5px 0",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            width: "100%",
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: allianceColor, lineHeight: 1 }}>
              Team
            </span>
            <span style={{ fontSize: 20, fontWeight: 900, color: allianceColor, lineHeight: 1.1, letterSpacing: "-0.02em" }}>
              {teamNumber}
            </span>
          </div>
        ) : (
          <span style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "4px 0", borderRadius: 8, width: "100%",
            background: G, color: G_TXT, fontSize: 12, fontWeight: 700,
            border: `1px solid ${G_STR}`,
            boxShadow: `0 2px 8px ${G} / 30%`,
          }}>
            {POS_LABEL[assignment.position]}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Elims pit card ─────────────────────────────────────────────────────────────

function ElimsCard() {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
        borderRadius: 12, background: G_DIM, border: `1.5px solid ${G_STR}`,
        transition: "transform 0.1s ease", cursor: "default",
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
        background: G, display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: `0 2px 10px ${G} / 40%`,
      }}>
        <Wrench size={16} color={G_TXT} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: FG }}>Playoffs</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>QF, SF & Finals</div>
      </div>
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "4px 11px", borderRadius: 8,
        background: G, color: G_TXT, fontSize: 12, fontWeight: 700,
        border: `1px solid ${G_STR}`, flexShrink: 0,
        boxShadow: `0 2px 8px ${G} / 30%`,
      }}>
        <Wrench size={11} />
        Elims Pit Duty
      </span>
    </div>
  );
}

// ── Qual pit rotation card ─────────────────────────────────────────────────────

function QualPitCard({ rotation }: { rotation: PitRotation }) {
  const span = (rotation.startMatch != null && rotation.endMatch != null)
    ? rotation.endMatch - rotation.startMatch + 1 : null;
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
        borderRadius: 12, background: SURFACE, border: `1px solid ${SURF_BORD}`,
        transition: "transform 0.1s ease", cursor: "default",
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
        background: G_DIM, border: `1px solid ${G_MED}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Wrench size={16} style={{ color: G }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: FG, fontFamily: "monospace" }}>
          Q{rotation.startMatch} – Q{rotation.endMatch}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
          {rotation.label ? `${rotation.label} · ` : ""}{span} match{span !== 1 ? "es" : ""}
        </div>
      </div>
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "4px 11px", borderRadius: 8,
        background: G_DIM, color: G, fontSize: 12, fontWeight: 700,
        border: `1px solid ${G_MED}`, flexShrink: 0,
      }}>
        <Wrench size={11} />
        Pit Duty
      </span>
    </div>
  );
}


// ── Preferences Panel ────────────────────────────────────────────────────────

interface UserRecord { _id: string; name?: string; email?: string; image?: string; }
interface ScoutPrefs { preferredPartners: string[]; wantsMoreMatches: boolean; wantsPitRotation: boolean; wantsPitScouting?: boolean; }

function displayName(u: UserRecord) { return u.name ?? u.email ?? "Scout"; }
function avatarLetter(u: UserRecord) { return displayName(u).charAt(0).toUpperCase(); }

function MiniAvatar({ user, size = 24 }: { user: UserRecord; size?: number }) {
  if (user.image) {
    return <img src={user.image} alt={displayName(user)} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: "linear-gradient(135deg, oklch(0.85 0.18 95 / 90%) 0%, oklch(0.75 0.20 80 / 90%) 100%)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.42, fontWeight: 800, color: "oklch(0.1 0 0)",
    }}>
      {avatarLetter(user)}
    </div>
  );
}

function Toggle({ on, onToggle, label, sub }: { on: boolean; onToggle: () => void; label: string; sub: string }) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "13px 15px", borderRadius: 13, width: "100%", textAlign: "left", cursor: "pointer",
        background: on ? G_DIM : SURFACE,
        border: `1.5px solid ${on ? G_STR : SURF_BORD}`,
        transition: "all 0.18s ease",
        outline: "none",
      }}
    >
      {/* Track */}
      <div style={{
        width: 40, height: 22, borderRadius: 11, flexShrink: 0,
        background: on ? G : "oklch(1 0 0 / 12%)",
        border: `1.5px solid ${on ? G_STR : "oklch(1 0 0 / 18%)"}`,
        position: "relative", transition: "background 0.18s ease, border-color 0.18s ease",
      }}>
        <div style={{
          position: "absolute", top: 2, left: on ? 20 : 2,
          width: 14, height: 14, borderRadius: "50%",
          background: on ? G_TXT : "oklch(0.6 0 0)",
          transition: "left 0.18s ease, background 0.18s ease",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
        }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: FG }}>{label}</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>{sub}</div>
      </div>
    </button>
  );
}

function PartnerPicker({
  allUsers, selfId, selected, onChange,
}: {
  allUsers: UserRecord[];
  selfId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const scouts = allUsers.filter(u => u._id !== selfId);

  function toggle(id: string) {
    if (selected.includes(id)) {
      onChange(selected.filter(x => x !== id));
    } else {
      if (selected.length >= 3) return;
      onChange([...selected, id]);
    }
  }

  if (scouts.length === 0) {
    return (
      <div style={{ padding: "18px 0", textAlign: "center", fontSize: 13, color: MUTED }}>
        No other scouts found
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {scouts.map(u => {
        const isSelected = selected.includes(u._id);
        const atLimit = selected.length >= 3 && !isSelected;
        return (
          <button
            key={u._id}
            onClick={() => toggle(u._id)}
            disabled={atLimit}
            style={{
              display: "flex", alignItems: "center", gap: 11,
              padding: "9px 12px", borderRadius: 11, width: "100%",
              textAlign: "left", cursor: atLimit ? "not-allowed" : "pointer",
              outline: "none",
              background: isSelected ? G_DIM : SURFACE,
              border: `1.5px solid ${isSelected ? G_STR : SURF_BORD}`,
              opacity: atLimit ? 0.4 : 1,
              transition: "all 0.15s ease",
            }}
            onMouseEnter={e => {
              if (!atLimit && !isSelected)
                (e.currentTarget as HTMLButtonElement).style.background = "oklch(1 0 0 / 5%)";
            }}
            onMouseLeave={e => {
              if (!isSelected)
                (e.currentTarget as HTMLButtonElement).style.background = isSelected ? G_DIM : SURFACE;
            }}
          >
            <MiniAvatar user={u} size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontWeight: 600, fontSize: 13, color: FG,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {displayName(u)}
              </div>
              {u.email && u.name && (
                <div style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {u.email}
                </div>
              )}
            </div>
            {/* Checkmark */}
            <div style={{
              width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
              background: isSelected ? G : "oklch(1 0 0 / 8%)",
              border: `1.5px solid ${isSelected ? G_STR : "oklch(1 0 0 / 15%)"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.15s ease",
            }}>
              {isSelected && (
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1 4L3.5 6.5L9 1" stroke="oklch(0.1 0 0)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PreferencesPanel({
  eventKey, selfId, allUsers, existingPrefs,
}: {
  eventKey: string;
  selfId: string;
  allUsers: UserRecord[];
  existingPrefs: ScoutPrefs | null;
}) {
  const upsert = useMutation(api.schedules.upsertMyPreferences);
  const [partners, setPartners] = useState<string[]>(existingPrefs?.preferredPartners ?? []);
  const [wantsMore, setWantsMore] = useState(existingPrefs?.wantsMoreMatches ?? false);
  const [wantsPit, setWantsPit] = useState(existingPrefs?.wantsPitRotation ?? false);
  const [wantsPitScouting, setWantsPitScouting] = useState(existingPrefs?.wantsPitScouting ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(!!existingPrefs);

  const dirty = useMemo(() => {
    if (!existingPrefs) return partners.length > 0 || wantsMore || wantsPit || wantsPitScouting;
    return (
      JSON.stringify(partners) !== JSON.stringify(existingPrefs.preferredPartners) ||
      wantsMore !== existingPrefs.wantsMoreMatches ||
      wantsPit !== existingPrefs.wantsPitRotation ||
      wantsPitScouting !== (existingPrefs.wantsPitScouting ?? false)
    );
  }, [partners, wantsMore, wantsPit, wantsPitScouting, existingPrefs]);

  async function handleSave() {
    setSaving(true);
    try {
      await upsert({ eventKey, preferredPartners: partners as any, wantsMoreMatches: wantsMore, wantsPitRotation: wantsPit, wantsPitScouting });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

      {/* Header card */}
      <div style={{
        borderRadius: 16, padding: "20px 20px 18px",
        background: G_DIM, border: `1.5px solid ${G_MED}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 11, flexShrink: 0,
            background: G, display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 4px 14px ${G} / 45%`,
          }}>
            <CalendarCheck size={20} color={G_TXT} />
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: FG, letterSpacing: "-0.01em" }}>No schedule yet</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 1 }}>Tell your admin how you'd like to be assigned</div>
          </div>
        </div>
        <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.55, margin: 0 }}>
          Your admin hasn't built your schedule yet. Fill out your preferences below and they'll be visible when the team creates assignments.
        </p>
      </div>

      {/* Partner picker */}
      <div style={{
        borderRadius: 14, overflow: "hidden",
        background: SURFACE, border: `1px solid ${SURF_BORD}`,
      }}>
        <div style={{ padding: "12px 15px", borderBottom: `1px solid ${SURF_BORD}`, display: "flex", alignItems: "center", gap: 9 }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: G_DIM, border: `1px solid ${G_MED}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Users size={13} style={{ color: G }} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: FG }}>Preferred Partners</div>
            <div style={{ fontSize: 11, color: MUTED }}>Pick up to 3 scouts you'd like to scout alongside</div>
          </div>
          <span style={{
            marginLeft: "auto", background: G_DIM, color: G,
            borderRadius: 20, padding: "2px 9px", fontSize: 11, fontWeight: 700,
            border: `1px solid ${G_MED}`, flexShrink: 0,
          }}>
            {partners.length}/3
          </span>
        </div>
        <div style={{ padding: "12px 14px 14px" }}>
          <PartnerPicker allUsers={allUsers} selfId={selfId} selected={partners} onChange={ids => { setPartners(ids); setSaved(false); }} />
        </div>
      </div>

      {/* Toggles */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Toggle
          on={wantsMore}
          onToggle={() => { setWantsMore(v => !v); setSaved(false); }}
          label="Scout more matches"
          sub="Let your admin know you're happy to take extra scouting slots"
        />
        <Toggle
          on={wantsPit}
          onToggle={() => { setWantsPit(v => !v); setSaved(false); }}
          label="Include me in pit rotations"
          sub="Opt in to pit scouting duty between matches during the event"
        />
        <Toggle
          on={wantsPitScouting}
          onToggle={() => { setWantsPitScouting(v => !v); setSaved(false); }}
          label="Include me in pre-competition pit scouting"
          sub="Visit teams' pits before quals start to collect data"
        />
      </div>

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving || (!dirty && saved)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
          padding: "13px 24px", borderRadius: 12, cursor: saving || (!dirty && saved) ? "default" : "pointer",
          background: saved && !dirty ? G_DIM : G,
          border: `1.5px solid ${saved && !dirty ? G_MED : G_STR}`,
          color: saved && !dirty ? G : G_TXT,
          fontWeight: 800, fontSize: 14, letterSpacing: "-0.01em",
          transition: "all 0.18s ease", outline: "none",
          opacity: saving ? 0.7 : 1,
          boxShadow: saved && !dirty ? "none" : `0 4px 18px ${G} / 40%`,
        }}
      >
        {saving ? (
          <><Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />Saving…</>
        ) : saved && !dirty ? (
          <><CheckCircle2 size={16} />Preferences saved</>  
        ) : (
          <>Save preferences</>
        )}
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MySchedulePage() {
  const [tbaLoading, setTbaLoading] = useState(false);

  const currentEvent   = useCached(useQuery(api.events.getCurrentEvent), "current_event");
  const eventKey       = currentEvent?.eventKey ?? "";

  const viewerLive     = useQuery(api.users.viewer);
  const viewer         = useCached(viewerLive, "viewer");

  const allUsersLive   = useQuery(api.users.listUsers) as UserRecord[] | undefined;
  const allUsers       = useCached(allUsersLive, "all_users") as UserRecord[] | undefined;

  const myAssignmentsLive = useQuery(
    api.schedules.getMyMatchAssignments,
    eventKey ? { eventKey } : "skip"
  ) as MatchAssignment[] | undefined;
  const myAssignments = useCached(myAssignmentsLive, `my_assignments_${eventKey || "none"}`) as MatchAssignment[] | undefined;

  const myPitRotationsLive = useQuery(
    api.schedules.getMyPitRotations,
    eventKey ? { eventKey } : "skip"
  ) as PitRotation[] | undefined;
  const myPitRotations = useCached(myPitRotationsLive, `my_pit_rotations_${eventKey || "none"}`) as PitRotation[] | undefined;

  // All pit rotations (needed for checklist assignment computation)
  const allPitRotationsLive = useQuery(
    api.schedules.listPitRotations,
    eventKey ? { eventKey } : "skip"
  ) as PitRotation[] | undefined;
  const allPitRotations = useCached(allPitRotationsLive, `pit_rotations_${eventKey || "none"}`) as PitRotation[] | undefined;

  // Pre-competition pit scouting assignments (one row per assigned team)
  const myPitScoutingTeamLive = useQuery(
    api.pitScouting.getMyPitScoutingTeam,
    eventKey ? { eventKey } : "skip"
  ) as PitScoutingAssignment[] | null | undefined;
  const myPitScoutingTeam = useCached(myPitScoutingTeamLive, `my_pit_scouting_team_${eventKey || "none"}`) as PitScoutingAssignment[] | null | undefined;

  // Active checklist templates
  const checklistTemplatesLive = useQuery(api.checklists.listActiveChecklistTemplates);
  const checklistTemplates = useCached(checklistTemplatesLive, "active_checklist_templates") as ChecklistTemplate[] | undefined;

  // My checklist submissions for this event
  const myChecklistSubsLive = useQuery(
    api.checklists.getMyChecklistSubmissions,
    eventKey ? { eventKey } : "skip"
  );
  const completedChecklistSet = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const sub of myChecklistSubsLive ?? []) {
      s.add(`${sub.matchNumber}-${sub.templateId}`);
    }
    return s;
  }, [myChecklistSubsLive]);

  const myPreferences  = useQuery(
    api.schedules.getMyPreferences,
    eventKey ? { eventKey } : "skip"
  );


  // Seed TBA matches from cache immediately, then refresh in background
  const [tbaMatches, setTbaMatches] = useState<TBAMatch[]>(
    () => lsGet<TBAMatch[]>(`tba_matches_full_${eventKey}`) ?? lsGetStale<TBAMatch[]>(`tba_matches_full_${eventKey}`) ?? []
  );

  useEffect(() => {
    if (!eventKey) { setTbaMatches([]); return; }
    setTbaLoading(true);
    fetchTBAEventMatches(eventKey)
      .then(data => {
        if (Array.isArray(data)) {
          const sorted = [...data].sort((a, b) => matchSortKey(a) - matchSortKey(b));
          setTbaMatches(sorted);
        }
      })
      .finally(() => setTbaLoading(false));
  }, [eventKey]);

  const myChecklistAssignments = useMemo(() => {
    const myId = (viewer as { _id?: string } | null)?._id ?? "";
    if (!myId || !checklistTemplates || !allPitRotations) return [];
    return computeMyChecklistAssignments(
      tbaMatches, allPitRotations, checklistTemplates, myId, completedChecklistSet
    );
  }, [tbaMatches, allPitRotations, checklistTemplates, viewer, completedChecklistSet]);

  const matchMap = useMemo(() => {
    const m: Record<number, TBAMatch> = {};
    // Only index qual matches — elim match numbers overlap with qual numbers
    for (const t of tbaMatches) {
      if (t.comp_level === "qm") m[t.match_number] = t;
    }
    return m;
  }, [tbaMatches]);

  const assignments = useMemo(() =>
    [...(myAssignments ?? [])].sort((a, b) => a.matchNumber - b.matchNumber),
    [myAssignments]
  );
  const pitRotations = useMemo(() =>
    [...(myPitRotations ?? [])].sort((a, b) => (a.startMatch ?? 0) - (b.startMatch ?? 0)),
    [myPitRotations]
  );

  const elimsRotation = pitRotations.find(r => r.isElims) ?? null;
  const qualRotations  = pitRotations.filter(r => !r.isElims);

  const pitMatchCount = useMemo(() => {
    const nums = new Set<number>();
    for (const rot of qualRotations) {
      if (rot.startMatch != null && rot.endMatch != null) {
        for (let n = rot.startMatch; n <= rot.endMatch; n++) nums.add(n);
      }
    }
    return nums.size;
  }, [qualRotations]);

  const totalMatches   = tbaMatches.filter(m => m.comp_level === "qm").length;
  const scoutingCount  = assignments.length;
  const checklistCount = myChecklistAssignments.length;
  const offCount       = Math.max(0, totalMatches - scoutingCount - pitMatchCount);
  const loading        = myAssignments === undefined || myPitRotations === undefined;
  const hasAnything    = scoutingCount > 0 || pitRotations.length > 0 || checklistCount > 0 || (Array.isArray(myPitScoutingTeam) && myPitScoutingTeam.length > 0);

  // ── Build unified sorted item list ──────────────────────────────────────────
  const groupedByDay = useMemo(() => {
    const items: UnifiedItem[] = [];

    // Scouting matches — sort by match number (timestamp from TBA)
    for (const a of assignments) {
      const match = matchMap[a.matchNumber] ?? null;
      const ts = match ? (match.actual_time ?? match.predicted_time ?? match.time ?? null) : null;
      items.push({ kind: "scout", assignment: a, match, sortKey: a.matchNumber, ts });
    }

    // Checklists — due at (matchNumber - 4), so sort there
    for (const a of myChecklistAssignments) {
      const dueMatchNum = Math.max(1, a.matchNumber - 4);
      const dueMatch = matchMap[dueMatchNum] ?? null;
      const ts = dueMatch ? (dueMatch.actual_time ?? dueMatch.predicted_time ?? dueMatch.time ?? null) : null;
      // sortKey offset 0.3 so checklists appear after scouting at the same match slot
      items.push({ kind: "checklist", assignment: a, sortKey: dueMatchNum + 0.3, ts });
    }

    // Qual pit rotations — sort by startMatch
    for (const rot of qualRotations) {
      const startM = rot.startMatch ?? 0;
      const startMatch = matchMap[startM] ?? null;
      const ts = startMatch ? (startMatch.actual_time ?? startMatch.predicted_time ?? startMatch.time ?? null) : null;
      items.push({ kind: "pit", rotation: rot, sortKey: startM + 0.1, ts });
    }

    // Elims — always last
    if (elimsRotation) {
      items.push({ kind: "elims", rotation: elimsRotation, sortKey: 999_999, ts: null });
    }

    // Sort: items with ts by (ts, sortKey), null-ts items by sortKey at end
    items.sort((a, b) => {
      if (a.ts !== null && b.ts !== null) {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return a.sortKey - b.sortKey;
      }
      if (a.ts !== null) return -1;
      if (b.ts !== null) return 1;
      return a.sortKey - b.sortKey;
    });

    // Group into days
    const groups: { dayLabel: string; dateKey: string; items: UnifiedItem[] }[] = [];
    const map = new Map<string, UnifiedItem[]>();
    for (const item of items) {
      const dateKey = item.ts ? localDateKey(item.ts) : "unscheduled";
      const dayLabel = item.ts ? formatDay(item.ts) : "Unscheduled";
      if (!map.has(dateKey)) {
        const bucket: UnifiedItem[] = [];
        map.set(dateKey, bucket);
        groups.push({ dayLabel, dateKey, items: bucket });
      }
      map.get(dateKey)!.push(item);
    }
    return groups;
  }, [assignments, myChecklistAssignments, qualRotations, elimsRotation, matchMap]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", gap: 20 }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, background: G, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 4px 16px ${G} / 45%`,
          }}>
            <CalendarDays size={19} color={G_TXT} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: FG, margin: 0, lineHeight: 1.2, letterSpacing: "-0.02em" }}>
              My Schedule
            </h1>
            <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>
              {currentEvent
                ? `${currentEvent.eventName ?? currentEvent.eventKey}`
                : "Set an event in Settings to see your schedule"}
            </p>
          </div>
        </div>
      </div>

      {/* ── No event ─────────────────────────────────────────────────────── */}
      {!currentEvent && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: SURFACE, border: `1.5px solid ${SURF_BORD}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CalendarDays size={28} style={{ color: MUTED }} />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: FG, marginBottom: 6 }}>No Event Selected</div>
            <div style={{ fontSize: 13, color: MUTED, maxWidth: 300 }}>Ask an admin to set the current event, then check back here.</div>
          </div>
        </div>
      )}

      {/* ── Loading ───────────────────────────────────────────────────────── */}
      {currentEvent && loading && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: MUTED }}>
          <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
          <span style={{ fontSize: 14 }}>Loading your schedule…</span>
        </div>
      )}

      {/* ── Empty → Preferences Panel ─────────────────────────────────── */}
      {currentEvent && !loading && !hasAnything && (
        <ScrollArea style={{ flex: 1 }}>
          <div style={{ paddingBottom: 24 }}>
            {viewer && allUsers ? (
              <PreferencesPanel
                eventKey={currentEvent.eventKey}
                selfId={viewer._id as string}
                allUsers={allUsers}
                existingPrefs={myPreferences
                  ? {
                      preferredPartners: (myPreferences as any).preferredPartners ?? [],
                      wantsMoreMatches:  (myPreferences as any).wantsMoreMatches  ?? false,
                      wantsPitRotation:  (myPreferences as any).wantsPitRotation  ?? false,
                    }
                  : null
                }
              />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "60px 0", gap: 10, color: MUTED }}>
                <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
                <span style={{ fontSize: 14 }}>Loading…</span>
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      {/* ── Schedule ──────────────────────────────────────────────────────── */}
      {currentEvent && !loading && hasAnything && (
        <ScrollArea style={{ flex: 1 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 24 }}>

            {/* Before Competition — pit scouting team */}
            {Array.isArray(myPitScoutingTeam) && myPitScoutingTeam.length > 0 && (
              <div>
                {/* Section label */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 10, marginBottom: 10,
                }}>
                  <div style={{
                    flex: 1, height: 1,
                    background: `linear-gradient(to right, oklch(0.80 0.15 75 / 40%), transparent)`,
                  }} />
                  <div style={{
                    display: "flex", alignItems: "center", gap: 7,
                    padding: "4px 14px", borderRadius: 20,
                    background: "oklch(0.80 0.15 75 / 10%)",
                    border: "1px solid oklch(0.80 0.15 75 / 35%)",
                  }}>
                    <ClipboardList size={11} style={{ color: "oklch(0.80 0.15 75)" }} />
                    <span style={{ fontSize: 11, fontWeight: 800, color: "oklch(0.80 0.15 75)", letterSpacing: "0.04em" }}>
                      Before Competition
                    </span>
                  </div>
                  <div style={{
                    flex: 1, height: 1,
                    background: `linear-gradient(to left, oklch(0.80 0.15 75 / 40%), transparent)`,
                  }} />
                </div>
                <PreCompetitionCard
                  assignments={myPitScoutingTeam as PitScoutingAssignment[]}
                  allUsers={allUsers ?? []}
                />
              </div>
            )}

            {/* Summary strip */}
            <div style={{ display: "flex", gap: 2, padding: 4, borderRadius: 14, background: SURFACE, border: `1px solid ${SURF_BORD}` }}>
              {([
                { label: "Scouting",   count: scoutingCount,  icon: ClipboardList  },
                { label: "Checklists", count: checklistCount, icon: ClipboardCheck },
                { label: "Pit Duty",   count: qualRotations.length + (elimsRotation ? 1 : 0), icon: Wrench },
                { label: "Off",        count: offCount,        icon: Coffee         },
              ] as const).map(({ label, count, icon: Icon }) => (
                <div key={label} style={{
                  flex: 1, display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 10px", borderRadius: 10,
                }}>
                  <Icon size={13} style={{ color: MUTED, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: FG, lineHeight: 1 }}>{count}</div>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: MUTED }}>
                      {label}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {tbaLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
                borderRadius: 10, background: G_DIM, border: `1px solid ${G_MED}`, fontSize: 12, color: G }}>
                <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                <span>Syncing match times…</span>
              </div>
            )}

            {/* ── Day-grouped sequential list ── */}
            {groupedByDay.map(({ dayLabel, dateKey, items }) => (
              <div key={dateKey}>

                {/* Day header */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 10,
                  marginBottom: 8,
                }}>
                  <div style={{
                    flex: 1, height: 1,
                    background: `linear-gradient(to right, ${G_MED}, transparent)`,
                  }} />
                  <div style={{
                    display: "flex", alignItems: "center", gap: 7,
                    padding: "4px 14px", borderRadius: 20,
                    background: G_DIM, border: `1px solid ${G_MED}`,
                  }}>
                    <CalendarDays size={11} style={{ color: G }} />
                    <span style={{ fontSize: 11, fontWeight: 800, color: G, letterSpacing: "0.04em" }}>
                      {dayLabel}
                    </span>
                    <span style={{
                      background: G_MED, color: G, borderRadius: 20,
                      padding: "0px 7px", fontSize: 10, fontWeight: 700,
                    }}>
                      {items.length}
                    </span>
                  </div>
                  <div style={{
                    flex: 1, height: 1,
                    background: `linear-gradient(to left, ${G_MED}, transparent)`,
                  }} />
                </div>

                {/* Items in this day */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {items.map((item) => {
                    if (item.kind === "scout") {
                      return (
                        <div key={item.assignment._id} style={{ position: "relative" }}>
                          {/* Type pill */}
                          <div style={{
                            position: "absolute", top: -8, left: 12, zIndex: 1,
                            padding: "1px 8px", borderRadius: 20, fontSize: 9, fontWeight: 800,
                            background: "oklch(0.62 0.22 25 / 90%)",
                            color: "white", textTransform: "uppercase", letterSpacing: "0.07em",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                          }}>
                            Scouting
                          </div>
                          <ScoutingCard assignment={item.assignment} match={item.match} />
                        </div>
                      );
                    }
                    if (item.kind === "checklist") {
                      return (
                        <div key={`cl-${item.assignment.matchNumber}-${item.assignment.templateId}`} style={{ position: "relative" }}>
                          <div style={{
                            position: "absolute", top: -8, left: 12, zIndex: 1,
                            padding: "1px 8px", borderRadius: 20, fontSize: 9, fontWeight: 800,
                            background: G,
                            color: G_TXT, textTransform: "uppercase", letterSpacing: "0.07em",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                          }}>
                            Checklist
                          </div>
                          <ChecklistCard
                            assignment={item.assignment}
                          />
                        </div>
                      );
                    }
                    if (item.kind === "pit") {
                      return (
                        <div key={item.rotation._id} style={{ position: "relative" }}>
                          <div style={{
                            position: "absolute", top: -8, left: 12, zIndex: 1,
                            padding: "1px 8px", borderRadius: 20, fontSize: 9, fontWeight: 800,
                            background: SURF_BORD,
                            color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em",
                          }}>
                            Pit Duty
                          </div>
                          <QualPitCard rotation={item.rotation} />
                        </div>
                      );
                    }
                    if (item.kind === "elims") {
                      return (
                        <div key="elims" style={{ position: "relative" }}>
                          <div style={{
                            position: "absolute", top: -8, left: 12, zIndex: 1,
                            padding: "1px 8px", borderRadius: 20, fontSize: 9, fontWeight: 800,
                            background: G, color: G_TXT, textTransform: "uppercase", letterSpacing: "0.07em",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                          }}>
                            Playoffs
                          </div>
                          <ElimsCard />
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            ))}

            {/* Off summary footer */}
            {offCount > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
                borderRadius: 12, background: SURFACE, border: `1px solid ${SURF_BORD}`,
              }}>
                <Coffee size={15} style={{ color: MUTED, flexShrink: 0 }} />
                <div style={{ fontSize: 13, color: MUTED }}>
                  <span style={{ fontWeight: 700, color: FG }}>{offCount}</span> qual match{offCount !== 1 ? "es" : ""} with no assignment
                </div>
              </div>
            )}

          </div>
        </ScrollArea>
      )}
    </div>
  );
}
