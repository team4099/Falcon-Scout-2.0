// Double-elimination playoff bracket for the Matches tab. Real TBA results
// place alliances; tapping an alliance in an undecided match predicts it wins
// (a local what-if). Real results always override what-ifs — see lib/bracket.
import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Trophy } from "lucide-react";
import type { TBAMatch } from "@/lib/api";
import {
  BRACKET, FINALS, resolveBracket, sourceLabel, togglePrediction,
  type Predictions, type SlotState,
} from "@/lib/bracket";

const MY_TEAM = 4099;

// ── layout (px) — mirrors the official FRC bracket diagram ──────────────────
const COL_W = 184;
const GAP = 36;
const HEAD_H = 20;
const ROW_H = 30;
const BOX_H = HEAD_H + ROW_H * 2;
const DIVIDER_Y = 386;
const col = (c: number) => c * (COL_W + GAP);
const POS: Record<number, { x: number; y: number }> = {
  1: { x: col(0), y: 24 },  2: { x: col(0), y: 112 }, 3: { x: col(0), y: 200 }, 4: { x: col(0), y: 288 },
  7: { x: col(1), y: 68 },  8: { x: col(1), y: 244 },
  11: { x: col(3), y: 156 },
  5: { x: col(1), y: 486 }, 6: { x: col(1), y: 654 },
  10: { x: col(2), y: 432 }, 9: { x: col(2), y: 600 },
  12: { x: col(3), y: 516 },
  13: { x: col(4), y: 474 },
  [FINALS]: { x: col(5), y: 340 },
};
const WIDTH = col(5) + COL_W;
const HEIGHT = 654 + BOX_H + 4;
const ROUNDS = ["Round 1", "Round 2", "Round 3", "Round 4", "Round 5", "Finals"];

function rowY(side: "red" | "blue") {
  return HEAD_H + (side === "red" ? ROW_H / 2 : ROW_H * 1.5);
}

/** Elbow lines from each "winner of" feeder to the slot it fills. */
const PATHS: string[] = Object.entries(BRACKET).flatMap(([t, srcs]) => {
  const to = POS[Number(t)];
  return (["red", "blue"] as const).flatMap((side) => {
    const s = srcs[side];
    if (!("winner" in s)) return [];
    const from = POS[s.winner];
    const mid = to.x - GAP / 2;
    return [`M${from.x + COL_W} ${from.y + HEAD_H + ROW_H}H${mid}V${to.y + rowY(side)}H${to.x}`];
  });
});

function loadPredictions(key: string): Predictions {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}") as Predictions; } catch { return {}; }
}

export default function PlayoffBracket({
  eventKey, matches, teamsByAlliance, onOpenMatch,
}: {
  eventKey: string;
  matches: TBAMatch[];
  teamsByAlliance: Record<number, number[]>;
  onOpenMatch: (m: TBAMatch) => void;
}) {
  // Outside the Clear Cache prefixes, so what-ifs survive a cache clear.
  const storageKey = `falconscout_bracket_${eventKey}`;
  const [predictions, setPredictions] = useState<Predictions>(() => loadPredictions(storageKey));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { setPredictions(loadPredictions(storageKey)); }, [storageKey]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(predictions)); } catch { /* private mode */ }
  }, [storageKey, predictions]);

  const bracket = useMemo(() => resolveBracket(matches, predictions), [matches, predictions]);

  // Real results win: drop what-ifs they overruled (and ones they confirmed).
  useEffect(() => {
    const { corrected, settled } = bracket;
    if (corrected.length === 0 && settled.length === 0) return;
    setPredictions((prev) => {
      const next = { ...prev };
      for (const n of [...corrected, ...settled]) delete next[n];
      return next;
    });
    if (corrected.length) {
      const names = corrected.map((n) => (n === FINALS ? "Finals" : `M${n}`)).join(", ");
      setNotice(`Actual results replaced your prediction${corrected.length > 1 ? "s" : ""} for ${names}.`);
    }
  }, [bracket]);

  const eliminated = useMemo(() => {
    const out: number[] = [];
    for (const n of [5, 6, 9, 10, 12, 13, FINALS]) {
      const s = bracket.slots[n];
      if (s.decidedBy === "actual") out.push(s.winner === s.red ? s.blue! : s.red!);
    }
    return out.sort((a, b) => a - b);
  }, [bracket]);

  const whatIfCount = Object.keys(predictions).length;
  const hasAlliances = Object.keys(teamsByAlliance).length > 0;

  return (
    <div className="flex flex-col gap-3 min-h-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground shrink-0">
        <span>
          {hasAlliances ? "" : "Teams appear after alliance selection. "}
          Tap an alliance to predict it wins; tap again to undo.
        </span>
        {bracket.champion !== null && (
          <span className="flex items-center gap-1 font-semibold text-yellow-500">
            <Trophy className="h-3.5 w-3.5" />
            Alliance {bracket.champion} {bracket.slots[FINALS].decidedBy === "predicted" ? "(predicted)" : "champions"}
          </span>
        )}
        {eliminated.length > 0 && <span>Eliminated: {eliminated.map((a) => `A${a}`).join(", ")}</span>}
        {whatIfCount > 0 && (
          <button
            onClick={() => { setPredictions({}); setNotice(null); }}
            className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-md bg-muted hover:bg-muted/80 text-foreground font-medium"
          >
            <RotateCcw className="h-3 w-3" /> Reset {whatIfCount} prediction{whatIfCount > 1 ? "s" : ""}
          </button>
        )}
      </div>
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400 shrink-0">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="font-semibold">Dismiss</button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-border bg-card/40">
        <div className="relative m-3" style={{ width: WIDTH, height: HEIGHT }}>
          {ROUNDS.map((r, i) => (
            <div key={r} className="absolute top-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-center"
              style={{ left: col(i), width: COL_W }}>{r}</div>
          ))}
          <div className="absolute text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
            style={{ left: 0, top: DIVIDER_Y - 16 }}>▲ Upper bracket</div>
          <div className="absolute text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
            style={{ left: 0, top: DIVIDER_Y + 4 }}>▼ Lower bracket</div>
          <div className="absolute border-t border-dashed border-border" style={{ left: 0, width: col(5) - GAP / 2, top: DIVIDER_Y }} />
          <svg className="absolute inset-0 pointer-events-none text-muted-foreground/40" width={WIDTH} height={HEIGHT}>
            {PATHS.map((d) => <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth={1.5} />)}
          </svg>
          {Object.keys(BRACKET).map(Number).map((n) => (
            <MatchBox
              key={n} n={n} slot={bracket.slots[n]} teamsByAlliance={teamsByAlliance}
              onPick={(a) => setPredictions((p) => togglePrediction(p, n, a))}
              onOpen={onOpenMatch}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MatchBox({
  n, slot, teamsByAlliance, onPick, onOpen,
}: {
  n: number;
  slot: SlotState;
  teamsByAlliance: Record<number, number[]>;
  onPick: (alliance: number) => void;
  onOpen: (m: TBAMatch) => void;
}) {
  const { x, y } = POS[n];
  const isFinals = n === FINALS;
  const canPick = slot.red !== null && slot.blue !== null && slot.decidedBy !== "actual";
  const status =
    slot.decidedBy === "actual" ? "Final"
    : slot.redScore !== null ? "In progress"
    : slot.decidedBy === "predicted" ? "Predicted"
    : "";

  return (
    <div
      className={`absolute rounded-lg border bg-card shadow-sm overflow-hidden ${isFinals ? "border-yellow-500/60 ring-1 ring-yellow-500/30" : "border-border"}`}
      style={{ left: x, top: y, width: COL_W, height: BOX_H }}
    >
      <button
        disabled={!slot.tbaMatch}
        onClick={() => slot.tbaMatch && onOpen(slot.tbaMatch)}
        className="w-full flex items-center justify-between px-2 text-[10px] font-semibold bg-muted/40 enabled:hover:bg-muted disabled:cursor-default"
        style={{ height: HEAD_H }}
        title={slot.tbaMatch ? "Open match details" : undefined}
      >
        <span>{isFinals ? "Finals · best 2 of 3" : `Match ${n}`}</span>
        <span className={slot.decidedBy === "predicted" ? "text-primary italic" : "text-muted-foreground"}>{status}</span>
      </button>
      {(["red", "blue"] as const).map((side) => {
        const a = slot[side];
        const projected = side === "red" ? slot.redProjected : slot.blueProjected;
        const score = side === "red" ? slot.redScore : slot.blueScore;
        const won = a !== null && slot.winner === a;
        const lost = a !== null && slot.winner !== null && !won;
        const teams = a !== null ? (teamsByAlliance[a] ?? []).slice(0, 3) : [];
        return (
          <button
            key={side}
            disabled={!canPick}
            onClick={() => a !== null && onPick(a)}
            className={`w-full flex items-center gap-1.5 pr-2 text-left text-[11px] border-t border-border/50 transition-colors
              ${canPick ? "hover:bg-muted/60 cursor-pointer" : "cursor-default"}
              ${lost ? "opacity-45" : ""}
              ${won && slot.decidedBy === "predicted" ? "bg-primary/10" : ""}`}
            style={{ height: ROW_H }}
            aria-label={a !== null ? `Alliance ${a}${canPick ? ", tap to predict winner" : ""}` : sourceLabel(BRACKET[n][side])}
          >
            <span className={`self-stretch w-1.5 shrink-0 ${side === "red" ? "bg-red-500" : "bg-blue-500"}`} />
            {a === null ? (
              <span className="italic text-muted-foreground truncate">{sourceLabel(BRACKET[n][side])}</span>
            ) : (
              <>
                <span className={`shrink-0 font-bold ${projected ? "italic text-primary" : ""}`}>A{a}</span>
                <span className={`flex-1 min-w-0 truncate font-mono text-[10px] text-muted-foreground ${projected ? "italic" : ""}`}>
                  {teams.map((t, i) => (
                    <span key={t} className={t === MY_TEAM ? "text-yellow-500 font-bold" : ""}>{i ? " " : ""}{t}</span>
                  ))}
                </span>
              </>
            )}
            {score !== null && (
              <span className={`shrink-0 font-mono font-semibold ${won ? (side === "red" ? "text-red-500" : "text-blue-500") : ""}`}>{score}</span>
            )}
            {won && <span className={`shrink-0 ${slot.decidedBy === "predicted" ? "text-primary" : "text-green-500"}`}>✓</span>}
          </button>
        );
      })}
    </div>
  );
}
