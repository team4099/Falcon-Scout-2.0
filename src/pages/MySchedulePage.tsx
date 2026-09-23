import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { useMutation } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchTBAEventMatches } from "@/lib/api";
import { lsGet, lsGetStale } from "@/lib/persistentCache";
import { getMySubmissions as getLocalSubmissions } from "@/lib/submissionStore";
import {
  buildCompletion, isMatchDone, resolvePitDutyDone, EMPTY_COMPLETION,
  type Completion, type SubmissionKey,
} from "@/lib/scheduleCompletion";
import { enqueuePitDutyOp, dequeuePitDutyOp, getPitDutyQueue } from "@/lib/offlineQueue";
import type { TBAMatch } from "@/lib/api";
import type { FormField } from "@/types";
import {
  CalendarDays, CalendarCheck, ClipboardList, Wrench, Coffee,
  Loader2, CheckCircle2, Users, ClipboardCheck, CircleDashed, Undo2,
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

// ── Checklist assignment algorithm ───────────────────────────────────────────
//
// This is the only home for it now: the standalone Checklists tab is gone and a
// checklist is an ordinary scouting form, so My Schedule is where a scout finds
// out which one is theirs and taps through to fill it in.

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
    const pitScoutIds: string[] = [];
    const seen = new Set<string>();
    for (const rot of allPitRotations) {
      if (rot.isElims || rot.startMatch == null || rot.endMatch == null) continue;
      // The match itself must fall inside the rotation window. This used to test
      // `matchNum - 4`, which handed the checklist to whoever was on pit duty
      // four matches earlier — someone rostered for 30-35 was getting checklists
      // for matches 36-39, after their shift had ended.
      if (matchNum >= rot.startMatch && matchNum <= rot.endMatch) {
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

// Must use the same precedence as the sort key below (actual first), or a
// played match sorts by when it actually ran while displaying its stale
// predicted time — which showed Q17 at 1:52 PM sitting below Q16 at 1:56 PM.
function formatTime(m: TBAMatch): string | null {
  const ts = m.actual_time ?? m.predicted_time ?? m.time;
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
  const navigate = useNavigate();
  function open() {
    // Checklists are ordinary scouting forms — same page, same submit path.
    // `template=` names the exact checklist, since several can be active.
    navigate(
      `/scout?match=${assignment.matchNumber}&prefix=qm&form=checklist&template=${assignment.templateId}`
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      title={`Open ${assignment.templateName} for match ${assignment.matchNumber}`}
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
        borderRadius: 12,
        background: SURFACE,
        border: `1px solid ${SURF_BORD}`,
        transition: "transform 0.1s ease", cursor: "pointer",
        opacity: assignment.isCompleted ? 0.62 : 1,
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

// `done` drives the Upcoming/Completed split. Scouting, checklists and pit
// scouting complete on submission; pit duty and playoff shifts have no form
// behind them, so they complete when the scout reports for the shift.
type UnifiedItem =
  | { kind: "scout";    assignment: MatchAssignment;    match: TBAMatch | null; sortKey: number; ts: number | null; done: boolean }
  | { kind: "checklist"; assignment: ChecklistAssignment; sortKey: number; ts: number | null; done: boolean }
  | { kind: "pit";      rotation: PitRotation;           sortKey: number; ts: number | null; done: boolean }
  | { kind: "elims";    rotation: PitRotation;           sortKey: number; ts: number | null; done: boolean };

// ── Pre-competition pit scouting card ─────────────────────────────────────────

const PS_COLOR  = "oklch(0.80 0.15 75)";
// amber/warm gold, distinct from match-pit gold
const PS_DIM    = "oklch(0.80 0.15 75 / 10%)";
const PS_MED    = "oklch(0.80 0.15 75 / 28%)";
const PS_STR    = "oklch(0.80 0.15 75 / 50%)";
const PS_TXT    = "oklch(0.12 0 0)";

function PreCompetitionCard({
  assignments, allUsers, done = false,
}: {
  assignments: PitScoutingAssignment[];
  allUsers: { _id: string; name?: string; email?: string; image?: string }[];
  /** Rendered in the Completed tab — these teams have already been pit scouted. */
  done?: boolean;
}) {
  const navigate = useNavigate();
  const userMap = Object.fromEntries(allUsers.map(u => [u._id, u]));
  const getName = (u: { name?: string; email?: string } | undefined) =>
    u?.name ?? u?.email ?? "?";

  // All unique teammate IDs across all assigned teams
  const teammateIds = [...new Set(assignments.flatMap(a => a.scoutIds))];
  // All team numbers sorted
  const teamNums = [...assignments.map(a => a.teamNumber)].sort((a, b) => a - b);

  return (
    <div
      style={{
        borderRadius: 16, overflow: "hidden",
        background: PS_DIM,
        border: `1.5px solid ${done ? PS_MED : PS_STR}`,
        boxShadow: done ? "none" : `0 4px 20px ${PS_COLOR} / 15%`,
        opacity: done ? 0.75 : 1,
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
          {done ? <CheckCircle2 size={18} color={PS_TXT} /> : <ClipboardList size={18} color={PS_TXT} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: FG, letterSpacing: "-0.01em", lineHeight: 1.2 }}>
            Pit Scouting
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            {done
              ? `${teamNums.length} team${teamNums.length !== 1 ? "s" : ""} pit scouted`
              : `${teamNums.length} team${teamNums.length !== 1 ? "s" : ""} assigned to you`}
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
            // Tapping a team opens the active Pit Scout form with that team
            // already entered, same as the match cards do for match scouting.
            <button
              key={num}
              type="button"
              onClick={() => navigate(`/scout?form=pit&team=${num}`)}
              title={`Pit scout team ${num}`}
              style={{
                display: "inline-flex", alignItems: "center",
                padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: 800,
                background: PS_COLOR, color: PS_TXT,
                boxShadow: `0 1px 6px ${PS_COLOR} / 25%`,
                letterSpacing: "-0.01em",
                border: "none", cursor: "pointer", fontFamily: "inherit",
              }}
            >
              {num}
            </button>
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
                      <img src={u.image} alt="" referrerPolicy="no-referrer" style={{ width: 13, height: 13, borderRadius: "50%", objectFit: "cover" }} />
                    )}
                    {getName(u)}
                  </span>
                );
              })}
            </div>
          </>
        )}

        <div style={{ marginTop: 10, fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          {done
            ? <>You've submitted a Pit Scouting form for {teamNums.length === 1 ? "this team" : "these teams"}. Tap a team number to submit again.</>
            : <>Visit each assigned team's pit <strong>before quals start</strong>. Tap a team number to open the Pit Scouting form for it.</>}
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

interface DayGroup { dayLabel: string; dateKey: string; items: UnifiedItem[] }

/** Buckets an already-sorted item list into day sections, preserving order. */
function groupByDay(items: UnifiedItem[]): DayGroup[] {
  const groups: DayGroup[] = [];
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
}

function localDateKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ── Scouting match card ───────────────────────────────────────────────────────

function ScoutingCard({ assignment, match, done = false }: { assignment: MatchAssignment; match: TBAMatch | null; done?: boolean }) {
  const navigate = useNavigate();
  const time = match ? formatTime(match) : null;
  const isRed = assignment.position.startsWith("red");
  const allianceColor = isRed ? "oklch(0.62 0.22 25)" : "oklch(0.55 0.22 255)";
  const allianceBg    = isRed ? "oklch(0.62 0.22 25 / 14%)" : "oklch(0.55 0.22 255 / 14%)";
  const allianceBord  = isRed ? "oklch(0.62 0.22 25 / 35%)" : "oklch(0.55 0.22 255 / 35%)";
  const teamNumber = match ? teamNumberForPosition(match, assignment.position) : null;

  // Tapping the card opens the match scouting form itself — not the form picker
  // — with match, comp level and team already filled in. The whole point of the
  // tab is to remove that typing. The scout is identified server-side from the
  // signed-in user, so there is no name to pass.
  const prefix = match && match.comp_level !== "qm" ? "elim" : "qm";
  function open() {
    const q = new URLSearchParams({
      match: String(assignment.matchNumber),
      prefix,
      form: "default",
    });
    if (teamNumber) q.set("team", String(teamNumber));
    navigate(`/scout?${q.toString()}`);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      title={`Scout ${assignment.matchLabel}${teamNumber ? ` · team ${teamNumber}` : ""}`}
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
        borderRadius: 12, background: SURFACE, border: `1px solid ${SURF_BORD}`,
        transition: "transform 0.1s ease", cursor: "pointer",
        opacity: done ? 0.62 : 1,
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      {/* Alliance color stripe — replaced by a tick once the form is in */}
      {done ? (
        <CheckCircle2 size={20} style={{ color: G, flexShrink: 0 }} />
      ) : (
        <div style={{
          width: 4, height: 44, borderRadius: 3, flexShrink: 0,
          background: allianceColor,
          boxShadow: `0 0 8px ${allianceColor} / 60%`,
        }} />
      )}

      {/* Match label + position */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: FG, fontFamily: "monospace", letterSpacing: "-0.01em" }}>
          {assignment.matchLabel}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
          {POS_LABEL[assignment.position]}{time ? ` · ${time}` : ""}
          {done && (
            <>
              {" · "}
              <span style={{ color: G, fontWeight: 700 }}>Done</span>
            </>
          )}
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

function ElimsCard({ done, onToggle }: { done: boolean; onToggle: () => void }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
        borderRadius: 12, background: G_DIM, border: `1.5px solid ${done ? G_MED : G_STR}`,
        transition: "transform 0.1s ease", cursor: "default",
        opacity: done ? 0.72 : 1,
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
        background: G, display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: `0 2px 10px ${G} / 40%`,
      }}>
        {done ? <CheckCircle2 size={16} color={G_TXT} /> : <Wrench size={16} color={G_TXT} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: FG }}>Playoffs</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
          QF, SF &amp; Finals{done ? " · Reported" : ""}
        </div>
      </div>
      <ReportPitDutyButton done={done} onToggle={onToggle} />
    </div>
  );
}

// ── Report-for-duty button ────────────────────────────────────────────────────
//
// Pit duty is the one assignment with no form behind it, so this tap is the
// only thing that can move it out of Upcoming. It stays undoable — a mis-tap
// on a phone between matches must not strand a shift in the wrong tab.

function ReportPitDutyButton({ done, onToggle }: { done: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={done ? "Undo — move this shift back to Upcoming" : "Report that you're on pit duty for this shift"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "7px 13px", borderRadius: 9, flexShrink: 0,
        background: done ? "transparent" : G,
        color: done ? MUTED : G_TXT,
        border: `1.5px solid ${done ? SURF_BORD : G_STR}`,
        fontSize: 12, fontWeight: 800, fontFamily: "inherit",
        cursor: "pointer", outline: "none",
        boxShadow: done ? "none" : `0 2px 8px ${G} / 30%`,
        transition: "background 0.15s ease, color 0.15s ease",
      }}
    >
      {done ? <><Undo2 size={12} />Undo</> : <><Wrench size={12} />Report to pit duty</>}
    </button>
  );
}

// ── Qual pit rotation card ─────────────────────────────────────────────────────

function QualPitCard({ rotation, done, onToggle }: { rotation: PitRotation; done: boolean; onToggle: () => void }) {
  const span = (rotation.startMatch != null && rotation.endMatch != null)
    ? rotation.endMatch - rotation.startMatch + 1 : null;
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
        borderRadius: 12, background: SURFACE, border: `1px solid ${SURF_BORD}`,
        transition: "transform 0.1s ease", cursor: "default",
        opacity: done ? 0.72 : 1,
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
        background: G_DIM, border: `1px solid ${G_MED}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {done ? <CheckCircle2 size={16} style={{ color: G }} /> : <Wrench size={16} style={{ color: G }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: FG, fontFamily: "monospace" }}>
          Q{rotation.startMatch} – Q{rotation.endMatch}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
          {rotation.label ? `${rotation.label} · ` : ""}{span} match{span !== 1 ? "es" : ""}
          {done && <span style={{ color: G, fontWeight: 700 }}> · Reported</span>}
        </div>
      </div>
      <ReportPitDutyButton done={done} onToggle={onToggle} />
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
    return <img src={user.image} alt={displayName(user)} referrerPolicy="no-referrer" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
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
  const scouts = allUsers
    .filter(u => u._id !== selfId)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));

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
  const [tab, setTab] = useState<"upcoming" | "completed">("upcoming");

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

  // Active checklist templates. Checklists are ordinary form templates now, so
  // they come from the same query every other form uses and are filtered here
  // rather than needing a checklist-specific endpoint.
  const activeTemplatesLive = useQuery(api.forms.listActiveTemplates);
  const activeTemplates = useCached(activeTemplatesLive, "active_templates") as
    | (ChecklistTemplate & { formType?: string })[]
    | undefined;
  const checklistTemplates = useMemo<ChecklistTemplate[] | undefined>(
    () => activeTemplates?.filter((t) => t.formType === "checklist"),
    [activeTemplates]
  );

  // My submissions for this event — a checklist counts as done once this scout
  // has a submission for that match against that checklist template.
  const mySubmissionsLive = useQuery(
    api.forms.getMySubmissions,
    eventKey ? { eventKey } : "skip"
  );
  const mySubmissions = useCached(mySubmissionsLive, `my_submissions_${eventKey || "none"}`);

  // localStorage is outside React, so nothing re-renders when it changes. This
  // counter is the signal: bump it when the tab regains focus (the scout has
  // just come back from a form) and the reads below re-run.
  const [storeRev, setStoreRev] = useState(0);
  useEffect(() => {
    const bump = () => setStoreRev(r => r + 1);
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", bump);
    return () => {
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", bump);
    };
  }, []);

  // Locally stored submissions cover the offline case — they are written before
  // the network call, so an assignment ticks off the moment the scout submits
  // even with no uplink. Re-read on focus, and whenever the server list changes.
  const localSubs = useMemo(
    () => getLocalSubmissions(),
    // mySubmissions is an invalidation key, not an input: a server round-trip
    // means the local store may have been drained.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeRev, mySubmissions]
  );

  const completion = useMemo<Completion>(() => {
    if (!eventKey) return EMPTY_COMPLETION;
    // Local rows carry no formType, so resolve it from the active templates.
    const typeById = new Map<string, string>(
      (activeTemplates ?? []).map((t) => [t._id, t.formType ?? "default"])
    );
    const keys: SubmissionKey[] = [];
    for (const sub of (mySubmissions ?? []) as SubmissionKey[]) keys.push(sub);
    for (const sub of localSubs) {
      if (sub.eventKey !== eventKey) continue;
      keys.push({
        formType: typeById.get(sub.templateId) ?? "default",
        matchNumber: sub.matchNumber,
        compLevel: sub.compLevel,
        teamNumber: sub.teamNumber,
        templateId: sub.templateId,
      });
    }
    return buildCompletion(keys);
  }, [mySubmissions, localSubs, activeTemplates, eventKey]);

  const completedChecklistSet = completion.checklists;

  // ── Pit duty check-ins ──────────────────────────────────────────────────────
  const reportPitDuty   = useMutation(api.schedules.reportPitDuty);
  const unreportPitDuty = useMutation(api.schedules.unreportPitDuty);

  const myPitCheckInsLive = useQuery(
    api.schedules.getMyPitDutyCheckIns,
    eventKey ? { eventKey } : "skip"
  ) as { rotationId: string; reportedAt: number }[] | undefined;
  const myPitCheckIns = useCached(myPitCheckInsLive, `my_pit_checkins_${eventKey || "none"}`) as
    | { rotationId: string; reportedAt: number }[]
    | undefined;

  // Anything still queued for sync counts straight away, so reporting for duty
  // works with no uplink — the queue is drained by useOfflineSync. `localRev`
  // is bumped by a tap so the card flips without waiting for the server.
  const [localRev, setLocalRev] = useState(0);
  const pendingPitOps = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => getPitDutyQueue(), [storeRev, localRev, myPitCheckIns]
  );

  const pitDutyDone = useMemo(
    () => resolvePitDutyDone((myPitCheckIns ?? []).map(c => c.rotationId), pendingPitOps),
    [myPitCheckIns, pendingPitOps]
  );

  const togglePitDuty = useCallback((rotationId: string, nextReported: boolean) => {
    if (!eventKey) return;
    // Queue first, then fire. If the mutation succeeds the entry is dropped
    // immediately; if it throws (offline, or a flaky venue network) the entry
    // stays and useOfflineSync retries it, so the tap is never silently lost.
    const opId = enqueuePitDutyOp({ eventKey, rotationId, reported: nextReported });
    setLocalRev(r => r + 1);
    const call = nextReported
      ? reportPitDuty({ eventKey, rotationId: rotationId as Id<"pitRotations"> })
      : unreportPitDuty({ rotationId: rotationId as Id<"pitRotations"> });
    void call
      .then(() => { dequeuePitDutyOp(opId); })
      .catch(() => { /* stays queued for useOfflineSync */ })
      .finally(() => setLocalRev(r => r + 1));
  }, [eventKey, reportPitDuty, unreportPitDuty]);

  const myPreferences = useCached(
    useQuery(
      api.schedules.getMyPreferences,
      eventKey ? { eventKey } : "skip"
    ),
    `my_preferences_${eventKey || "none"}`
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

  // ── Build unified sorted item list, split upcoming vs completed ────────────
  const { upcomingDays, completedDays, upcomingCount, completedCount } = useMemo(() => {
    const items: UnifiedItem[] = [];

    // Scouting matches — sort by match number (timestamp from TBA)
    for (const a of assignments) {
      const match = matchMap[a.matchNumber] ?? null;
      const ts = match ? (match.actual_time ?? match.predicted_time ?? match.time ?? null) : null;
      // matchMap only holds quals, so a resolved match is always "qm".
      const compLevel: "qm" | "elim" = match && match.comp_level !== "qm" ? "elim" : "qm";
      const teamNumber = match ? teamNumberForPosition(match, a.position) : null;
      items.push({
        kind: "scout", assignment: a, match, sortKey: a.matchNumber, ts,
        done: isMatchDone(completion, a.matchNumber, compLevel, teamNumber),
      });
    }

    // Checklists — due at (matchNumber - 4), so sort there
    for (const a of myChecklistAssignments) {
      const dueMatchNum = Math.max(1, a.matchNumber - 4);
      const dueMatch = matchMap[dueMatchNum] ?? null;
      const ts = dueMatch ? (dueMatch.actual_time ?? dueMatch.predicted_time ?? dueMatch.time ?? null) : null;
      // sortKey offset 0.3 so checklists appear after scouting at the same match slot
      items.push({ kind: "checklist", assignment: a, sortKey: dueMatchNum + 0.3, ts, done: a.isCompleted });
    }

    // Qual pit rotations — sort by startMatch
    for (const rot of qualRotations) {
      const startM = rot.startMatch ?? 0;
      const startMatch = matchMap[startM] ?? null;
      const ts = startMatch ? (startMatch.actual_time ?? startMatch.predicted_time ?? startMatch.time ?? null) : null;
      items.push({ kind: "pit", rotation: rot, sortKey: startM + 0.1, ts, done: pitDutyDone.has(rot._id) });
    }

    // Elims — always last
    if (elimsRotation) {
      items.push({ kind: "elims", rotation: elimsRotation, sortKey: 999_999, ts: null, done: pitDutyDone.has(elimsRotation._id) });
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

    const upcoming = items.filter(i => !i.done);
    const completed = items.filter(i => i.done);
    return {
      upcomingDays: groupByDay(upcoming),
      completedDays: groupByDay(completed),
      upcomingCount: upcoming.length,
      completedCount: completed.length,
    };
  }, [assignments, myChecklistAssignments, qualRotations, elimsRotation, matchMap, completion, pitDutyDone]);

  // Pre-competition pit scouting splits per team, same as everything else.
  const pitScoutingTeams = Array.isArray(myPitScoutingTeam) ? myPitScoutingTeam : [];
  const pitScoutingTodo = pitScoutingTeams.filter(a => !completion.pitTeams.has(a.teamNumber));
  const pitScoutingDone = pitScoutingTeams.filter(a => completion.pitTeams.has(a.teamNumber));

  const shownDays      = tab === "upcoming" ? upcomingDays : completedDays;
  const shownPitScout  = tab === "upcoming" ? pitScoutingTodo : pitScoutingDone;
  const tabTotal       = (tab === "upcoming" ? upcomingCount : completedCount) + shownPitScout.length;

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
              My Assignments
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
                      wantsPitScouting:  (myPreferences as any).wantsPitScouting  ?? false,
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

            {/* Upcoming / Completed toggle */}
            <div style={{ display: "flex", gap: 4, padding: 4, borderRadius: 14, background: SURFACE, border: `1px solid ${SURF_BORD}` }}>
              {([
                { id: "upcoming"  as const, label: "Upcoming",  count: upcomingCount + pitScoutingTodo.length, icon: CircleDashed },
                { id: "completed" as const, label: "Completed", count: completedCount + pitScoutingDone.length, icon: CheckCircle2 },
              ]).map(({ id, label, count, icon: Icon }) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    aria-pressed={active}
                    style={{
                      flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                      padding: "10px 12px", borderRadius: 10, cursor: "pointer",
                      background: active ? G : "transparent",
                      border: `1.5px solid ${active ? G_STR : "transparent"}`,
                      color: active ? G_TXT : MUTED,
                      fontWeight: 800, fontSize: 13, fontFamily: "inherit",
                      letterSpacing: "-0.01em", outline: "none",
                      transition: "background 0.15s ease, color 0.15s ease",
                    }}
                  >
                    <Icon size={14} />
                    {label}
                    <span style={{
                      borderRadius: 20, padding: "1px 8px", fontSize: 11, fontWeight: 800,
                      background: active ? "oklch(0.1 0 0 / 15%)" : SURF_BORD,
                      color: active ? G_TXT : MUTED,
                    }}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Before Competition — pit scouting team */}
            {shownPitScout.length > 0 && (
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
                  assignments={shownPitScout}
                  allUsers={allUsers ?? []}
                  done={tab === "completed"}
                />
              </div>
            )}

            {/* Summary strip — event totals, so it only belongs on Upcoming */}
            {tab === "upcoming" && (
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
            )}

            {tbaLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
                borderRadius: 10, background: G_DIM, border: `1px solid ${G_MED}`, fontSize: 12, color: G }}>
                <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                <span>Syncing match times…</span>
              </div>
            )}

            {/* ── Day-grouped sequential list ── */}
            {shownDays.map(({ dayLabel, dateKey, items }) => (
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
                          <ScoutingCard assignment={item.assignment} match={item.match} done={item.done} />
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
                          <QualPitCard
                            rotation={item.rotation}
                            done={item.done}
                            onToggle={() => togglePitDuty(item.rotation._id, !item.done)}
                          />
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
                          <ElimsCard
                            done={item.done}
                            onToggle={() => togglePitDuty(item.rotation._id, !item.done)}
                          />
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            ))}

            {/* Nothing in this tab */}
            {tabTotal === 0 && (
              <div style={{
                display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
                padding: "44px 20px", textAlign: "center",
                borderRadius: 14, background: SURFACE, border: `1px solid ${SURF_BORD}`,
              }}>
                {tab === "upcoming"
                  ? <CheckCircle2 size={26} style={{ color: G }} />
                  : <CircleDashed size={26} style={{ color: MUTED }} />}
                <div style={{ fontSize: 14, fontWeight: 700, color: FG }}>
                  {tab === "upcoming" ? "All caught up" : "Nothing completed yet"}
                </div>
                <div style={{ fontSize: 12, color: MUTED, maxWidth: 280 }}>
                  {tab === "upcoming"
                    ? "Every assignment you have is done. Check Completed to review them."
                    : "Submit a form, or report for a pit duty shift, and it will move here."}
                </div>
              </div>
            )}

            {/* Off summary footer */}
            {tab === "upcoming" && offCount > 0 && (
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
