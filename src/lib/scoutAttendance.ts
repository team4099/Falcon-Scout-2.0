/**
 * Who filed their assigned qual-match form and who missed it (admin Submissions
 * → Attendance). An assignment counts once its qual has been played; it is
 * "submitted" when that scout filed a match-form report for that match (for the
 * assigned team when TBA says which one, else any team in the match).
 */

export interface AttendanceAssignment {
  matchNumber: number;
  matchLabel: string;
  position: "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";
  scoutId: string;
}

export interface AttendanceSubmission {
  templateId: string;
  matchNumber?: number;
  teamNumber?: number;
  compLevel?: "qm" | "elim";
  scoutId?: string;
}

export interface AttendanceMatch {
  matchNumber: number;
  label: string;
  submitted: boolean;
}

export interface ScoutAttendance {
  scoutId: string;
  matches: AttendanceMatch[];
  submitted: number;
  missed: number;
}

/** Position → team number from a TBA qual's alliances; null when unknown. */
export function teamAtPosition(
  alliances: { red: { team_keys: string[] }; blue: { team_keys: string[] } } | undefined,
  position: AttendanceAssignment["position"],
): number | null {
  const color = position.startsWith("red") ? "red" : "blue";
  const key = alliances?.[color].team_keys[Number(position.slice(-1)) - 1];
  const n = key ? Number(key.replace("frc", "")) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function buildAttendance(opts: {
  assignments: AttendanceAssignment[];
  submissions: AttendanceSubmission[];
  /** Template ids of match forms (formType "default"). */
  matchTemplateIds: ReadonlySet<string>;
  /** Qual numbers already played. */
  playedQuals: ReadonlySet<number>;
  /** Assigned team for a qual position, when known. */
  teamFor?: (matchNumber: number, position: AttendanceAssignment["position"]) => number | null;
}): ScoutAttendance[] {
  const { assignments, submissions, matchTemplateIds, playedQuals, teamFor } = opts;
  // scout → "match" and "match|team" keys they filed.
  const filed = new Map<string, Set<string>>();
  for (const s of submissions) {
    if (!s.scoutId || !s.matchNumber || !matchTemplateIds.has(s.templateId)) continue;
    if ((s.compLevel ?? "qm") !== "qm") continue;
    const set = filed.get(s.scoutId) ?? new Set<string>();
    set.add(`${s.matchNumber}`);
    set.add(`${s.matchNumber}|${s.teamNumber}`);
    filed.set(s.scoutId, set);
  }

  const byScout = new Map<string, ScoutAttendance>();
  for (const a of assignments) {
    if (!playedQuals.has(a.matchNumber)) continue;
    const team = teamFor?.(a.matchNumber, a.position) ?? null;
    const set = filed.get(a.scoutId);
    const submitted = !!set?.has(team ? `${a.matchNumber}|${team}` : `${a.matchNumber}`);
    const row = byScout.get(a.scoutId) ?? { scoutId: a.scoutId, matches: [], submitted: 0, missed: 0 };
    row.matches.push({ matchNumber: a.matchNumber, label: a.matchLabel, submitted });
    if (submitted) row.submitted++; else row.missed++;
    byScout.set(a.scoutId, row);
  }
  for (const r of byScout.values()) r.matches.sort((x, y) => x.matchNumber - y.matchNumber);
  return [...byScout.values()];
}
