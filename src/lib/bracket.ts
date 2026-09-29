// FRC 8-alliance double-elimination bracket (2023+ format).
// Resolves who sits in every slot from actual TBA results first, then from the
// viewer's what-if predictions. Actual results always win: a prediction that a
// real result contradicts (the predicted alliance lost, or never reached that
// match) is reported back as `corrected` so the caller can drop it.

import type { TBAMatch, TBAAlliance } from "./api";

export type Source = { seed: number } | { winner: number } | { loser: number };

/** Match number → its red/blue feeders (FRC 2023+ double elimination). */
export const BRACKET: Record<number, { red: Source; blue: Source }> = {
  1:  { red: { seed: 1 },    blue: { seed: 8 } },
  2:  { red: { seed: 4 },    blue: { seed: 5 } },
  3:  { red: { seed: 3 },    blue: { seed: 6 } },
  4:  { red: { seed: 2 },    blue: { seed: 7 } },
  5:  { red: { loser: 1 },   blue: { loser: 2 } },
  6:  { red: { loser: 3 },   blue: { loser: 4 } },
  7:  { red: { winner: 1 },  blue: { winner: 2 } },
  8:  { red: { winner: 3 },  blue: { winner: 4 } },
  9:  { red: { loser: 7 },   blue: { winner: 6 } },
  10: { red: { loser: 8 },   blue: { winner: 5 } },
  // M11 is the upper final and M12 the lower one — some bracket graphics swap
  // these, but TBA's sf11/sf12 (and the field display) use this order.
  11: { red: { winner: 7 },  blue: { winner: 8 } },
  12: { red: { winner: 10 }, blue: { winner: 9 } },
  13: { red: { loser: 11 },  blue: { winner: 12 } },
  // Finals (best 2 of 3) are match 14 internally.
  14: { red: { winner: 11 }, blue: { winner: 13 } },
};
export const FINALS = 14;

export function sourceLabel(s: Source): string {
  if ("seed" in s) return `Alliance ${s.seed}`;
  return "winner" in s ? `Winner of M${s.winner}` : `Loser of M${s.loser}`;
}

export interface SlotState {
  red: number | null;           // alliance number in the slot, null = not decided yet
  blue: number | null;
  /** Entrant only got here through a what-if prediction upstream. */
  redProjected: boolean;
  blueProjected: boolean;
  winner: number | null;        // alliance number
  decidedBy: "actual" | "predicted" | null;
  redScore: number | null;      // latest actual score (finals: series wins)
  blueScore: number | null;
  tbaMatch: TBAMatch | null;    // latest TBA match for this slot, for the detail panel
}

export interface BracketState {
  slots: Record<number, SlotState>;
  champion: number | null;
  /** Predictions that actual results overruled — caller should drop these. */
  corrected: number[];
  /** Predictions a real result agreed with — no longer needed, drop silently. */
  settled: number[];
}

/** Predicted winner alliance per match number (1-13, FINALS). */
export type Predictions = Record<number, number>;

function isPlayed(m: TBAMatch): boolean {
  return m.alliances.red.score >= 0 && m.alliances.blue.score >= 0;
}

/** Bracket match number for a TBA playoff match, or null if not part of it. */
export function bracketMatchNumber(m: TBAMatch): number | null {
  if (m.comp_level === "sf" && m.set_number >= 1 && m.set_number <= 13) return m.set_number;
  if (m.comp_level === "f") return FINALS;
  return null;
}

export function resolveBracket(matches: TBAMatch[], predictions: Predictions): BracketState {
  const byNum: Record<number, TBAMatch[]> = {};
  for (const m of matches) {
    const n = bracketMatchNumber(m);
    if (n !== null) (byNum[n] ??= []).push(m);
  }

  const slots: Record<number, SlotState> = {};
  const corrected: number[] = [];
  const settled: number[] = [];

  const pick = (s: Source): number | null => {
    if ("seed" in s) return s.seed;
    const src = slots["winner" in s ? s.winner : s.loser];
    if (!src || src.winner === null) return null;
    if ("winner" in s) return src.winner;
    return src.winner === src.red ? src.blue : src.red;
  };
  const projected = (s: Source): boolean => {
    if ("seed" in s) return false;
    const src = slots["winner" in s ? s.winner : s.loser];
    return src?.decidedBy === "predicted";
  };

  for (let n = 1; n <= FINALS; n++) {
    const red = pick(BRACKET[n].red);
    const blue = pick(BRACKET[n].blue);
    const games = (byNum[n] ?? []).sort((a, b) => a.match_number - b.match_number);
    const played = games.filter(isPlayed);

    // Red/blue sides are fixed by the bracket, so TBA's winning side maps
    // straight onto the alliance in that slot.
    let actualSide: "red" | "blue" | null = null;
    let redScore: number | null = null;
    let blueScore: number | null = null;
    if (n === FINALS) {
      const rw = played.filter((g) => g.winning_alliance === "red").length;
      const bw = played.filter((g) => g.winning_alliance === "blue").length;
      if (rw >= 2) actualSide = "red";
      else if (bw >= 2) actualSide = "blue";
      if (played.length) { redScore = rw; blueScore = bw; }
    } else {
      // Latest decisive game wins (a tied game gets replayed).
      const last = [...played].reverse()
        .find((m) => m.winning_alliance === "red" || m.winning_alliance === "blue");
      if (last) actualSide = last.winning_alliance as "red" | "blue";
      const shown = played[played.length - 1];
      if (shown) { redScore = shown.alliances.red.score; blueScore = shown.alliances.blue.score; }
    }

    let winner: number | null = null;
    let decidedBy: SlotState["decidedBy"] = null;
    if (actualSide && red !== null && blue !== null) {
      winner = actualSide === "red" ? red : blue;
      decidedBy = "actual";
    }

    const p = predictions[n];
    if (p !== undefined) {
      if (winner !== null) {
        (p === winner ? settled : corrected).push(n);
      } else if (red !== null && blue !== null) {
        if (p === red || p === blue) { winner = p; decidedBy = "predicted"; }
        // The predicted alliance can't be here — real results sent someone else.
        else corrected.push(n);
      }
    }

    slots[n] = {
      red, blue, winner,
      redProjected: red !== null && projected(BRACKET[n].red),
      blueProjected: blue !== null && projected(BRACKET[n].blue),
      decidedBy, redScore, blueScore,
      tbaMatch: games[games.length - 1] ?? null,
    };
  }

  return { slots, champion: slots[FINALS].winner, corrected, settled };
}

/** Alliance number (1-8) → team numbers, captain first. Missing = not selected yet. */
export function allianceTeams(alliances: TBAAlliance[] | null | undefined): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  (alliances ?? []).forEach((a, i) => {
    const fromName = Number(a.name?.match(/(\d+)/)?.[1]);
    const n = fromName >= 1 && fromName <= 8 ? fromName : i + 1;
    out[n] = a.picks.map((k) => Number(k.replace("frc", ""))).filter(Boolean);
  });
  return out;
}

/** Pick an alliance to win a match; picking the current pick again clears it. */
export function togglePrediction(pred: Predictions, match: number, alliance: number): Predictions {
  const next = { ...pred };
  if (next[match] === alliance) delete next[match];
  else next[match] = alliance;
  return next;
}
