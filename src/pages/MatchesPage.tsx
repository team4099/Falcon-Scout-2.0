import { useState, useEffect, useMemo } from "react";
import { useQuery } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CalendarDays, Shield } from "lucide-react";
import {
  fetchStatboticsEventTeams,
  fetchTBAEventTeams,
  fetchTBAEventRankings,
  fetchTBAEventMatches,
} from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import { lsGet, lsGetStale } from "@/lib/persistentCache";

// ── helpers ────────────────────────────────────────────────────────────────────

const MY_TEAM = 4099;

function matchLabel(m: TBAMatch): string {
  const lvl: Record<string, string> = { qm: "Q", ef: "EF", qf: "QF", sf: "SF", f: "F" };
  const prefix = lvl[m.comp_level] ?? m.comp_level.toUpperCase();
  if (m.comp_level === "qm") return `${prefix}${m.match_number}`;
  return `${prefix}${m.set_number}M${m.match_number}`;
}

function matchTime(m: TBAMatch): number | null {
  return m.predicted_time ?? m.time ?? null;
}

function isPlayed(m: TBAMatch): boolean {
  return m.alliances.red.score >= 0 && m.alliances.blue.score >= 0;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "Soon";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}h ${min}m`;
  if (min > 0) return `${min}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

function readMean(v: unknown): number | null {
  if (typeof v === "number") return Number(v.toFixed(1));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.mean === "number") return Number((o.mean as number).toFixed(1));
  }
  return null;
}

function findInEpa(obj: unknown, ...keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const key of keys) {
    if (key in o) {
      const m = readMean(o[key]);
      if (m !== null) return m;
    }
  }
  for (const val of Object.values(o)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const found = findInEpa(val, ...keys);
      if (found !== null) return found;
    }
  }
  return null;
}

interface EpaBreakdown {
  total: number | null;
  auto: number | null;
  teleop: number | null;
  endgame: number | null;
}

// ── EPA progress bar ───────────────────────────────────────────────────────────

function EpaBar({ value, max, color }: { value: number | null; max: number; color: string }) {
  if (value === null || max <= 0) return null;
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="h-1.5 rounded-full bg-white/10 overflow-hidden w-full">
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

// ── Team detail card ───────────────────────────────────────────────────────────

function TeamCard({
  teamNumber, side, epa, avgScore, rank, matchSubs, fields, maxEpa,
}: {
  teamNumber: number;
  side: "red" | "blue";
  epa: EpaBreakdown;
  avgScore: number | null;
  rank: number | null;
  matchSubs: Array<{ data: string }>;
  fields: Array<{ id: string; label: string; type: string }>;
  maxEpa: number;
}) {
  const isMe = teamNumber === MY_TEAM;
  const borderColor = side === "red" ? "border-red-500/30" : "border-blue-500/30";
  const accentText  = side === "red" ? "text-red-400"   : "text-blue-400";
  const barColor    = side === "red" ? "#f87171"         : "#60a5fa";
  const bgColor     = side === "red" ? "bg-red-500/8"   : "bg-blue-500/8";

  let scoutData: Record<string, unknown> = {};
  if (matchSubs.length > 0) {
    try { scoutData = JSON.parse(matchSubs[0].data) as Record<string, unknown>; } catch { /* */ }
  }
  const numericFields = fields.filter((f) => ["number", "counter", "checkbox"].includes(f.type));

  return (
    <div
      className={`rounded-xl border ${borderColor} ${bgColor} p-3 space-y-2.5 ${
        isMe ? "ring-1 ring-yellow-400/50" : ""
      }`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {rank !== null && (
            <span className="text-[10px] font-mono text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">
              #{rank}
            </span>
          )}
          <span className={`font-bold text-sm ${isMe ? "text-yellow-400" : "text-foreground"}`}>
            {teamNumber}{isMe && " ★"}
          </span>
        </div>
        {avgScore !== null && (
          <span className="text-[10px] text-muted-foreground">~{avgScore} pts/match</span>
        )}
      </div>

      {/* EPA breakdown */}
      {epa.total !== null ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Total EPA</span>
            <span className={`text-xs font-mono font-bold ${accentText}`}>{epa.total.toFixed(1)}</span>
          </div>
          <EpaBar value={epa.total} max={maxEpa} color={barColor} />
          <div className="grid grid-cols-3 gap-1 pt-0.5">
            {[
              { label: "Auto",   val: epa.auto },
              { label: "Teleop", val: epa.teleop },
              { label: "End",    val: epa.endgame },
            ].map(({ label, val }) => (
              <div key={label} className="text-center bg-black/10 rounded-lg py-1.5">
                <div className={`text-[11px] font-mono font-semibold ${val !== null ? accentText : "text-muted-foreground/30"}`}>
                  {val !== null ? val.toFixed(1) : "—"}
                </div>
                <div className="text-[9px] text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/50 italic">No EPA data</p>
      )}

      {/* Scouting data */}
      {numericFields.length > 0 && matchSubs.length > 0 && (
        <div className="border-t border-white/5 pt-2 space-y-1">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Scouted — Match {matchSubs[0] && "data"}</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {numericFields.slice(0, 8).map((f) => {
              const val = scoutData[f.id];
              const display =
                f.type === "checkbox"
                  ? val === true || val === 1 ? "✓" : "✗"
                  : val !== undefined && val !== null && val !== ""
                  ? String(val)
                  : "—";
              return (
                <div key={f.id} className="flex items-center justify-between gap-1">
                  <span className="text-[10px] text-muted-foreground truncate">{f.label}</span>
                  <span className="text-[10px] font-mono font-semibold shrink-0">{display}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {matchSubs.length === 0 && (
        <p className="text-[10px] text-muted-foreground/40 italic">No scouting data for this match</p>
      )}
    </div>
  );
}

// ── Match Detail Panel ─────────────────────────────────────────────────────────

function MatchDetailPanel({
  match, epaDetailByTeam, avgScoreByTeam, rankByTeam,
  submissions, fields, nowMs, onClose,
}: {
  match: TBAMatch;
  epaDetailByTeam: Record<number, EpaBreakdown>;
  avgScoreByTeam: Record<number, number>;
  rankByTeam: Record<number, number>;
  submissions: Array<{ teamNumber: number; matchNumber: number; data: string }>;
  fields: Array<{ id: string; label: string; type: string }>;
  nowMs: number;
  onClose: () => void;
}) {
  const played = isPlayed(match);
  const t = matchTime(match);
  const msLeft = t ? t * 1000 - nowMs : null;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const allTeamNums = [
    ...match.alliances.red.team_keys.map((k) => Number(k.replace("frc", ""))),
    ...match.alliances.blue.team_keys.map((k) => Number(k.replace("frc", ""))),
  ];
  const maxEpa = Math.max(1, ...allTeamNums.map((tn) => epaDetailByTeam[tn]?.total ?? 0));

  const allianceEpa = (side: "red" | "blue") => {
    const tns = match.alliances[side].team_keys.map((k) => Number(k.replace("frc", "")));
    const totals = tns
      .map((tn) => epaDetailByTeam[tn]?.total ?? null)
      .filter((v): v is number => v !== null);
    return totals.length ? totals.reduce((a, b) => a + b, 0) : null;
  };
  const redEpa  = allianceEpa("red");
  const blueEpa = allianceEpa("blue");

  // Group submissions by team for this match number
  const subsByTeam: Record<number, Array<{ data: string }>> = {};
  for (const s of submissions) {
    if (s.matchNumber === match.match_number) {
      (subsByTeam[s.teamNumber] ??= []).push(s);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div
        className="fixed inset-y-0 right-0 z-50 w-full sm:w-[500px] bg-background border-l border-border shadow-2xl flex flex-col"
        style={{ animation: "slideInRight 0.22s ease-out" }}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/20 shrink-0">
          <div>
            <h3 className="text-lg font-bold">{matchLabel(match)}</h3>
            <p className="text-xs text-muted-foreground">
              {played
                ? `Final · Red ${match.alliances.red.score} – ${match.alliances.blue.score} Blue`
                : t
                ? `Scheduled ${new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "Time TBD"}
              {!played && msLeft !== null && msLeft > 0 && ` · in ${formatCountdown(msLeft)}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Alliance EPA comparison bar */}
        {(redEpa !== null || blueEpa !== null) && (
          <div className="px-5 py-3 border-b border-border bg-muted/10 shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-red-400 font-bold font-mono text-sm w-14 text-right">
                {redEpa !== null ? redEpa.toFixed(1) : "—"}
              </span>
              <div className="flex-1 flex h-2.5 rounded-full overflow-hidden gap-0.5 bg-muted/30">
                {redEpa !== null && blueEpa !== null && (() => {
                  const total = redEpa + blueEpa;
                  const redPct = total > 0 ? (redEpa / total) * 100 : 50;
                  return (
                    <>
                      <div className="bg-red-500 h-full rounded-l-full transition-all duration-700" style={{ width: `${redPct}%` }} />
                      <div className="bg-blue-500 h-full rounded-r-full flex-1" />
                    </>
                  );
                })()}
              </div>
              <span className="text-blue-400 font-bold font-mono text-sm w-14">
                {blueEpa !== null ? blueEpa.toFixed(1) : "—"}
              </span>
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5 px-16">
              <span>Red Alliance EPA</span>
              <span>Blue Alliance EPA</span>
            </div>
          </div>
        )}

        {/* Team cards — min-h-0 is required so flex-1 is bounded and overflow-y-auto kicks in */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 space-y-6">
            {(["red", "blue"] as const).map((side) => (
              <div key={side}>
                {/* Alliance section header */}
                <div className="flex items-center gap-2 mb-3">
                  <div className={`w-2.5 h-2.5 rounded-full ${side === "red" ? "bg-red-500" : "bg-blue-500"}`} />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {side} alliance
                  </span>
                  {played && (
                    <span
                      className={`ml-auto text-xs font-bold ${
                        match.winning_alliance === side
                          ? "text-green-400"
                          : match.winning_alliance === ""
                          ? "text-yellow-400"
                          : "text-muted-foreground/50"
                      }`}
                    >
                      {match.alliances[side].score} pts ·{" "}
                      {match.winning_alliance === side
                        ? "WIN"
                        : match.winning_alliance === ""
                        ? "TIE"
                        : "LOSS"}
                    </span>
                  )}
                </div>

                {/* Per-team cards */}
                <div className="space-y-2.5">
                  {match.alliances[side].team_keys.map((tk) => {
                    const tn = Number(tk.replace("frc", ""));
                    return (
                      <TeamCard
                        key={tk}
                        teamNumber={tn}
                        side={side}
                        epa={epaDetailByTeam[tn] ?? { total: null, auto: null, teleop: null, endgame: null }}
                        avgScore={avgScoreByTeam[tn] ?? null}
                        rank={rankByTeam[tn] ?? null}
                        matchSubs={subsByTeam[tn] ?? []}
                        fields={fields}
                        maxEpa={maxEpa}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </>
  );
}

// ── MatchesPage ────────────────────────────────────────────────────────────────

export default function MatchesPage() {
  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const eventKey = currentEvent?.eventKey ?? "";
  const eventYear = eventKey ? Number(eventKey.slice(0, 4)) : new Date().getFullYear();

  // Scouting submissions for this event
  const allSubsLive = useQuery(api.forms.listSubmissions, eventKey ? { eventKey } : "skip");
  const allSubs = useCached(allSubsLive, `submissions_${eventKey}`) as
    Array<{ teamNumber: number; matchNumber: number; data: string }> | null;

  const templateLive = useQuery(api.forms.getActiveTemplate);
  const template = useCached(templateLive, "active_template");
  const fields = (template?.fields as Array<{ id: string; label: string; type: string }>) ?? [];

  // Seed from cache immediately so the list renders on first mount even offline
  const [matches,         setMatches]         = useState<TBAMatch[]>(
    () => lsGet<TBAMatch[]>(`tba_matches_${currentEvent?.eventKey ?? ""}`) ??
          lsGetStale<TBAMatch[]>(`tba_matches_${currentEvent?.eventKey ?? ""}`) ?? []
  );
  const [epaDetailByTeam, setEpaDetailByTeam] = useState<Record<number, EpaBreakdown>>({});
  const [avgScoreByTeam,  setAvgScoreByTeam]  = useState<Record<number, number>>({});
  const [rankByTeam,      setRankByTeam]      = useState<Record<number, number>>({});
  const [nowMs,           setNowMs]           = useState(Date.now());
  const [filterMine,      setFilterMine]      = useState(false);
  const [selectedMatch,   setSelectedMatch]   = useState<TBAMatch | null>(null);

  // Simple total-EPA map for the list view
  const epaByTeam = useMemo<Record<number, number | null>>(() => {
    const m: Record<number, number | null> = {};
    for (const [k, v] of Object.entries(epaDetailByTeam)) m[Number(k)] = v.total;
    return m;
  }, [epaDetailByTeam]);

  // Live clock
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;

    async function load() {
      const [matchData, sbData, , rankData] = await Promise.all([
        fetchTBAEventMatches(eventKey),
        fetchStatboticsEventTeams(eventKey),
        fetchTBAEventTeams(eventKey),
        fetchTBAEventRankings(eventKey),
      ]);
      if (cancelled) return;

      if (Array.isArray(matchData)) {
        setMatches(matchData as TBAMatch[]);

        // Per-team avg alliance score from played qual matches
        const totals: Record<number, { sum: number; count: number }> = {};
        for (const m of matchData as TBAMatch[]) {
          if (m.comp_level !== "qm") continue;
          for (const side of ["red", "blue"] as const) {
            const a = m.alliances[side];
            if (!a || a.score < 0) continue;
            for (const tk of a.team_keys) {
              const tn = Number(tk.replace("frc", ""));
              if (!tn) continue;
              if (!totals[tn]) totals[tn] = { sum: 0, count: 0 };
              totals[tn].sum += a.score;
              totals[tn].count += 1;
            }
          }
        }
        const avgMap: Record<number, number> = {};
        for (const [t, { sum, count }] of Object.entries(totals)) {
          if (count > 0) avgMap[Number(t)] = Math.round(sum / count);
        }
        setAvgScoreByTeam(avgMap);
      }

      if (Array.isArray(sbData)) {
        const detailMap: Record<number, EpaBreakdown> = {};
        for (const t of sbData as Array<{ team: number; epa: unknown }>) {
          const e = t.epa as Record<string, unknown> | null;
          detailMap[t.team] = {
            total:   e ? (findInEpa(e, "total_points", "total") ?? readMean(e)) : null,
            auto:    e ? findInEpa(e, "auto_points",   "auto")    : null,
            teleop:  e ? findInEpa(e, "teleop_points", "teleop")  : null,
            endgame: e ? findInEpa(e, "endgame_points","endgame") : null,
          };
        }
        setEpaDetailByTeam(detailMap);
      }

      if (rankData && typeof rankData === "object" && "rankings" in rankData) {
        const rmap: Record<number, number> = {};
        for (const r of (rankData as { rankings: Array<{ team_key: string; rank: number }> }).rankings) {
          rmap[Number(r.team_key.replace("frc", ""))] = r.rank;
        }
        setRankByTeam(rmap);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [eventKey, eventYear]);

  const sorted = useMemo(() => {
    let list = [...matches].sort((a, b) => {
      const ta = matchTime(a) ?? 9e12;
      const tb = matchTime(b) ?? 9e12;
      if (ta !== tb) return ta - tb;
      if (a.comp_level === b.comp_level) return a.match_number - b.match_number;
      return 0;
    });
    if (filterMine) {
      list = list.filter(
        (m) =>
          m.alliances.red.team_keys.includes(`frc${MY_TEAM}`) ||
          m.alliances.blue.team_keys.includes(`frc${MY_TEAM}`)
      );
    }
    return list;
  }, [matches, filterMine]);

  if (!eventKey) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground">
        <CalendarDays className="h-10 w-10 opacity-20" />
        <p className="text-sm">No event selected. Set one in Settings.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Match Schedule</h2>
          <p className="text-muted-foreground text-sm">
            {currentEvent?.eventName ?? eventKey}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilterMine(false)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              !filterMine
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            All Matches
          </button>
          <button
            onClick={() => setFilterMine(true)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
              filterMine
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            <Shield className="h-3 w-3" />
            #{MY_TEAM} Only
          </button>
          <span className="text-xs text-muted-foreground ml-1">
            {sorted.length} match{sorted.length !== 1 ? "es" : ""}
          </span>
        </div>
      </div>

      {/* Match list */}
      {matches.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-muted-foreground">
          <CalendarDays className="h-8 w-8 opacity-30" />
          <p className="text-sm">No match schedule posted yet.</p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="space-y-2 pb-4">
            {sorted.map((m) => {
              const played = isPlayed(m);
              const t = matchTime(m);
              const msLeft = t ? t * 1000 - nowMs : null;
              const involves4099 =
                m.alliances.red.team_keys.includes(`frc${MY_TEAM}`) ||
                m.alliances.blue.team_keys.includes(`frc${MY_TEAM}`);

              return (
                <button
                  key={m.key}
                  onClick={() => setSelectedMatch(m)}
                  className={`w-full text-left rounded-xl border bg-card overflow-hidden transition-all
                    hover:shadow-md hover:border-primary/40
                    ${involves4099 ? "border-primary/50 shadow-sm shadow-primary/10" : "border-border"}`}
                >
                  {/* Match header bar */}
                  <div
                    className={`flex items-center gap-3 px-4 py-2.5 ${
                      involves4099 ? "bg-primary/8" : "bg-muted/20"
                    }`}
                  >
                    <span className="font-bold text-sm w-14 shrink-0">{matchLabel(m)}</span>

                    {played ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono font-bold px-2.5 py-0.5 rounded-md bg-red-500/15 text-red-400 border border-red-500/30">
                          {m.alliances.red.score}
                        </span>
                        <span className="text-muted-foreground text-sm">–</span>
                        <span className="text-sm font-mono font-bold px-2.5 py-0.5 rounded-md bg-blue-500/15 text-blue-400 border border-blue-500/30">
                          {m.alliances.blue.score}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        {t && (
                          <span>
                            {new Date(t * 1000).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        )}
                        {msLeft !== null && msLeft > 0 && (
                          <span
                            className={`font-mono font-semibold tabular-nums ${
                              msLeft < 5 * 60 * 1000 ? "text-red-400" : "text-foreground"
                            }`}
                          >
                            in {formatCountdown(msLeft)}
                          </span>
                        )}
                        {msLeft !== null && msLeft <= 0 && (
                          <span className="text-amber-400 font-semibold animate-pulse">Now</span>
                        )}
                      </div>
                    )}

                    <div className="ml-auto flex items-center gap-2">
                      {involves4099 && (
                        <span className="text-[10px] font-bold text-primary uppercase tracking-widest">
                          ★ Our Match
                        </span>
                      )}
                      <svg
                        width="14" height="14" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2"
                        className="text-muted-foreground/40 shrink-0"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </div>
                  </div>

                  {/* Alliances */}
                  <div className="px-4 py-3 flex flex-col gap-2">
                    {(["red", "blue"] as const).map((side) => {
                      const allianceWon = played && m.winning_alliance === side;
                      const allianceTied = played && m.winning_alliance === "";
                      return (
                        <div key={side} className="flex items-center gap-3">
                          <div
                            className={`w-1 h-8 rounded-full shrink-0 ${
                              side === "red" ? "bg-red-500" : "bg-blue-500"
                            }`}
                          />
                          <div className="flex-1 flex flex-wrap gap-2">
                            {m.alliances[side].team_keys.map((tk) => {
                              const tn = Number(tk.replace("frc", ""));
                              const isMe = tn === MY_TEAM;
                              const epa  = epaByTeam[tn] ?? null;
                              const avg  = avgScoreByTeam[tn] ?? null;
                              const rank = rankByTeam[tn] ?? null;
                              return (
                                <div
                                  key={tk}
                                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                                    isMe
                                      ? "bg-yellow-400/10 border-yellow-400/50 font-bold"
                                      : side === "red"
                                      ? "bg-red-500/5 border-red-500/20"
                                      : "bg-blue-500/5 border-blue-500/20"
                                  }`}
                                >
                                  {rank && (
                                    <span className="text-[10px] text-muted-foreground font-mono">
                                      #{rank}
                                    </span>
                                  )}
                                  <span className={isMe ? "text-foreground" : ""}>
                                    {tn}
                                    {isMe && <span className="ml-0.5 text-yellow-400">★</span>}
                                  </span>
                                  {epa !== null && (
                                    <span
                                      className={`text-[10px] font-mono ${
                                        side === "red" ? "text-red-400" : "text-blue-400"
                                      }`}
                                    >
                                      {epa.toFixed(1)}
                                    </span>
                                  )}
                                  {avg !== null && (
                                    <span className="text-[10px] text-muted-foreground">~{avg}</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {played && (
                            <span
                              className={`text-xs font-bold ml-auto shrink-0 ${
                                allianceWon ? "text-green-400" : allianceTied ? "text-yellow-400" : "text-muted-foreground/50"
                              }`}
                            >
                              {allianceWon ? "W" : allianceTied ? "T" : "L"}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {/* Detail panel — rendered at page level, overlays via fixed positioning */}
      {selectedMatch && (
        <MatchDetailPanel
          match={selectedMatch}
          epaDetailByTeam={epaDetailByTeam}
          avgScoreByTeam={avgScoreByTeam}
          rankByTeam={rankByTeam}
          submissions={allSubs ?? []}
          fields={fields}
          nowMs={nowMs}
          onClose={() => setSelectedMatch(null)}
        />
      )}
    </div>
  );
}
