// Double-elimination playoff bracket for the Matches tab. Real TBA results
// place alliances. What-ifs are local: tap an alliance card to pick it as the
// winner, or drag it to any later slot it could reach. Tapping the team
// numbers opens the alliance profile. Real results always override what-ifs,
// see lib/bracket.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Trophy } from "lucide-react";
import type { TBAMatch } from "@/lib/api";
import {
  BRACKET, FINALS, resolveBracket, routeTo, sourceLabel, togglePrediction,
  type Predictions, type SlotState,
} from "@/lib/bracket";

const MY_TEAM = 4099;
type Side = "red" | "blue";

// ── layout (px), mirrors the official FRC bracket diagram ───────────────────
const COL_W = 200;
const FINALS_W = 288;   // wider: one score cell per finals game
const GAP = 40;
const PAD = 5;          // box padding around the alliance cards
const HEAD_H = 22;
const ROW_H = 32;
const ROW_GAP = 4;
const BOX_H = PAD + HEAD_H + ROW_H * 2 + ROW_GAP + PAD;
const U = BOX_H + 12;   // vertical pitch of round 1
const col = (c: number) => c * (COL_W + GAP);
const mid = (a: number, b: number) => (a + b) / 2;
const TOP = 28;
const r1 = [0, 1, 2, 3].map((i) => TOP + i * U);
const DIVIDER_Y = r1[3] + BOX_H + 24;
const LOW = DIVIDER_Y + 44;
const y10 = LOW, y5 = LOW + U * 0.55, y9 = LOW + U * 1.7, y6 = LOW + U * 2.25;
const y7 = mid(r1[0], r1[1]), y8 = mid(r1[2], r1[3]), y11 = mid(y7, y8);
const y12 = mid(y10, y9), y13 = y12 - 44;
const POS: Record<number, { x: number; y: number }> = {
  1: { x: col(0), y: r1[0] }, 2: { x: col(0), y: r1[1] }, 3: { x: col(0), y: r1[2] }, 4: { x: col(0), y: r1[3] },
  7: { x: col(1), y: y7 }, 8: { x: col(1), y: y8 },
  11: { x: col(3), y: y11 },
  5: { x: col(1), y: y5 }, 6: { x: col(1), y: y6 },
  10: { x: col(2), y: y10 }, 9: { x: col(2), y: y9 },
  12: { x: col(3), y: y12 },
  13: { x: col(4), y: y13 },
  [FINALS]: { x: col(5), y: mid(y11, y13) },
};
const WIDTH = col(5) + FINALS_W;
const HEIGHT = y6 + BOX_H + 4;
const ROUNDS = ["Round 1", "Round 2", "Round 3", "Round 4", "Round 5", "Finals"];
const FINALS_GAMES = 3;

const rowTop = (side: Side) => PAD + HEAD_H + (side === "red" ? 0 : ROW_H + ROW_GAP);

/** Elbow lines from each "winner of" feeder to the slot it fills. */
const PATHS = Object.entries(BRACKET).flatMap(([t, srcs]) => {
  const to = POS[Number(t)];
  return (["red", "blue"] as const).flatMap((side) => {
    const s = srcs[side];
    if (!("winner" in s)) return [];
    const from = POS[s.winner];
    const y1 = from.y + PAD + HEAD_H + ROW_H + ROW_GAP / 2;
    const y2 = to.y + rowTop(side) + ROW_H / 2;
    return [{ from: s.winner, d: `M${from.x + COL_W} ${y1}H${to.x - GAP / 2}V${y2}H${to.x}` }];
  });
});

function loadPredictions(key: string): Predictions {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}") as Predictions; } catch { return {}; }
}

const slotKey = (n: number, side: Side) => `${n}:${side}`;

interface Drag { alliance: number; from: number; x: number; y: number; over: string | null }

export default function PlayoffBracket({
  eventKey, matches, teamsByAlliance, onOpenMatch, onOpenAlliance,
}: {
  eventKey: string;
  matches: TBAMatch[];
  teamsByAlliance: Record<number, number[]>;
  onOpenMatch: (m: TBAMatch) => void;
  onOpenAlliance: (alliance: number) => void;
}) {
  // Outside the Clear Cache prefixes, so what-ifs survive a cache clear.
  const storageKey = `falconscout_bracket_${eventKey}`;
  const [predictions, setPredictions] = useState<Predictions>(() => loadPredictions(storageKey));
  const [notice, setNotice] = useState<string | null>(null);

  // Switching events swaps in that event's what-ifs.
  const [loadedKey, setLoadedKey] = useState(storageKey);
  if (loadedKey !== storageKey) {
    setLoadedKey(storageKey);
    setPredictions(loadPredictions(storageKey));
  }
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(predictions)); } catch { /* private mode */ }
  }, [storageKey, predictions]);

  const bracket = useMemo(() => resolveBracket(matches, predictions), [matches, predictions]);

  // Real results win: drop what-ifs they overruled (and ones they confirmed).
  // Done during render so the stale what-if never paints.
  if (bracket.corrected.length || bracket.settled.length) {
    const next = { ...predictions };
    for (const n of [...bracket.corrected, ...bracket.settled]) delete next[n];
    setPredictions(next);
    if (bracket.corrected.length) {
      const names = bracket.corrected.map((n) => (n === FINALS ? "Finals" : `M${n}`)).join(", ");
      setNotice(`Actual results replaced your prediction${bracket.corrected.length > 1 ? "s" : ""} for ${names}.`);
    }
  }

  const eliminated = useMemo(() => {
    const out: number[] = [];
    for (const n of [5, 6, 9, 10, 12, 13, FINALS]) {
      const s = bracket.slots[n];
      if (s.decidedBy === "actual" && s.loser !== null) out.push(s.loser);
    }
    return out.sort((a, b) => a - b);
  }, [bracket]);

  // ── drag an alliance card to a later slot ────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const suppressClick = useRef(false);

  /** Slots `alliance` could be dragged to from match `from`, with the what-ifs that put it there. */
  const targetsFor = useCallback((from: number, alliance: number) => {
    const out = new Map<string, Predictions>();
    for (const t of Object.keys(BRACKET).map(Number)) {
      if (bracket.slots[t].decidedBy === "actual" || bracket.slots[t].games.length > 0) continue;
      for (const side of ["red", "blue"] as const) {
        if (bracket.slots[t][side] === alliance) continue;
        const route = routeTo(from, t, side, alliance);
        if (route) out.set(slotKey(t, side), route);
      }
    }
    return out;
  }, [bracket]);

  const dragFrom = drag?.from ?? null;
  const dragAlliance = drag?.alliance ?? null;
  const targets = useMemo(
    () => (dragFrom !== null && dragAlliance !== null ? targetsFor(dragFrom, dragAlliance) : new Map<string, Predictions>()),
    [dragFrom, dragAlliance, targetsFor],
  );
  const targetsRef = useRef(targets);
  useEffect(() => { targetsRef.current = targets; }, [targets]);

  const beginDrag = (e: React.PointerEvent, from: number, alliance: number) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    const touch = e.pointerType !== "mouse";
    let active = false;
    let last = start;

    const hover = (x: number, y: number) =>
      (document.elementFromPoint(x, y)?.closest("[data-slot]") as HTMLElement | null)?.dataset.slot ?? null;
    const activate = () => {
      active = true;
      navigator.vibrate?.(10);
      setDrag({ alliance, from, x: last.x, y: last.y, over: null });
    };
    // Touch waits for a long press so a swipe still scrolls the bracket.
    const timer = touch ? window.setTimeout(activate, 280) : 0;
    // Edge auto-scroll so far-away slots are reachable on a phone.
    const scroller = window.setInterval(() => {
      const el = scrollRef.current;
      if (!active || !el) return;
      const r = el.getBoundingClientRect();
      const edge = 48, step = 14;
      if (last.x < r.left + edge) el.scrollLeft -= step;
      else if (last.x > r.right - edge) el.scrollLeft += step;
      if (last.y < r.top + edge) el.scrollTop -= step;
      else if (last.y > r.bottom - edge) el.scrollTop += step;
    }, 16);

    const onMove = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      const dist = Math.hypot(last.x - start.x, last.y - start.y);
      if (!active) {
        if (touch) { if (dist > 8) cleanup(); return; }   // it's a scroll
        if (dist < 5) return;
        activate();
      }
      setDrag((d) => d && { ...d, x: last.x, y: last.y, over: hover(last.x, last.y) });
    };
    const onTouchMove = (ev: TouchEvent) => { if (active) ev.preventDefault(); };
    const onUp = (ev: PointerEvent) => {
      if (active) {
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        const key = hover(ev.clientX, ev.clientY);
        const route = key ? targetsRef.current.get(key) : undefined;
        if (route) setPredictions((p) => ({ ...p, ...route }));
      }
      cleanup();
    };
    function cleanup() {
      clearTimeout(timer);
      clearInterval(scroller);
      active = false;
      setDrag(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("touchmove", onTouchMove);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
  };

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
          {hasAlliances ? "Tap team numbers for the alliance profile. " : "Teams appear after alliance selection. "}
          Drag an alliance to a later slot, or tap it to pick a winner.
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

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto rounded-xl border border-border bg-muted/10">
        <div className="relative m-4 select-none" style={{ width: WIDTH, height: HEIGHT }}>
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
              drag={drag} targets={targets}
              onPick={(a) => { if (!suppressClick.current) setPredictions((p) => togglePrediction(p, n, a)); }}
              onOpen={onOpenMatch}
              onOpenAlliance={onOpenAlliance}
              onDragStart={beginDrag}
            />
          ))}
        </div>
      </div>

      {drag && (
        <div
          className="fixed z-50 pointer-events-none -translate-x-1/2 -translate-y-1/2 flex items-center gap-2 rounded-lg border border-primary bg-card px-3 py-2 text-xs shadow-xl shadow-black/40"
          style={{ left: drag.x, top: drag.y }}
        >
          <span className="font-semibold text-primary">A{drag.alliance}</span>
          <span className="font-mono text-muted-foreground">{(teamsByAlliance[drag.alliance] ?? []).join(" ")}</span>
        </div>
      )}
    </div>
  );
}

function MatchBox({
  n, slot, teamsByAlliance, drag, targets, onPick, onOpen, onOpenAlliance, onDragStart,
}: {
  n: number;
  slot: SlotState;
  teamsByAlliance: Record<number, number[]>;
  drag: Drag | null;
  targets: Map<string, Predictions>;
  onPick: (alliance: number) => void;
  onOpen: (m: TBAMatch) => void;
  onOpenAlliance: (alliance: number) => void;
  onDragStart: (e: React.PointerEvent, from: number, alliance: number) => void;
}) {
  const { x, y } = POS[n];
  const isFinals = n === FINALS;
  const open = slot.decidedBy !== "actual" && slot.games.length === 0;
  const canPick = slot.red !== null && slot.blue !== null && open;
  const predicted = slot.decidedBy === "predicted";
  const status =
    predicted ? "Predicted"
    : isFinals ? "Best of 3"
    : slot.decidedBy === "actual" ? "Final"
    : slot.games.length > 0 ? "Live"
    : "";

  return (
    <div
      className={`absolute rounded-xl border bg-card ${
        isFinals ? "border-primary/50 ring-1 ring-primary/15" : "border-border"
      }`}
      style={{ left: x, top: y, width: isFinals ? FINALS_W : COL_W, height: BOX_H, padding: PAD }}
    >
      <button
        disabled={!slot.tbaMatch}
        onClick={() => slot.tbaMatch && onOpen(slot.tbaMatch)}
        className="w-full flex items-center gap-2 px-1.5 text-[11px] rounded-md enabled:hover:bg-muted/50 disabled:cursor-default"
        style={{ height: HEAD_H }}
        title={slot.tbaMatch ? "Open match details" : undefined}
      >
        <span className="font-semibold text-foreground">{isFinals ? "Finals" : `M${n}`}</span>
        <span className={`flex-1 text-left ${predicted ? "text-primary" : "text-muted-foreground"}`}>{status}</span>
        {isFinals && Array.from({ length: FINALS_GAMES }, (_, i) => (
          <span key={i} className="w-8 text-right text-[10px] text-muted-foreground">G{i + 1}</span>
        ))}
      </button>
      <div className="flex flex-col" style={{ gap: ROW_GAP }}>
        {(["red", "blue"] as const).map((side) => {
          const a = slot[side];
          const key = slotKey(n, side);
          const isTarget = targets.has(key);
          const isOver = drag?.over === key && isTarget;
          const isDragged = drag !== null && drag.from === n && drag.alliance === a;
          const projected = side === "red" ? slot.redProjected : slot.blueProjected;
          const won = a !== null && slot.winner === a;
          const lost = a !== null && slot.loser === a;
          const teams = a !== null ? (teamsByAlliance[a] ?? []).slice(0, 4) : [];
          const other = side === "red" ? "blue" : "red";
          const draggable = a !== null && open;
          // Regular matches show the latest game; finals show every game.
          const cells = isFinals
            ? Array.from({ length: FINALS_GAMES }, (_, i) => slot.games[i])
            : [slot.games[slot.games.length - 1]];
          return (
            <div
              key={side}
              data-slot={key}
              role={canPick ? "button" : undefined}
              tabIndex={canPick ? 0 : undefined}
              onPointerDown={draggable ? (e) => onDragStart(e, n, a) : undefined}
              onClick={() => canPick && a !== null && onPick(a)}
              onKeyDown={(e) => { if (canPick && a !== null && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(a); } }}
              className={`relative flex items-center gap-2 pl-3 pr-2 text-xs rounded-lg overflow-hidden border transition-colors
                ${isOver ? "border-primary bg-primary/15"
                  : isTarget ? "border-dashed border-primary/60 bg-primary/5"
                  : won && predicted ? "border-primary/30 bg-primary/10"
                  : "border-border/60 bg-muted/30"}
                ${isDragged ? "opacity-40" : ""}
                ${draggable ? "cursor-grab active:cursor-grabbing hover:bg-muted/60" : "cursor-default"}`}
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
                  <span className="flex-1 min-w-0 flex">
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onOpenAlliance(a); }}
                      className={`min-w-0 truncate font-mono text-[11px] tabular-nums rounded px-1 -mx-1 underline-offset-2 hover:underline hover:text-foreground cursor-pointer ${
                        lost ? "text-muted-foreground/50" : "text-muted-foreground"
                      }`}
                      title={`Alliance ${a} profile`}
                    >
                      {teams.length === 0 ? "Profile" : teams.map((t, i) => (
                        <span key={t} className={t === MY_TEAM && !lost ? "text-primary font-semibold" : ""}>{i ? " " : ""}{t}</span>
                      ))}
                    </button>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
