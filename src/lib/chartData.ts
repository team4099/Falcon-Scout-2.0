// Data layer for the Data Viewer charts. Scatter plots one dot per team using
// the Dashboard rankings column values; line charts plot a per-match timeline
// (TBA/Statbotics scores, Statbotics per-match EPA, scouting submissions).
import { BUILTIN_COLUMNS, EPA_KEYS, REPORTS_COLUMN_ID, aggregateField } from "./rankingColumns";
import type { RankingColumn, TeamStats } from "./rankingColumns";
import { findInEpa } from "./epa";
import type { FormField } from "@/types";

export type ChartType = "scatter" | "line";
export type LineScope = "event" | "season";

export interface ChartCfg {
  id: string;
  title: string;
  type: ChartType;
  /** Scatter only; a line chart's X axis is always matches. */
  xAxis: string;
  yAxis: string;
  /** Empty = all teams. */
  teams: number[];
  /** Line only. Missing on older saved charts = "event". */
  scope?: LineScope;
}

export interface ChartMetric { id: string; label: string; group: string; }

export type FieldColumn = RankingColumn & { templateId: string; field: FormField };

const NUMERIC_FIELD_TYPES = new Set(["number", "counter", "rating", "checkbox"]);

const CHART_LABELS: Record<string, string> = {
  epaAuto: "Auto EPA",
  epaTeleop: "Teleop EPA",
  epaEndgame: "Endgame EPA",
  [REPORTS_COLUMN_ID]: "Scouting Reports (count)",
};

/** Per match there is one running EPA, so Event vs Season EPA collapse into
 *  one series; Rank and report counts have no per-match value. */
const LINE_BUILTINS: ChartMetric[] = [
  { id: "avgScore",   label: "Match Score", group: "Stats" },
  { id: "epaEvent",   label: "EPA (Total)", group: "Stats" },
  { id: "epaAuto",    label: "Auto EPA",    group: "Stats" },
  { id: "epaTeleop",  label: "Teleop EPA",  group: "Stats" },
  { id: "epaEndgame", label: "Endgame EPA", group: "Stats" },
];

/** Axis options: the Dashboard rankings columns that have a numeric value. */
export function chartMetrics(type: ChartType, fieldColumns: FieldColumn[]): ChartMetric[] {
  const fields = fieldColumns
    .filter((c) => NUMERIC_FIELD_TYPES.has(c.field.type))
    .map((c) => ({
      id: c.id,
      label: c.field.type === "checkbox" ? `${c.label} (% yes)` : c.label,
      group: c.group,
    }));
  const builtins = type === "line"
    ? LINE_BUILTINS
    : BUILTIN_COLUMNS.map((c) => ({ id: c.id, label: CHART_LABELS[c.id] ?? c.label, group: "Stats" }));
  return [...builtins, ...fields];
}

/** One team's numeric value for a rankings column (scatter). */
export function scatterValue(id: string, t: TeamStats): number | null {
  if (id === "rank") return t.rank;
  if (id === "avgScore") return t.avgScore;
  if (id === REPORTS_COLUMN_ID) return t.reportCount;
  const epaKey = EPA_KEYS[id];
  if (epaKey) return t.epa[epaKey];
  const f = t.fieldCells[id];
  return f && typeof f.sort === "number" ? f.sort : null;
}

// ── Per-match timelines ──────────────────────────────────────────────────────

/** A match with the team lists and scores, from TBA or Statbotics. */
export interface SlimMatch {
  k: string;
  t: number | null;
  red: number[];
  blue: number[];
  /** null = not played yet. */
  rs: number | null;
  bs: number | null;
}

/** One team's EPA going into a match: [total, auto, teleop, endgame]. */
export interface SlimTeamMatch { team: number; k: string; e: Array<number | null>; }

const EPA_METRICS = ["epaEvent", "epaAuto", "epaTeleop", "epaEndgame"];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const teamNums = (keys: unknown): number[] =>
  Array.isArray(keys) ? keys.map((k) => Number(String(k).replace("frc", ""))).filter((n) => n > 0) : [];

export function slimTbaMatch(m: {
  key: string; time: number | null; predicted_time: number | null; actual_time: number | null;
  alliances: { red: { team_keys: string[]; score: number }; blue: { team_keys: string[]; score: number } };
}): SlimMatch {
  const score = (s: number) => (s >= 0 ? s : null);
  return {
    k: m.key,
    t: m.actual_time ?? m.predicted_time ?? m.time ?? null,
    red: teamNums(m.alliances.red.team_keys),
    blue: teamNums(m.alliances.blue.team_keys),
    rs: score(m.alliances.red.score),
    bs: score(m.alliances.blue.score),
  };
}

/** Statbotics `/v3/matches` rows → SlimMatch (the raw rows are ~2.5 KB each). */
export function slimStatboticsMatches(raw: unknown): SlimMatch[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m: Record<string, unknown>) => {
    if (typeof m?.key !== "string") return [];
    const al = (m.alliances ?? {}) as Record<string, { team_keys?: unknown }>;
    const res = (m.result ?? {}) as Record<string, unknown>;
    return [{
      k: m.key,
      t: num(m.time),
      red: teamNums(al.red?.team_keys),
      blue: teamNums(al.blue?.team_keys),
      rs: num(res.red_score),
      bs: num(res.blue_score),
    }];
  });
}

/** Statbotics `/v3/team_matches` rows → SlimTeamMatch. */
export function slimStatboticsTeamMatches(raw: unknown): SlimTeamMatch[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r: Record<string, unknown>) => {
    if (typeof r?.team !== "number" || typeof r.match !== "string") return [];
    return [{
      team: r.team,
      k: r.match,
      e: [
        findInEpa(r.epa, "total_points"),
        findInEpa(r.epa, "auto_points"),
        findInEpa(r.epa, "teleop_points"),
        findInEpa(r.epa, "endgame_points"),
      ],
    }];
  });
}

const LEVELS: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };

export interface ParsedMatchKey { event: string; level: string; set: number; num: number; }

/** `2026vaale1_qm12` / `2026vaale1_sf3m1` / `2026vaale1_f1m2`. */
export function parseMatchKey(key: string): ParsedMatchKey | null {
  const m = /^(.+)_(qm|ef|qf|sf|f)(\d+)(?:m(\d+))?$/.exec(key);
  if (!m) return null;
  return m[2] === "qm"
    ? { event: m[1], level: "qm", set: 1, num: Number(m[3]) }
    : { event: m[1], level: m[2], set: Number(m[3]), num: Number(m[4] ?? 1) };
}

/** Bracket order within one event (doesn't trust wall-clock times). */
function bracketOrder(p: ParsedMatchKey): number {
  return LEVELS[p.level] * 1_000_000 + p.set * 1_000 + p.num;
}

function elimLabel(p: ParsedMatchKey): string {
  if (p.level === "f") return `F${p.num}`;
  return `${p.level.toUpperCase()}${p.set}${p.num > 1 ? `-${p.num}` : ""}`;
}

export interface TimelinePoint {
  key: string;
  event: string;
  /** "Q12", "E3" (current event), "SF3" / "F1" (other events). */
  label: string;
  /** X position: event scope → Q# or 100000+E# (a shared axis across teams);
   *  season scope → the team's 1-based match index for the season. */
  order: number;
  values: Record<string, number>;
}

interface TimelineSubmission {
  templateId: string;
  teamNumber: number;
  matchNumber: number;
  compLevel?: "qm" | "elim";
  data: string;
}

/**
 * Per-team match timelines for line charts. Current-event scouting answers
 * are attached to their match (Q# directly; the scout-entered E# is the Nth
 * playoff match of the event in bracket order). Matches with no value at all
 * (unplayed, unscouted) are dropped.
 */
export function buildTimelines(opts: {
  teams: number[];
  scope: LineScope;
  eventKey: string;
  /** Current-event TBA matches first: the first copy of a key wins. */
  matches: SlimMatch[];
  teamMatches: SlimTeamMatch[];
  submissions: TimelineSubmission[];
  fieldColumns: FieldColumn[];
  /** Keep only matches with this value, so a season index counts just the
   *  matches being plotted (not, say, scouting-only entries on an EPA line). */
  metric?: string;
}): Record<number, TimelinePoint[]> {
  const { teams, scope, eventKey } = opts;
  const inScope = (event: string) => scope === "season" || event === eventKey;

  const matchByKey = new Map<string, SlimMatch & { p: ParsedMatchKey }>();
  for (const m of opts.matches) {
    const p = parseMatchKey(m.k);
    if (p && inScope(p.event) && !matchByKey.has(m.k)) matchByKey.set(m.k, { ...m, p });
  }

  // E# at the current event = position among its playoff matches.
  const elimKeys = new Set<string>();
  for (const m of matchByKey.values()) if (m.p.event === eventKey && m.p.level !== "qm") elimKeys.add(m.k);
  for (const tm of opts.teamMatches) {
    const p = parseMatchKey(tm.k);
    if (p && p.event === eventKey && p.level !== "qm") elimKeys.add(tm.k);
  }
  const elimIndex = new Map<string, number>(
    [...elimKeys]
      .sort((a, b) => bracketOrder(parseMatchKey(a)!) - bracketOrder(parseMatchKey(b)!))
      .map((k, i) => [k, i + 1]),
  );

  // Scouting answers per team per match, averaged across scouts.
  const numericCols = opts.fieldColumns.filter((c) => NUMERIC_FIELD_TYPES.has(c.field.type));
  const subsByTeamMatch = new Map<string, TimelineSubmission[]>();
  if (numericCols.length) {
    for (const s of opts.submissions) {
      if (s.teamNumber <= 0) continue;
      const key = `${s.teamNumber}|${s.compLevel ?? "qm"}|${s.matchNumber}`;
      const list = subsByTeamMatch.get(key);
      if (list) list.push(s); else subsByTeamMatch.set(key, [s]);
    }
  }
  function fieldValues(subs: TimelineSubmission[]): Record<string, number> {
    const out: Record<string, number> = {};
    const parsed = subs.map((s) => {
      try { return { tpl: s.templateId, d: JSON.parse(s.data) as Record<string, unknown> }; }
      catch { return { tpl: s.templateId, d: {} as Record<string, unknown> }; }
    });
    for (const c of numericCols) {
      const vals = parsed.filter((x) => x.tpl === c.templateId).map((x) => x.d[c.field.id]);
      const cell = aggregateField(c.field, vals);
      if (typeof cell.sort === "number") out[c.id] = cell.sort;
    }
    return out;
  }

  const out: Record<number, TimelinePoint[]> = {};
  for (const team of teams) {
    type Draft = { key: string; p: ParsedMatchKey; t: number | null; values: Record<string, number> };
    const drafts = new Map<string, Draft>();
    const draft = (key: string, p: ParsedMatchKey, t: number | null) => {
      let d = drafts.get(key);
      if (!d) { d = { key, p, t, values: {} }; drafts.set(key, d); }
      return d;
    };

    for (const m of matchByKey.values()) {
      const onRed = m.red.includes(team);
      if (!onRed && !m.blue.includes(team)) continue;
      const d = draft(m.k, m.p, m.t);
      const score = onRed ? m.rs : m.bs;
      if (score !== null) d.values.avgScore = score;
    }
    for (const tm of opts.teamMatches) {
      if (tm.team !== team) continue;
      const p = parseMatchKey(tm.k);
      if (!p || !inScope(p.event)) continue;
      const d = draft(tm.k, p, matchByKey.get(tm.k)?.t ?? null);
      tm.e.forEach((v, i) => { if (v !== null) d.values[EPA_METRICS[i]] = v; });
    }
    // Scouting answers, including matches TBA/Statbotics don't know yet.
    if (numericCols.length) {
      const known = new Map<string, string>(); // "qm|12" → match key
      for (const d of drafts.values()) {
        if (d.p.event !== eventKey) continue;
        if (d.p.level === "qm") known.set(`qm|${d.p.num}`, d.key);
        else if (elimIndex.has(d.key)) known.set(`elim|${elimIndex.get(d.key)}`, d.key);
      }
      for (const [k, subs] of subsByTeamMatch) {
        const [t, cl, n] = k.split("|");
        if (Number(t) !== team) continue;
        let key = known.get(`${cl}|${n}`);
        if (!key) {
          // Not in TBA/Statbotics (offline, or scouted early): place it by number.
          key = cl === "elim" ? `${eventKey}_e${n}` : `${eventKey}_qm${n}`;
          const p: ParsedMatchKey = cl === "elim"
            ? { event: eventKey, level: "sf", set: 900 + Number(n), num: 1 }
            : { event: eventKey, level: "qm", set: 1, num: Number(n) };
          if (cl === "elim") elimIndex.set(key, Number(n));
          draft(key, p, null);
        }
        Object.assign(drafts.get(key)!.values, fieldValues(subs));
      }
    }

    // Events in time order (by their earliest known match), bracket order within.
    const list = [...drafts.values()].filter((d) =>
      opts.metric ? d.values[opts.metric] !== undefined : Object.keys(d.values).length > 0);
    const eventStart = new Map<string, number>();
    for (const d of list) {
      if (d.t === null) continue;
      eventStart.set(d.p.event, Math.min(eventStart.get(d.p.event) ?? Infinity, d.t));
    }
    const evTime = (e: string) => eventStart.get(e) ?? (e === eventKey ? Infinity : 0);
    list.sort((a, b) =>
      a.p.event === b.p.event
        ? bracketOrder(a.p) - bracketOrder(b.p)
        : evTime(a.p.event) - evTime(b.p.event) || a.p.event.localeCompare(b.p.event));

    out[team] = list.map((d, i) => {
      const e = d.p.event === eventKey ? elimIndex.get(d.key) : undefined;
      const label = d.p.level === "qm" ? `Q${d.p.num}` : e !== undefined ? `E${e}` : elimLabel(d.p);
      return {
        key: d.key,
        event: d.p.event,
        label,
        order: scope === "season" ? i + 1 : d.p.level === "qm" ? d.p.num : 100_000 + (e ?? 0),
        values: d.values,
      };
    });
  }
  return out;
}
