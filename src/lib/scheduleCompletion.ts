/**
 * scheduleCompletion.ts
 *
 * Works out which of a scout's My Schedule assignments are already done.
 *
 * An assignment is "done" once this scout has submitted the matching form. Two
 * sources are merged, because either one alone loses work:
 *   - the server (`forms.getMySubmissions`) — the truth once a device syncs,
 *     and the only place a submission made on *another* device shows up;
 *   - the local store (`submissionStore`) — written on every submit before the
 *     network is touched, so a scout working offline still sees their own
 *     assignments tick off.
 */

export interface SubmissionKey {
  formType: string;
  matchNumber: number;
  compLevel?: "qm" | "elim";
  teamNumber: number;
  templateId: string;
}

export interface Completion {
  /** `checklist` keys: match + the specific checklist template. */
  checklists: Set<string>;
  /** Match scouting keyed by comp level + match + team. */
  matchTeams: Set<string>;
  /** Match scouting keyed by comp level + match only — used when TBA has not
   *  told us which team the position maps to yet. */
  matches: Set<string>;
  /** Team numbers this scout has pit-scouted. */
  pitTeams: Set<number>;
}

export const EMPTY_COMPLETION: Completion = {
  checklists: new Set(), matchTeams: new Set(), matches: new Set(), pitTeams: new Set(),
};

export function buildCompletion(subs: SubmissionKey[]): Completion {
  const c: Completion = {
    checklists: new Set(), matchTeams: new Set(), matches: new Set(), pitTeams: new Set(),
  };
  for (const s of subs) {
    if (s.formType === "checklist") {
      c.checklists.add(`${s.matchNumber}-${s.templateId}`);
    } else if (s.formType === "pit") {
      c.pitTeams.add(s.teamNumber);
    } else if (s.formType === "default") {
      // compLevel is optional on older rows; quals are the overwhelming default.
      const lvl = s.compLevel ?? "qm";
      c.matches.add(`${lvl}|${s.matchNumber}`);
      c.matchTeams.add(`${lvl}|${s.matchNumber}|${s.teamNumber}`);
    }
  }
  return c;
}

export function isMatchDone(c: Completion, matchNumber: number, compLevel: "qm" | "elim", teamNumber: number | null): boolean {
  return teamNumber !== null
    ? c.matchTeams.has(`${compLevel}|${matchNumber}|${teamNumber}`)
    : c.matches.has(`${compLevel}|${matchNumber}`);
}

