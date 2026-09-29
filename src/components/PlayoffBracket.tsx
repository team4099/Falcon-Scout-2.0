// Double-elimination playoff bracket for the Matches tab. Real TBA results
// place alliances; tapping an alliance in an undecided match predicts it wins
// (a local what-if). Real results always override what-ifs, see lib/bracket.
import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Trophy } from "lucide-react";
import type { TBAMatch } from "@/lib/api";
import {
  BRACKET, FINALS, resolveBracket, sourceLabel, togglePrediction,
  type Predictions, type SlotState,
} from "@/lib/bracket";

const MY_TEAM = 4099;

// ── layout (px), mirrors the official FRC bracket diagram ───────────────────
const COL_W = 196;
const FINALS_W = 284;   // wider: one score cell per finals game
const GAP = 40;
const HEAD_H = 24;
const ROW_H = 32;
const BOX_H = HEAD_H + ROW_H * 2;
const DIVIDER_Y = 408;
const col = (c: number) => c * (COL_W + GAP);
const POS: Record<number, { x: number; y: number }> = {
  1: { x: col(0), y: 28 },  2: { x: col(0), y: 124 }, 3: { x: col(0), y: 220 }, 4: { x: col(0), y: 316 },
  7: { x: col(1), y: 76 },  8: { x: col(1), y: 268 },
  11: { x: col(3), y: 172 },
  5: { x: col(1), y: 510 }, 6: { x: col(1), y: 690 },
  10: { x: col(2), y: 452 }, 9: { x: col(2), y: 632 },
  12: { x: col(3), y: 542 },
  13: { x: col(4), y: 498 },
  [FINALS]: { x: col(5), y: 356 },
};
const WIDTH = col(5) + FINALS_W;
const HEIGHT = 690 + BOX_H + 4;
const ROUNDS = ["Round 1", "Round 2", "Round 3", "Round 4", "Round 5", "Finals"];
const FINALS_GAMES = 3;

function rowY(side: "red" | "blue") {
  return HEAD_H + (side === "red" ? ROW_H / 2 : ROW_H * 1.5);
}

/** Elbow lines from each "winner of" feeder to the slot it fills. */
const PATHS = Object.entries(BRACKET).flatMap(([t, srcs]) => {
  const to = POS[Number(t)];
  return (["red", "blue"] as const).flatMap((side) => {
    const s = srcs[side];
    if (!("winner" in s)) return [];
    const from = POS[s.winner];
    const mid = to.x - GAP / 2;
    return [{ from: s.winner, d: `M${from.x + COL_W} ${from.y + HEAD_H + ROW_H}H${mid}V${to.y + rowY(side)}H${to.x}` }];
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
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground shrink-0">
        {bracket.champion !== null && (
          <span className="flex items-center gap-1.5 font-semibold text-foreground">
            <Trophy className="h-3.5 w-3.5 text-primary" />
            Alliance {bracket.champion} {bracket.slots[FINALS].decidedBy === "predicted" ? "(predicted)" : "wins"}
          </span>
        )}
        {eliminated.length > 0 && (
          <span>Out: <span className="font-mono tabular-nums">{eliminated.map((a) => `A${a}`).join("  ")}</span></span>
        )}
        <span>
          {hasAlliances ? "" : "Teams appear after alliance selection. "}
          Tap an alliance to predict it wins.
        </span>
        {whatIfCount > 0 && (
          <button
            onClick={() => { setPredictions({}); setNotice(null); }}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-muted/40 hover:bg-muted text-foreground font-medium active:scale-[0.98] transition"
          >
            <RotateCcw className="h-3 w-3" /> Reset {whatIfCount} prediction{whatIfCount > 1 ? "s" : ""}
          </button>
        )}
      </div>
      {notice && (
        <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground shrink-0">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="font-semibold text-primary">Dismiss</button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-border bg-muted/10">
        <div className="relative m-4" style={{ width: WIDTH, height: HEIGHT }}>
          {ROUNDS.map((r, i) => (
            <div key={r} className="absolute top-0 text-[11px] font-medium text-muted-foreground"
              style={{ left: col(i), width: i === 5 ? FINALS_W : COL_W }}>{r}</div>
          ))}
          <div className="absolute border-t border-border/60" style={{ left: 0, width: col(5) - GAP / 2, top: DIVIDER_Y }} />
          <div className="absolute text-[11px] font-medium text-muted-foreground/70"
            style={{ left: 0, top: DIVIDER_Y + 8 }}>Lower bracket</div>
          <svg className="absolute inset-0 pointer-events-none" width={WIDTH} height={HEIGHT}>
            {PATHS.map(({ from, d }) => {
              const lit = bracket.slots[from].winner !== null;
              return (
                <path key={d} d={d} fill="none" strokeWidth={1.25}
                  className={lit ? "stroke-muted-foreground/70" : "stroke-border"} />
              );
            })}
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
  const predicted = slot.decidedBy === "predicted";
  const status =
    predicted ? "Predicted"
    : isFinals ? "Best of 3"
    : slot.decidedBy === "actual" ? "Final"
    : slot.games.length > 0 ? "Live"
    : "";

  return (
    <div
      className={`absolute rounded-lg border bg-card overflow-hidden ${
        isFinals ? "border-primary/50 ring-1 ring-primary/15" : "border-border"
      }`}
      style={{ left: x, top: y, width: isFinals ? FINALS_W : COL_W, height: BOX_H }}
    >
      <button
        disabled={!slot.tbaMatch}
        onClick={() => slot.tbaMatch && onOpen(slot.tbaMatch)}
        className="w-full flex items-center gap-2 px-2.5 text-[11px] enabled:hover:bg-muted/50 disabled:cursor-default"
        style={{ height: HEAD_H }}
        title={slot.tbaMatch ? "Open match details" : undefined}
      >
        <span className="font-semibold text-foreground">{isFinals ? "Finals" : `M${n}`}</span>
        <span className={`flex-1 text-left ${predicted ? "text-primary" : "text-muted-foreground"}`}>{status}</span>
        {isFinals && Array.from({ length: FINALS_GAMES }, (_, i) => (
          <span key={i} className="w-8 text-right text-[10px] text-muted-foreground">G{i + 1}</span>
        ))}
      </button>
      {(["red", "blue"] as const).map((side) => {
        const a = slot[side];
        const projected = side === "red" ? slot.redProjected : slot.blueProjected;
        const won = a !== null && slot.winner === a;
        const lost = a !== null && slot.winner !== null && !won;
        const teams = a !== null ? (teamsByAlliance[a] ?? []).slice(0, 3) : [];
        const other = side === "red" ? "blue" : "red";
        // Regular matches show the latest game; finals show every game.
        const cells = isFinals
          ? Array.from({ length: FINALS_GAMES }, (_, i) => slot.games[i])
          : [slot.games[slot.games.length - 1]];
        return (
          <button
            key={side}
            disabled={!canPick}
            onClick={() => a !== null && onPick(a)}
            className={`relative w-full flex items-center gap-2 pl-3 pr-2.5 text-left text-xs border-t border-border/60 transition-colors
              ${canPick ? "hover:bg-muted/50 active:bg-muted cursor-pointer" : "cursor-default"}
              ${won && predicted ? "bg-primary/10" : ""}`}
            style={{ height: ROW_H }}
            aria-label={a !== null ? `Alliance ${a}${canPick ? ", tap to predict winner" : ""}` : sourceLabel(BRACKET[n][side])}
          >
            <span className={`absolute left-0 inset-y-0 w-[3px] ${side === "red" ? "bg-red-500" : "bg-blue-500"} ${lost ? "opacity-30" : ""}`} />
            {a === null ? (
              <span className="flex-1 truncate text-muted-foreground/70">{sourceLabel(BRACKET[n][side])}</span>
            ) : (
              <>
                <span className={`w-6 shrink-0 font-semibold ${
                  lost ? "text-muted-foreground/50" : projected || (won && predicted) ? "text-primary" : "text-foreground"
                }`}>A{a}</span>
                <span className={`flex-1 min-w-0 truncate font-mono text-[11px] tabular-nums ${lost ? "text-muted-foreground/50" : "text-muted-foreground"}`}>
                  {teams.map((t, i) => (
                    <span key={t} className={t === MY_TEAM && !lost ? "text-primary font-semibold" : ""}>{i ? " " : ""}{t}</span>
                  ))}
                </span>
              </>
            )}
            {cells.map((g, i) => {
              const gameWon = g !== undefined && g[side] > g[other];
              return (
                <span key={i} className={`w-8 shrink-0 text-right font-mono tabular-nums ${
                  g === undefined ? "text-muted-foreground/30"
                  : gameWon ? "text-foreground font-semibold"
                  : "text-muted-foreground/60"
                }`}>
                  {g === undefined ? (isFinals ? "-" : "") : g[side]}
                </span>
              );
            })}
          </button>
        );
      })}
    </div>
  );
}
