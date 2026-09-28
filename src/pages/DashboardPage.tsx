import { useState, useEffect, useMemo } from "react";
import { useUIStore } from "@/store/uiStore";
import { useQuery } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { useEventTeamData } from "@/hooks/useEventTeamData";
import { api } from "../../convex/_generated/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchTBATeamAvatar, fetchTBATeamInfo } from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import { EMPTY_TEAM_EPA } from "@/lib/epa";
import type { TeamEpa } from "@/lib/epa";
import { ExternalLink, Search, FileText, TrendingUp, Clock, CalendarCheck, Trophy, CalendarDays, Rows3, Table2, Columns3, EyeOff, Eye } from "lucide-react";
import TeamDetailPanel from "@/pages/TeamDetailPanel";
import { useMutation } from "convex/react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BUILTIN_COLUMNS,
  REPORTS_COLUMN_ID,
  visibleColumns,
} from "@/lib/rankingColumns";
import type { FieldCell, RankingColumn } from "@/lib/rankingColumns";
import type { FormField as TemplateField } from "@/types";
import { idbGet, lsGetStale } from "@/lib/persistentCache";

// ── Types ─────────────────────────────────────────────────────────────────────

type FormField = TemplateField;

interface Submission {
  _id: string;
  templateId: string;
  teamNumber: number;
  matchNumber: number;
  compLevel?: "qm" | "elim";
  scoutId?: string;
  syncedAt?: number;
  data: string; // JSON string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseSubmissions(submissions: Submission[]): Record<string, unknown>[] {
  return submissions.map((s) => {
    try { return JSON.parse(s.data) as Record<string, unknown>; }
    catch { return {}; }
  });
}

// ── Text popup ────────────────────────────────────────────────────────────────

function TextSubmissionsDialog({
  open,
  onClose,
  teamNumber,
  submissions,
  textFields,
}: {
  open: boolean;
  onClose: () => void;
  teamNumber: number;
  submissions: Submission[];
  textFields: FormField[];
}) {
  const parsed = parseSubmissions(submissions);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl flex flex-col overflow-hidden" style={{ maxHeight: "80vh" }}>
        <DialogHeader className="shrink-0">
          <DialogTitle>
            Scouting Reports — {teamNumber}
          </DialogTitle>
        </DialogHeader>

        {/* Scroll container — plain div beats ScrollArea for flex containment */}
        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          {submissions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No submissions yet.</p>
          ) : (
            <div className="space-y-4 pb-2">
              {submissions.map((s, i) => {
                const data = parsed[i];
                const hasText = textFields.some(
                  (f) => data[f.id] && String(data[f.id]).trim() !== ""
                );
                if (!hasText) return null;
                return (
                  <div key={i} className="border border-border rounded-lg p-3 space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Match {s.matchNumber}
                    </p>
                    {textFields.map((f) => {
                      const val = String(data[f.id] ?? "").trim();
                      if (!val) return null;
                      return (
                        <div key={f.id}>
                          <p className="text-xs text-muted-foreground font-medium">{f.label}</p>
                          <p
                            className="text-sm mt-0.5 whitespace-pre-wrap leading-relaxed"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {val}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {parsed.every((d) => textFields.every((f) => !d[f.id] || String(d[f.id]).trim() === "")) && (
                <p className="text-sm text-muted-foreground py-4 text-center">No text notes found.</p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Team row ──────────────────────────────────────────────────────────────────

/** Reusable avatar — same logic as Kanban TeamAvatar */
function TeamAvatar({ teamNumber, avatar, size = 32 }: { teamNumber: number; avatar: string | null | "loading"; size?: number }) {
  const palette = ["#6366f1","#8b5cf6","#ec4899","#f97316","#eab308","#22c55e","#06b6d4","#3b82f6"];
  const color = palette[teamNumber % palette.length];
  if (avatar && avatar !== "loading") {
    return <img src={avatar} alt={`Team ${teamNumber}`} width={size} height={size}
      className="rounded object-contain bg-white shrink-0" style={{ width: size, height: size }} />;
  }
  return (
    <div className="rounded flex items-center justify-center text-white font-bold shrink-0"
      style={{ width: size, height: size, background: color, fontSize: size * 0.3 }}>
      {teamNumber}
    </div>
  );
}

// Eagerly prime the idb avatar cache into a module-level Map so
// TeamRow components can read it synchronously on first render
// (avoids the "loading" flash when the component remounts).
const _avatarMemCache = new Map<string, string | null>();

async function primeAvatar(teamNumber: number, year: number) {
  const key = `${teamNumber}_${year}`;
  if (_avatarMemCache.has(key)) return;
  const cached = await idbGet<string | null>(`tba_avatar_${teamNumber}_${year}`);
  if (cached !== null && cached !== undefined) {
    _avatarMemCache.set(key, cached);
  }
}

/** Grid template shared by the header and every row so cells always line up. */
function gridTemplate(columns: RankingColumn[]): string {
  return columns.map((c) => `minmax(${c.width}px, 1fr)`).join(" ");
}

type StatColor = "default" | "primary" | "success" | "muted";

function TeamRow({
  teamNumber,
  eventYear,
  submissions,
  epa,
  avgScore,
  tbaRank,
  fields,
  columns,
  fieldCells,
  onOpenDetail,
  onHide,
  forceTable = false,
}: {
  teamNumber: number;
  eventYear: number;
  submissions: Submission[];
  epa: TeamEpa;
  avgScore: number | null;
  tbaRank: Record<string, unknown> | null;
  fields: FormField[];
  /** Visible columns, in display order. */
  columns: RankingColumn[];
  /** This team's aggregated values for tagged form-field columns. */
  fieldCells: Record<string, FieldCell>;
  onOpenDetail: () => void;
  /** Moves this team to the "Hidden teams" section below the list. */
  onHide: () => void;
  /** When true, always render the column-table row layout, even below the
   *  sm breakpoint — used for the mobile "table view" toggle. */
  forceTable?: boolean;
}) {
  const [textOpen, setTextOpen] = useState(false);
  // Read from the in-memory avatar cache synchronously to avoid the
  // "loading" flash when this component remounts (e.g. after tbaTeams loads).
  const memKey = `${teamNumber}_${eventYear}`;
  const [avatar, setAvatar] = useState<string | null | "loading">(
    _avatarMemCache.has(memKey) ? (_avatarMemCache.get(memKey) ?? null) : "loading"
  );
  const [nickname, setNickname] = useState<string | null>(
    (lsGetStale<{ nickname?: string }>(`tba_team_${teamNumber}`) as { nickname?: string } | null)?.nickname ?? null
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [info, av] = await Promise.all([
        fetchTBATeamInfo(teamNumber),
        fetchTBATeamAvatar(teamNumber, eventYear),
      ]);
      if (cancelled) return;
      setNickname(info?.nickname ?? null);
      if (av !== null) {
        _avatarMemCache.set(memKey, av);
      }
      setAvatar(av);
    }
    // Only fetch if we don't already have a good value
    if (avatar === "loading") {
      load();
    }
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamNumber, eventYear]);

  const rank = tbaRank ? (tbaRank as { rank: number }).rank : null;
  const record = tbaRank
    ? (tbaRank as { record: { wins: number; losses: number; ties: number } }).record
    : null;

  const parsed = parseSubmissions(submissions);

  // Text fields feed the "Scouting Reports" notes popup.
  const textFields = fields.filter((f) => f.type === "text" || f.type === "textarea");
  const hasTextData = textFields.some((f) =>
    parsed.some((d) => d[f.id] && String(d[f.id]).trim() !== "")
  );

  const num = (v: number | null, color: StatColor = "default") =>
    ({ value: v !== null ? String(v) : "—", color: v !== null ? color : ("muted" as StatColor) });
  const builtin: Record<string, { value: string; color: StatColor }> = {
    rank: { value: rank !== null ? `#${rank}` : "—", color: rank !== null ? "default" : "muted" },
    avgScore: { value: avgScore !== null ? Number(avgScore.toFixed(0)).toString() : "—", color: avgScore !== null ? "default" : "muted" },
    epaEvent: num(epa.event, "primary"),
    epaOverall: num(epa.overall, "primary"),
    epaAuto: num(epa.auto),
    epaTeleop: num(epa.teleop),
    epaEndgame: num(epa.endgame),
  };
  const statFor = (c: RankingColumn): { value: string; color: StatColor } => {
    if (builtin[c.id]) return builtin[c.id];
    const cell = fieldCells[c.id];
    return cell && cell.sort !== null
      ? { value: cell.display, color: "default" }
      : { value: "—", color: "muted" };
  };

  const showReports = columns.some((c) => c.id === REPORTS_COLUMN_ID);
  const statColumns = columns.filter((c) => c.id !== REPORTS_COLUMN_ID);

  const reportsButton = hasTextData ? (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 gap-1.5 text-muted-foreground hover:text-foreground"
      title="View scouting reports"
      onClick={(e) => { e.stopPropagation(); setTextOpen(true); }}
    >
      <FileText className="h-3.5 w-3.5" />
      <span className="text-xs">View</span>
    </Button>
  ) : (
    <span className="text-xs text-muted-foreground">—</span>
  );

  const hideButton = (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
      title={`Hide team ${teamNumber}`}
      aria-label={`Hide team ${teamNumber}`}
      onClick={(e) => { e.stopPropagation(); onHide(); }}
    >
      <EyeOff className="h-3.5 w-3.5" />
    </Button>
  );

  return (
    <>
      {/* ── Mobile card layout (hidden on sm+, and hidden below sm when forceTable is on) ── */}
      <div
        className={`${forceTable ? "hidden" : "block"} sm:hidden border-b border-border px-3 py-3 hover:bg-muted/20 active:bg-muted/30 transition-colors cursor-pointer`}
        onClick={onOpenDetail}
      >
        {/* Top row: avatar + team info + reports */}
        <div className="flex items-start gap-3">
          <TeamAvatar teamNumber={teamNumber} avatar={avatar} size={36} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <p className="font-bold text-base leading-tight">{teamNumber}</p>
              {rank && <span className="text-xs text-muted-foreground font-mono">#{rank}</span>}
              {record && (
                <span className="text-xs font-mono text-muted-foreground">
                  {record.wins}-{record.losses}-{record.ties}
                </span>
              )}
            </div>
            {nickname && (
              <p className="text-xs text-muted-foreground truncate leading-snug mt-0.5">{nickname}</p>
            )}
          </div>
          {showReports && hasTextData && reportsButton}
          {hideButton}
        </div>

        {/* Stats chips — wrap freely, no fixed columns */}
        <div className="mt-2.5 flex flex-wrap gap-x-2 gap-y-1.5">
          {statColumns
            .map((c) => ({ c, s: statFor(c) }))
            .filter(({ s }) => s.value !== "—")
            .map(({ c, s }) => (
              <StatChip key={c.id} label={c.label} value={s.value} color={s.color} />
            ))}
        </div>
      </div>

      {/* ── Desktop table row (hidden on mobile, unless forceTable is on) ── */}
      <div
        className={`${forceTable ? "flex" : "hidden"} sm:flex items-center gap-3 px-4 py-3 border-b border-border hover:bg-muted/30 transition-colors cursor-pointer`}
        onClick={onOpenDetail}
      >
        {/* Avatar + team # */}
        <div className="flex items-center gap-2 w-36 shrink-0 sticky left-0 z-10 -ml-4 pl-4 py-3 -my-3 bg-card">
          <TeamAvatar teamNumber={teamNumber} avatar={avatar} size={30} />
          <div className="min-w-0">
            {rank && (
              <span className="text-[10px] text-muted-foreground font-mono block">#{rank}</span>
            )}
            <p className="font-bold text-sm leading-tight">{teamNumber}</p>
            {nickname && (
              <p className="text-[10px] text-muted-foreground truncate leading-tight">{nickname}</p>
            )}
            {record && (
              <span className="text-[10px] font-mono text-muted-foreground">
                {record.wins}-{record.losses}-{record.ties}
              </span>
            )}
          </div>
        </div>

        {/* Stats columns — same grid template as the header */}
        <div className="flex-1 grid gap-x-4 gap-y-1 min-w-0 items-center"
          style={{ gridTemplateColumns: gridTemplate(columns) }}
        >
          {columns.map((c) => {
            if (c.id === REPORTS_COLUMN_ID) return <div key={c.id}>{reportsButton}</div>;
            const s = statFor(c);
            return <StatChip key={c.id} label={c.label} value={s.value} color={s.color} />;
          })}
        </div>
        {hideButton}
      </div>

      {hasTextData && (
        <TextSubmissionsDialog
          open={textOpen}
          onClose={() => setTextOpen(false)}
          teamNumber={teamNumber}
          submissions={submissions}
          textFields={textFields}
        />
      )}
    </>
  );
}

function StatChip({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: "default" | "primary" | "success" | "muted";
}) {
  const colorClass =
    color === "primary"
      ? "border-primary/40 text-primary bg-primary/5"
      : color === "success"
        ? "border-green-500/40 text-green-600 dark:text-green-400 bg-green-500/5"
        : color === "muted"
          ? "border-border text-muted-foreground"
          : "border-border text-foreground";

  return (
    <div className="flex flex-col min-w-[52px]">
      <span className="text-[10px] text-muted-foreground leading-none truncate max-w-[96px]">{label}</span>
      <span className={`text-xs font-semibold font-mono mt-0.5 px-1.5 py-0.5 rounded border w-fit ${colorClass}`}>
        {value}
      </span>
    </div>
  );
}

// ── Column header row ───────────────────────────────────────────────────────────────────

/** A header cell that sorts. The caret only renders on the active column, so
 *  the header stays quiet until you actually sort by something. */
function SortHeader({ id, label, title, sortKey, sortDir, onSort }: {
  id: string; label: string; title?: string;
  sortKey: string | null; sortDir: "asc" | "desc"; onSort: (key: string) => void;
}) {
  const active = sortKey === id;
  return (
    <button
      type="button"
      onClick={() => onSort(id)}
      title={title ?? `Sort by ${label}`}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      className={`flex items-center gap-0.5 text-left uppercase tracking-wider font-semibold transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm min-w-0 ${
        active ? "text-foreground" : ""
      }`}
    >
      <span className="truncate">{label}</span>
      {active && <span aria-hidden className="shrink-0">{sortDir === "asc" ? "▲" : "▼"}</span>}
    </button>
  );
}

function ColumnHeader({
  columns, sortKey, sortDir, onSort,
}: {
  columns: RankingColumn[];
  sortKey: string | null;
  sortDir: "asc" | "desc";
  onSort: (key: string) => void;
}) {
  const sort = { sortKey, sortDir, onSort };
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-muted/40 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sticky top-0">
      <div className="w-36 shrink-0 sticky left-0 z-10 -ml-4 pl-4 bg-card">
        <SortHeader id="team" label="Team" {...sort} />
      </div>
      <div className="flex-1 grid gap-x-4" style={{ gridTemplateColumns: gridTemplate(columns) }}>
        {columns.map((c) =>
          c.sortable
            ? <SortHeader key={c.id} id={c.id} label={c.label} title={c.id === "rank" ? "Sort by event ranking" : undefined} {...sort} />
            : <span key={c.id} className="truncate">{c.label}</span>
        )}
      </div>
      {/* Spacer matching each row's hide button */}
      <div className="w-8 shrink-0" />
    </div>
  );
}

// ── Match helpers ──────────────────────────────────────────────────────────────

const MY_TEAM = 4099;

function matchLabel(m: TBAMatch): string {
  const lvl: Record<string, string> = { qm: "Q", ef: "EF", qf: "QF", sf: "SF", f: "F" };
  const prefix = lvl[m.comp_level] ?? m.comp_level.toUpperCase();
  if (m.comp_level === "qm") return `${prefix}${m.match_number}`;
  return `${prefix}${m.set_number}M${m.match_number}`;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "Now";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}h ${min}m`;
  if (min > 0) return `${min}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

function matchTime(m: TBAMatch): number | null {
  return m.predicted_time ?? m.time ?? null;
}

function isPlayed(m: TBAMatch): boolean {
  return m.alliances.red.score >= 0 && m.alliances.blue.score >= 0;
}

/**
 * isConsideredPlayed — returns true if TBA has posted scores OR if the match
 * scheduled time is more than 10 minutes in the past (match duration ~8 min).
 * This keeps widgets advancing in real-time even when offline and TBA match
 * data is stale/cached.
 */
function isConsideredPlayed(m: TBAMatch, nowMs: number): boolean {
  if (isPlayed(m)) return true;
  const t = matchTime(m);
  if (t !== null && nowMs - t * 1000 > 10 * 60 * 1000) return true;
  return false;
}

// Compact team pill used in next-match banner and schedule rows
function MatchTeamPill({
  teamNumber,
  epa,
  rank,
  isMyTeam,
  side,
}: {
  teamNumber: number;
  epa: number | null;
  rank: number | null;
  isMyTeam: boolean;
  side: "red" | "blue";
}) {
  const borderColor = side === "red" ? "border-red-500/60" : "border-blue-500/60";
  const myHighlight = isMyTeam
    ? side === "red"
      ? "bg-red-500/15 ring-1 ring-red-400"
      : "bg-blue-500/15 ring-1 ring-blue-400"
    : "bg-muted/30";

  return (
    <div className={`flex flex-col items-center px-2 py-1 rounded-lg border ${borderColor} ${myHighlight} min-w-[60px]`}>
      {rank && <span className="text-[9px] text-muted-foreground font-mono">#{rank}</span>}
      <span className={`text-sm font-bold leading-tight ${isMyTeam ? "text-foreground" : "text-foreground/80"}`}>
        {teamNumber}
        {isMyTeam && <span className="ml-0.5 text-yellow-400 text-xs">★</span>}
      </span>
      {epa !== null && (
        <span className="text-[9px] font-mono text-muted-foreground mt-0.5">{epa.toFixed(1)} EPA</span>
      )}
    </div>
  );
}

// ── Next Match Banner (Nexus-powered) ─────────────────────────────────────────

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s.includes("field") || s.includes("onfield"))
    return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/40 animate-pulse">On Field</span>;
  if (s.includes("deck") || s.includes("ondeck"))
    return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/40">On Deck</span>;
  if (s.includes("queu"))
    return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/40">Queuing</span>;
  if (s.includes("scoring") || s.includes("post"))
    return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">Scoring</span>;
  return null;
}

function NextMatchBanner({
  match,
  eventKey,
  matchData,
  nowMs,
  epaMap,
  tbaRankings,
}: {
  match: TBAMatch | null;
  eventKey: string;
  matchData: TBAMatch[];
  nowMs: number;
  epaMap: Record<number, TeamEpa>;
  tbaRankings: Record<number, Record<string, unknown>>;
}) {
  const [nexus, setNexus] = useState<import("@/lib/api").NexusTeamStatus | null>(null);

  // Poll Nexus every 30 s for live queue status (only when there's an upcoming match)
  useEffect(() => {
    if (!eventKey || !match) return;
    let cancelled = false;
    async function poll() {
      const status = await import("@/lib/api").then((m) =>
        m.fetchNexusTeamStatus(eventKey, MY_TEAM)
      );
      if (!cancelled) setNexus(status);
    }
    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [eventKey, match]);

  function rank(tn: number) {
    const r = tbaRankings[tn];
    return r ? (r as { rank: number }).rank : null;
  }

  // ── Determine display state ───────────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const tomorrowMs = todayMs + 86_400_000;

  const matchT = match ? matchTime(match) : null;
  const matchMs = matchT ? matchT * 1000 : null;
  const isToday = matchMs !== null && matchMs >= todayMs && matchMs < tomorrowMs;
  const isFuture = matchMs !== null && matchMs >= tomorrowMs;
  const msLeft = matchMs ? matchMs - nowMs : null;

  // All 4099 matches (for context when there's no upcoming match today)
  const all4099 = matchData.filter(
    (m) =>
      m.alliances.red.team_keys.includes(`frc${MY_TEAM}`) ||
      m.alliances.blue.team_keys.includes(`frc${MY_TEAM}`)
  );
  const allDone = all4099.length > 0 && all4099.every((m) => isConsideredPlayed(m, nowMs));
  const noneScheduled = all4099.length === 0 && matchData.length > 0;

  // ── No upcoming match states ──────────────────────────────────────────────
  if (!match || (!isToday && !isFuture)) {
    return (
      <div className="rounded-xl border border-border bg-card p-3 sm:p-4 flex items-center gap-3 h-full">
        <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
          <Clock className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">#{MY_TEAM} · Next Match</p>
          {allDone && (
            <p className="text-base font-semibold text-green-400">🏁 All matches complete</p>
          )}
          {noneScheduled && (
            <p className="text-base font-semibold text-muted-foreground">No matches scheduled</p>
          )}
          {!allDone && !noneScheduled && (
            <p className="text-base font-semibold text-muted-foreground">No matches today</p>
          )}
        </div>
      </div>
    );
  }

  // ── Future match (not today) ──────────────────────────────────────────────
  if (isFuture && match) {
    const dayLabel = new Date(matchMs!).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    const timeLabel = new Date(matchMs!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
      <div className="rounded-xl border border-border bg-card p-3 sm:p-4 flex items-center gap-3 h-full">
        <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
          <Clock className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground">#{MY_TEAM} · Next Match</p>
          <p className="text-base font-bold">
            No matches today
            <span className="text-muted-foreground font-normal text-sm ml-2">
              · Next: {matchLabel(match)} on {dayLabel} at {timeLabel}
            </span>
          </p>
          {msLeft !== null && msLeft > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              In {formatCountdown(msLeft)}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Today's upcoming match — full banner ──────────────────────────────────
  const myAlliance = match.alliances.red.team_keys.includes(`frc${MY_TEAM}`) ? "red" : "blue";
  const oppAlliance = myAlliance === "red" ? "blue" : "red";

  const allianceLabel = (side: "red" | "blue") =>
    side === "red"
      ? <span className="text-xs font-bold text-red-400 uppercase tracking-widest">Red</span>
      : <span className="text-xs font-bold text-blue-400 uppercase tracking-widest">Blue</span>;

  const urgency = msLeft !== null && msLeft < 5 * 60 * 1000;

  return (
    <div className={`rounded-xl border bg-card p-3 sm:p-4 flex flex-col sm:flex-row gap-3 sm:gap-6 items-start sm:items-center transition-colors h-full ${
      urgency ? "border-red-500/50 shadow-sm shadow-red-500/10" : "border-border"
    }`}>
      {/* Left: match label + Nexus queue status */}
      <div className="shrink-0 min-w-[140px]">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
          <Clock className="h-3.5 w-3.5" />
          <span>#{MY_TEAM} · Next Match</span>
          {nexus && statusBadge(nexus.status)}
        </div>
        <p className="text-lg font-bold tracking-tight">{matchLabel(match)}</p>

        {/* Nexus queue time — primary if available */}
        {nexus?.minutesUntilQueue !== null && nexus?.minutesUntilQueue !== undefined ? (
          <div className="mt-1">
            <p className="text-[10px] text-muted-foreground">Queue in</p>
            <p className={`text-2xl font-mono font-bold tabular-nums ${
              (nexus.minutesUntilQueue ?? 99) <= 5 ? "text-red-400 animate-pulse" : "text-primary"
            }`}>
              {nexus.minutesUntilQueue}m
            </p>
          </div>
        ) : msLeft !== null && msLeft > 0 ? (
          /* TBA countdown — shown when Nexus has no queue data yet */
          <div className="mt-1">
            <p className="text-[10px] text-muted-foreground">Est. time</p>
            <p className={`text-2xl font-mono font-bold tabular-nums ${
              urgency ? "text-red-400 animate-pulse" : "text-primary"
            }`}>
              {formatCountdown(msLeft)}
            </p>
          </div>
        ) : msLeft !== null && msLeft <= 0 ? (
          <p className="text-lg font-bold text-amber-400 animate-pulse mt-1">Now</p>
        ) : null}

        {/* Scheduled wall-clock time */}
        {matchT && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {new Date(matchT * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
        )}
      </div>

      {/* Vertical divider */}
      <div className="hidden sm:block w-px self-stretch bg-border" />

      {/* Alliance rows */}
      <div className="flex-1 flex flex-col gap-2 min-w-0">
        {([myAlliance, oppAlliance] as const).map((side) => (
          <div key={side} className="flex items-center gap-2">
            {allianceLabel(side)}
            <div className="flex gap-1.5 flex-wrap">
              {match.alliances[side].team_keys.map((tk) => {
                const tn = Number(tk.replace("frc", ""));
                return (
                  <MatchTeamPill
                    key={tk}
                    teamNumber={tn}
                    epa={epaMap[tn]?.event ?? null}
                    rank={rank(tn)}
                    isMyTeam={tn === MY_TEAM}
                    side={side}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Position helpers (shared) ─────────────────────────────────────────────────

const POS_LABEL: Record<string, string> = {
  red1: "Red 1", red2: "Red 2", red3: "Red 3",
  blue1: "Blue 1", blue2: "Blue 2", blue3: "Blue 3",
};

function posColor(pos: string): string {
  return pos.startsWith("red") ? "text-red-400" : "text-blue-400";
}

// ── My Scouting Assignments panel ─────────────────────────────────────────────

interface MyAssignment {
  _id: string;
  matchNumber: number;
  matchLabel: string;
  position: string;
}

function MyScouting({
  eventKey,
  matchData,
  nowMs,
}: {
  eventKey: string;
  matchData: TBAMatch[];
  nowMs: number;
}) {
  const assignmentsLive = useQuery(
    api.schedules.getMyMatchAssignments,
    eventKey ? { eventKey } : "skip"
  );
  // useCached so assignments are visible offline from stale localStorage
  const assignments = (useCached(assignmentsLive, `my_assignments_${eventKey || "none"}`) ?? []) as MyAssignment[];

  const upcoming = useMemo(() => {
    if (!assignments.length) return [];
    const matchMap = new Map<number, TBAMatch>();
    for (const m of matchData) matchMap.set(m.match_number, m);
    return assignments
      .map((a) => ({ assignment: a, match: matchMap.get(a.matchNumber) ?? null }))
      .filter(({ match }) => !match || !isConsideredPlayed(match, nowMs))
      .sort((a, b) => {
        const ta = a.match ? (matchTime(a.match) ?? 9e12) : 9e12;
        const tb = b.match ? (matchTime(b.match) ?? 9e12) : 9e12;
        return ta - tb;
      })
      .slice(0, 1);
  }, [assignments, matchData, nowMs]);

  const loading = assignmentsLive === undefined;

  return (
    <div className="rounded-xl border border-border bg-card flex flex-col h-full min-h-0">
      {/* Card header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2 border-b border-border shrink-0">
        <div className="h-6 w-6 rounded-md bg-primary/15 flex items-center justify-center">
          <CalendarCheck className="h-3.5 w-3.5 text-primary" />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Next Assignment</p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
        {loading ? (
          <div className="space-y-1.5 p-1">
            <div className="flex items-center gap-2 px-2 py-2 rounded-lg">
              <div className="h-7 w-7 rounded-md bg-muted animate-pulse shrink-0" />
              <div className="space-y-1 flex-1">
                <div className="h-2.5 w-14 bg-muted rounded animate-pulse" />
                <div className="h-2 w-20 bg-muted rounded animate-pulse" />
              </div>
            </div>
          </div>
        ) : upcoming.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-6 gap-2 text-center">
            <CalendarCheck className="h-8 w-8 text-muted-foreground/20" />
            <p className="text-xs text-muted-foreground leading-relaxed px-3">
              {assignments.length === 0
                ? "No assignments yet"
                : "All matches complete 🏁"}
            </p>
          </div>
        ) : (
          upcoming.map(({ assignment, match }) => {
            const t = match ? matchTime(match) : null;
            const ms = t ? t * 1000 - nowMs : null;
            const soon = ms !== null && ms > 0 && ms < 10 * 60 * 1000;
            const played = match ? isConsideredPlayed(match, nowMs) : false;
            const timeStr = t
              ? new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
              : null;
            const isRed = assignment.position.startsWith("red");

            return (
              <div
                key={assignment._id}
                className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg border transition-all ${
                  soon
                    ? "border-amber-500/40 bg-amber-500/8"
                    : isRed
                      ? "border-red-500/20 bg-red-500/5 hover:bg-red-500/10"
                      : "border-blue-500/20 bg-blue-500/5 hover:bg-blue-500/10"
                } ${played ? "opacity-40" : ""}`}
              >
                <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 font-bold text-xs ${
                  isRed ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"
                }`}>
                  {assignment.position.slice(-1)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold font-mono tracking-tight">{assignment.matchLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className={`font-semibold ${posColor(assignment.position)}`}>
                      {POS_LABEL[assignment.position] ?? assignment.position}
                    </span>
                    {timeStr && <span className="ml-1 opacity-70">· {timeStr}</span>}
                  </p>
                </div>
                {soon && ms !== null && ms > 0 && (
                  <span className="shrink-0 text-[10px] font-bold text-amber-400 animate-pulse">{Math.ceil(ms / 60000)}m</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Dashboard Page ─────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const syncRoster = useMutation(api.forms.syncEventTeamRoster);
  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const eventKey = currentEvent?.eventKey ?? "";

  // Submissions, templates, TBA + Statbotics stats: shared with the Picklist.
  const {
    eventYear,
    allSubmissions,
    allTemplates,
    fields,
    pitFields,
    tbaTeams,
    tbaRankings,
    avgScoreByTeam,
    matchData,
    loadingExternal,
    sbError,
    epaMap,
    submissionsByTeam,
    pitSubmissionsByTeam,
    fieldColumns,
    fieldCellsByTeam,
  } = useEventTeamData(eventKey, (nums) => {
    // Sync the roster to Convex so the backend can validate team numbers
    syncRoster({ eventKey, teamNumbers: nums }).catch(() => {});
  });
  // Prime avatar memory cache for all event teams in the background
  useEffect(() => {
    for (const num of tbaTeams) primeAvatar(num, eventYear);
  }, [tbaTeams, eventYear]);

  // Lazy initializer: Date.now() must not run during render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [search, setSearch] = useState("");
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);

  // Active sort column, or null for the natural (team-number) order.
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Mobile only: lets scouts flip from the stacked card list to the same
  // scrollable column table desktop sees, so they can sort by rank/EPA/etc.
  const [mobileTableView, setMobileTableView] = useState(false);

  // Columns: built-ins (on by default) + form fields an admin tagged
  // "Rankings column" in the form builder (off by default). Visibility is a
  // per-device preference persisted in the UI store.
  const columnPrefs = useUIStore((s) => s.rankingColumns);
  const setRankingColumn = useUIStore((s) => s.setRankingColumn);
  const resetRankingColumns = useUIStore((s) => s.resetRankingColumns);
  const allColumns = useMemo(() => [...BUILTIN_COLUMNS, ...fieldColumns], [fieldColumns]);
  const shownColumns = useMemo(() => visibleColumns(allColumns, columnPrefs), [allColumns, columnPrefs]);
  // Per-device hidden teams for this event: dropped from the ranked list and
  // listed separately under it so they can be brought back.
  const hiddenForEvent = useUIStore((s) => s.hiddenTeams[eventKey]);
  const setTeamHidden = useUIStore((s) => s.setTeamHidden);
  const unhideAllTeams = useUIStore((s) => s.unhideAllTeams);
  const hiddenSet = useMemo(() => new Set(hiddenForEvent ?? []), [hiddenForEvent]);
  // Team column (144) + per-column min widths + 16px gaps + row padding, so
  // the header and rows scroll together at one shared width.
  const tableMinWidth = 144 + 12 + 32 + 44 + shownColumns.reduce((w, c) => w + c.width + 16, 0);

  // First click on a column sorts it descending (highest EPA, best rank first,
  // which is what you almost always want); clicking the active column flips it;
  // a third click clears back to team order.
  function toggleSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir(key === "rank" || key === "team" ? "asc" : "desc");
      return;
    }
    if (sortDir === (key === "rank" || key === "team" ? "asc" : "desc")) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(null);
  }

  // Live 1-second ticker for countdowns
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Next unplayed match that includes team 4099
  const nextMatch = useMemo(() => {
    const unplayed = matchData
      .filter((m) => !isConsideredPlayed(m, nowMs))
      .filter(
        (m) =>
          m.alliances.red.team_keys.includes(`frc${MY_TEAM}`) ||
          m.alliances.blue.team_keys.includes(`frc${MY_TEAM}`)
      )
      .sort((a, b) => (matchTime(a) ?? 9e12) - (matchTime(b) ?? 9e12));
    return unplayed[0] ?? null;
  }, [matchData, nowMs]);

  // Build team list — exclude teamNumber === 0 (spying submissions)
  const scoutedTeams = new Set(
    (allSubmissions ?? [])
      .map((s: { teamNumber: number }) => s.teamNumber)
      .filter((n: number) => n > 0)
  );
  const allTeams = Array.from(new Set([...tbaTeams, ...scoutedTeams])).sort(
    (a, b) => (a as number) - (b as number)
  );


  const filtered = allTeams.filter((t) =>
    search ? String(t).includes(search) : true
  );

  // Hiding the sorted column drops back to team order rather than sorting by
  // something no longer on screen.
  const activeSortKey =
    sortKey && (sortKey === "team" || shownColumns.some((c) => c.id === sortKey)) ? sortKey : null;

  // Sorting — built-in resolvers, then tagged form-field aggregates.
  const sorted = useMemo(() => {
    const sortKey = activeSortKey;
    if (!sortKey) return filtered;

    const rank = (tn: number) => {
      const r = tbaRankings[tn] as { rank?: number } | undefined;
      return r?.rank ?? null;
    };

    const value = (tn: number): number | string | null => {
      if (sortKey === "team")       return tn;
      if (sortKey === "rank")       return rank(tn);
      if (sortKey === "avgScore")   return avgScoreByTeam[tn] ?? null;
      if (sortKey === "epaEvent")   return epaMap[tn]?.event ?? null;
      if (sortKey === "epaOverall") return epaMap[tn]?.overall ?? null;
      if (sortKey === "epaAuto")    return epaMap[tn]?.auto ?? null;
      if (sortKey === "epaTeleop")  return epaMap[tn]?.teleop ?? null;
      if (sortKey === "epaEndgame") return epaMap[tn]?.endgame ?? null;
      return fieldCellsByTeam[tn]?.[sortKey]?.sort ?? null;
    };

    // Teams with no value for the active column sort to the bottom in BOTH
    // directions — a missing EPA is not "the worst EPA", it is unknown, and
    // flipping to ascending should not fill the top of the table with dashes.
    return [...filtered].sort((a, b) => {
      const va = value(a as number);
      const vb = value(b as number);
      if (va === null && vb === null) return (a as number) - (b as number);
      if (va === null) return 1;
      if (vb === null) return -1;
      const cmp = typeof va === "string" || typeof vb === "string"
        ? String(va).localeCompare(String(vb))
        : (va as number) - (vb as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, activeSortKey, sortDir, tbaRankings, avgScoreByTeam, epaMap, fieldCellsByTeam]);

  const visibleTeams = sorted.filter((t) => !hiddenSet.has(t as number));
  const hiddenTeams = filtered.filter((t) => hiddenSet.has(t as number)) as number[];
  const emptyListMessage = search
    ? "No teams match your search."
    : filtered.length > 0
      ? "All teams are hidden."
      : "No teams found for this event.";

  const totalScouted = (allSubmissions ?? []).length;
  const scoutedUniqueTeams = scoutedTeams.size;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-muted-foreground text-sm">
            {currentEvent?.eventName ?? "No event selected"} · All team data
          </p>
          {/* Straight to the source — the numbers here are derived, TBA is authoritative. */}
          {eventKey && (
            <div className="flex items-center gap-3 mt-1.5">
              <a
                href={`https://www.thebluealliance.com/event/${eventKey}#rankings`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                <Trophy className="h-3 w-3" /> TBA Rankings
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
              <a
                href={`https://www.thebluealliance.com/event/${eventKey}#results`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                <CalendarDays className="h-3 w-3" /> TBA Schedule
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </div>
          )}
        </div>
        <div className="flex gap-4 sm:gap-6">
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Scouted</p>
            <p className="text-xl sm:text-2xl font-bold text-primary">{totalScouted}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Teams</p>
            <p className="text-xl sm:text-2xl font-bold text-primary">{scoutedUniqueTeams}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">At Event</p>
            <p className="text-xl sm:text-2xl font-bold">{allTeams.length}</p>
          </div>
        </div>
      </div>

      {/* No-TBA-key warning */}

      {!eventKey ? (
        <div className="flex flex-col items-center justify-center h-64 text-center">
          <TrendingUp className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-muted-foreground">No event selected.</p>
          <p className="text-sm text-muted-foreground">
            Set your event in <strong>Settings</strong>.
          </p>
        </div>
      ) : (
        <>
          {/* ── Bento top row: Next Assignment (1/3) + Next Match on field (2/3) ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 shrink-0 items-stretch">
            {/* Next scouting assignment — single upcoming row */}
            <div className="lg:col-span-1 min-h-[100px]">
              <MyScouting
                eventKey={eventKey}
                matchData={matchData}
                nowMs={nowMs}
              />
            </div>
            {/* Next 4099 match on field — spans 2 cols on desktop, stretches full height */}
            <div className="lg:col-span-2 flex flex-col">
              <NextMatchBanner
                match={nextMatch}
                eventKey={eventKey}
                matchData={matchData}
                nowMs={nowMs}
                epaMap={epaMap}
                tbaRankings={tbaRankings}
              />
            </div>
          </div>

          {/* Search + mobile view toggle */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search by team number…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" className="shrink-0 gap-1.5 px-2.5 sm:px-3" title="Show / hide columns" />}
              >
                <Columns3 className="h-4 w-4" />
                <span className="hidden sm:inline">Columns</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {Array.from(new Set(allColumns.map((c) => c.group))).map((group, gi) => (
                  <DropdownMenuGroup key={group}>
                    {gi > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel>{group}</DropdownMenuLabel>
                    {allColumns.filter((c) => c.group === group).map((c) => (
                      <DropdownMenuCheckboxItem
                        key={c.id}
                        checked={shownColumns.includes(c)}
                        onCheckedChange={(v) => setRankingColumn(c.id, !!v)}
                      >
                        <span className="truncate">{c.label}</span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuGroup>
                ))}
                {fieldColumns.length === 0 && (
                  <p className="px-1.5 py-1.5 text-xs text-muted-foreground">
                    Tag a form field as a "Rankings column" in the Form Builder to add it here.
                  </p>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={resetRankingColumns}>Reset to default</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* Mobile-only: flip between stacked cards and the full column
                table (horizontally scrollable) so rank/EPA sorting works on phone. */}
            <Button
              variant="outline"
              size="icon"
              className="sm:hidden shrink-0"
              onClick={() => setMobileTableView((v) => !v)}
              title={mobileTableView ? "Switch to card view" : "Switch to table view"}
            >
              {mobileTableView ? <Rows3 className="h-4 w-4" /> : <Table2 className="h-4 w-4" />}
            </Button>
          </div>

          {fields.length === 0 && (
            <p className="text-xs text-amber-500 dark:text-amber-400 shrink-0">
              ⚠ No active scouting form — scouts can't submit match data until a form template is active.
            </p>
          )}

          {sbError && (
            <p className="text-xs text-amber-500 dark:text-amber-400 shrink-0">
              ⚠ Statbotics is unavailable{sbError.status ? ` (HTTP ${sbError.status})` : ""} — EPA
              columns are blank. Rank, record and Avg Score come from The Blue Alliance and are
              unaffected. This retries automatically.
            </p>
          )}

          <div className="flex-1 bg-card border border-border rounded-xl overflow-hidden flex flex-col min-h-0">
            <ScrollArea className="flex-1">
              {/* Column table (header + rows) — desktop always, mobile only in table view.
                  Header and rows share ONE overflow-x-auto container so they always
                  pan horizontally together instead of scrolling independently. This
                  page's vertical scrolling happens on the outer <main>, not a bounded
                  inner region, so the header isn't pinned in place — it scrolls up
                  with the rows like the rest of the page. */}
              <div className={`${mobileTableView ? "block overflow-x-auto overflow-y-visible" : "hidden"} sm:block sm:overflow-x-auto sm:overflow-y-visible`}>
                {/* Shared min-width: header and every row size to the same
                    width, so columns (and Links) line up when the phone scrolls. */}
                <div style={{ minWidth: tableMinWidth }}>
                <ColumnHeader columns={shownColumns} sortKey={activeSortKey} sortDir={sortDir} onSort={toggleSort} />
                {loadingExternal && tbaTeams.length === 0 ? (
                  <div className="divide-y divide-border">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <div className="h-[30px] w-[30px] rounded bg-muted animate-pulse shrink-0" />
                        <div className="flex flex-col gap-1.5 w-24">
                          <div className="h-3 w-10 bg-muted rounded animate-pulse" />
                          <div className="h-2.5 w-16 bg-muted/60 rounded animate-pulse" />
                        </div>
                        <div className="flex gap-3 flex-1">
                          {Array.from({ length: 4 }).map((_, j) => (
                            <div key={j} className="flex flex-col gap-1">
                              <div className="h-2 w-10 bg-muted/50 rounded animate-pulse" />
                              <div className="h-5 w-12 bg-muted/40 rounded animate-pulse" />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : visibleTeams.length === 0 ? (
                  <p className="text-center py-12 text-muted-foreground text-sm">{emptyListMessage}</p>
                ) : (
                  visibleTeams.map((teamNumber) => {
                    const teamEpa = epaMap[teamNumber as number] ?? EMPTY_TEAM_EPA;
                    return (
                      <TeamRow
                        key={teamNumber as number}
                        teamNumber={teamNumber as number}
                        eventYear={eventYear}
                        submissions={submissionsByTeam[teamNumber as number] ?? []}
                        epa={teamEpa}
                        avgScore={avgScoreByTeam[teamNumber as number] ?? null}
                        tbaRank={tbaRankings[teamNumber as number] ?? null}
                        fields={fields}
                        columns={shownColumns}
                        fieldCells={fieldCellsByTeam[teamNumber as number] ?? {}}
                        onOpenDetail={() => setSelectedTeam(teamNumber as number)}
                        onHide={() => setTeamHidden(eventKey, teamNumber as number, true)}
                        forceTable={mobileTableView}
                      />
                    );
                  })
                )}
                </div>
              </div>

              {/* Mobile card list — hidden when the mobile table view toggle is on */}
              <div className={`${mobileTableView ? "hidden" : "block"} sm:hidden`}>
                {loadingExternal && tbaTeams.length === 0 ? (
                  <div className="divide-y divide-border">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="px-3 py-3 space-y-2">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded bg-muted animate-pulse shrink-0" />
                          <div className="space-y-1.5 flex-1">
                            <div className="h-4 w-14 bg-muted rounded animate-pulse" />
                            <div className="h-2.5 w-24 bg-muted/60 rounded animate-pulse" />
                          </div>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {Array.from({ length: 4 }).map((_, j) => (
                            <div key={j} className="h-7 w-16 bg-muted/50 rounded animate-pulse" />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : visibleTeams.length === 0 ? (
                  <p className="text-center py-12 text-muted-foreground text-sm px-4">{emptyListMessage}</p>
                ) : (
                  visibleTeams.map((teamNumber) => {
                    const teamEpa = epaMap[teamNumber as number] ?? EMPTY_TEAM_EPA;
                    return (
                      <TeamRow
                        key={teamNumber as number}
                        teamNumber={teamNumber as number}
                        eventYear={eventYear}
                        submissions={submissionsByTeam[teamNumber as number] ?? []}
                        epa={teamEpa}
                        avgScore={avgScoreByTeam[teamNumber as number] ?? null}
                        tbaRank={tbaRankings[teamNumber as number] ?? null}
                        fields={fields}
                        columns={shownColumns}
                        fieldCells={fieldCellsByTeam[teamNumber as number] ?? {}}
                        onOpenDetail={() => setSelectedTeam(teamNumber as number)}
                        onHide={() => setTeamHidden(eventKey, teamNumber as number, true)}
                      />
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Hidden teams — kept out of the ranked list above, one tap to restore. */}
          {hiddenTeams.length > 0 && (
            <div className="shrink-0 bg-card border border-border rounded-xl p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Hidden teams ({hiddenTeams.length})
                </p>
                <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => unhideAllTeams(eventKey)}>
                  <Eye className="h-3.5 w-3.5" /> Unhide all
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {hiddenTeams.map((t) => (
                  <div key={t} className="flex items-center rounded-md border border-border bg-muted/30">
                    <button
                      type="button"
                      className="h-8 pl-2.5 pr-1.5 text-sm font-semibold font-mono hover:text-primary"
                      title={`Open team ${t}`}
                      onClick={() => setSelectedTeam(t)}
                    >
                      {t}
                    </button>
                    <button
                      type="button"
                      className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground border-l border-border"
                      title={`Unhide team ${t}`}
                      aria-label={`Unhide team ${t}`}
                      onClick={() => setTeamHidden(eventKey, t, false)}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Team detail panel */}
      {selectedTeam !== null && (() => {
        const teamEpa = epaMap[selectedTeam] ?? EMPTY_TEAM_EPA;
        return (
          <TeamDetailPanel
            teamNumber={selectedTeam}
            eventKey={eventKey}
            eventYear={eventYear}
            submissions={submissionsByTeam[selectedTeam] ?? []}
            fields={fields}
            epa={teamEpa}
            avgScore={avgScoreByTeam[selectedTeam] ?? null}
            tbaRank={tbaRankings[selectedTeam] ?? null}
            pitSubmissions={pitSubmissionsByTeam[selectedTeam] ?? []}
            pitFields={pitFields}
            templates={allTemplates}
            epaByTeam={epaMap}
            avgScoreByTeam={avgScoreByTeam}
            submissionsByTeam={submissionsByTeam}
            onClose={() => setSelectedTeam(null)}
          />
        );
      })()}
    </div>
  );
}
