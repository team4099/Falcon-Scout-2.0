import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  BarChart2, ScatterChart as ScatterIcon, TrendingUp,
  Hexagon, BarChart, Plus, X, Activity, ChevronDown, ChevronUp,
} from "lucide-react";
import {
  BarChart as ReBarChart, Bar,
  ScatterChart as ReScatterChart, Scatter,
  LineChart, Line,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell,
} from "recharts";
import { fetchStatboticsEventTeams, fetchStatboticsEventTeamMatches, fetchTBAEventTeams } from "@/lib/api";


// ─────────────────────────────── Types ────────────────────────────────────────

interface FormField { id: string; type: string; label: string; }
interface Submission { _id: string; teamNumber: number; matchNumber: number; data: string; }
type ChartType = "bar" | "scatter" | "line" | "radar" | "histogram" | "boxplot";

interface AxisOpt { id: string; label: string; group: "scouting" | "epa" | "match"; }
interface ChartCfg {
  id: string; title: string; type: ChartType;
  xAxis: string; yAxis: string; teams: number[];
}

// ─────────────────────────────── Constants ────────────────────────────────────

const CHART_DEFS: { type: ChartType; label: string; icon: React.ElementType; desc: string }[] = [
  { type: "bar",       label: "Bar",       icon: BarChart2,    desc: "Avg per team" },
  { type: "scatter",   label: "Scatter",   icon: ScatterIcon,  desc: "A vs B per match" },
  { type: "line",      label: "Line",      icon: TrendingUp,   desc: "Trend over matches" },
  { type: "radar",     label: "Radar",     icon: Hexagon,      desc: "Multi-metric spider" },
  { type: "histogram", label: "Histogram", icon: BarChart,     desc: "Value distribution" },
  { type: "boxplot",   label: "Box Plot",  icon: Activity,     desc: "Spread per team" },
];

const EPA_AXES: AxisOpt[] = [
  { id: "epa_total",   label: "Event EPA (Total)",   group: "epa" },
  { id: "epa_auto",    label: "Auto EPA",             group: "epa" },
  { id: "epa_teleop",  label: "Teleop EPA",           group: "epa" },
  { id: "epa_endgame", label: "Endgame EPA",          group: "epa" },
];
const MATCH_AXES: AxisOpt[] = [
  { id: "_match", label: "Match Number", group: "match" },
];

const COLORS = [
  "#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6",
  "#3b82f6","#f97316","#14b8a6","#ec4899","#84cc16",
];
const clr = (i: number) => COLORS[i % COLORS.length];

// ─────────────────────────────── Data helpers ─────────────────────────────────

function getNum(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && v !== "") { const n = Number(v); if (isFinite(n)) return n; }
  return null;
}

function avg(arr: number[]) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function boxStats(vals: number[]) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const q = (p: number) => { const i = p * (s.length - 1); const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  return { min: s[0], q1: q(0.25), med: q(0.5), q3: q(0.75), max: s[s.length - 1], mean: avg(s), n: s.length };
}

function groupBy<T extends Record<string, unknown>>(rows: T[], key: string): Record<string, T[]> {
  const g: Record<string, T[]> = {};
  for (const r of rows) { const k = String(r[key] ?? "?"); (g[k] ??= []).push(r); }
  return g;
}

// Build flat rows from all submissions (one row per scouting entry)
function buildRows(
  submissions: Submission[],
  fields: FormField[],
  epaByTeam: Record<number, Record<string, number | null>>
): Record<string, unknown>[] {
  return submissions.map((s) => {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(s.data) as Record<string, unknown>; } catch { /**/ }

    const row: Record<string, unknown> = {
      _team: s.teamNumber,
      _teamStr: String(s.teamNumber),
      _match: s.matchNumber,
    };

    for (const f of fields) {
      if (f.type === "number" || f.type === "counter" || f.type === "rating") {
        const raw = parsed[f.id];
        row[f.id] = raw !== undefined && raw !== "" && raw !== null ? Number(raw) : null;
      } else if (f.type === "checkbox") {
        row[f.id] = parsed[f.id] === true || parsed[f.id] === 1 ? 1 : 0;
      }
    }

    const epa = epaByTeam[s.teamNumber] ?? {};
    for (const [k, v] of Object.entries(epa)) row[k] = v;

    return row;
  });
}

// Build one row PER TEAM — EPA values + per-field averages across all their submissions.
// Used for any chart axis that references an EPA field (team-level data).
function buildTeamRows(
  submissions: Submission[],
  fields: FormField[],
  epaByTeam: Record<number, Record<string, number | null>>,
  allTeamNums: number[]
): Record<string, unknown>[] {
  // Collect per-team submission averages
  const byTeam: Record<number, Submission[]> = {};
  for (const s of submissions) (byTeam[s.teamNumber] ??= []).push(s);

  // Union of teams: all teams with EPA data OR any submission
  const teams = Array.from(new Set([
    ...Object.keys(epaByTeam).map(Number),
    ...allTeamNums,
    ...submissions.map((s) => s.teamNumber),
  ]));

  return teams.map((tn) => {
    const row: Record<string, unknown> = {
      _team: tn,
      _teamStr: String(tn),
      _match: null,
    };

    // Add EPA values
    const epa = epaByTeam[tn] ?? {};
    for (const [k, v] of Object.entries(epa)) row[k] = v;

    // Add per-field averages from submissions
    const subs = byTeam[tn] ?? [];
    for (const f of fields) {
      if (f.type !== "number" && f.type !== "counter" && f.type !== "checkbox" && f.type !== "rating") continue;
      const vals: number[] = [];
      for (const s of subs) {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(s.data) as Record<string, unknown>; } catch { /**/ }
        if (f.type === "checkbox") {
          vals.push(parsed[f.id] === true || parsed[f.id] === 1 ? 1 : 0);
        } else {
          const raw = parsed[f.id];
          if (raw !== undefined && raw !== "" && raw !== null) vals.push(Number(raw));
        }
      }
      row[f.id] = vals.length ? Number(avg(vals).toFixed(2)) : null;
    }

    return row;
  });
}

// Radar-specific tooltip — shows the actual raw average, not the 0–100 normalised value
function RadarTip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; color: string; payload: Record<string, unknown> }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover text-popover-foreground px-3 py-2 shadow-xl text-xs space-y-1">
      {label && <p className="font-semibold">{label}</p>}
      {payload.map((p, i) => {
        const rawKey = `__raw_${p.name}`;
        const rawVal = p.payload[rawKey];
        const display = typeof rawVal === "number"
          ? (Number.isInteger(rawVal) ? String(rawVal) : rawVal.toFixed(2))
          : "N/A";
        return (
          <div key={i} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
            <span className="text-muted-foreground">Team #{p.name}:</span>
            <span className="font-mono font-semibold">{display}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────── Chart renderers ──────────────────────────────

const GRID_PROPS = { strokeDasharray: "3 3", stroke: "hsl(var(--border))", opacity: 0.5 };
const MARGIN = { top: 12, right: 16, left: 4, bottom: 56 };

// Bottom-axis tick: dy=10 pushes label clearly below the tick line
function WhiteTickX({ x, y, payload, textAnchor }: {
  x?: number; y?: number; payload?: { value: unknown }; textAnchor?: string;
}) {
  return (
    <text x={x} y={y} textAnchor={(textAnchor ?? "middle") as "inherit" | "start" | "end" | "middle"}
      style={{ fill: "white", fontSize: 11 }} dy={10}>
      {String(payload?.value ?? "")}
    </text>
  );
}

// Left-axis tick: dominantBaseline keeps text vertically centered on its tick mark
function WhiteTickY({ x, y, payload, textAnchor }: {
  x?: number; y?: number; payload?: { value: unknown }; textAnchor?: string;
}) {
  return (
    <text x={x} y={y} textAnchor={(textAnchor ?? "end") as "inherit" | "start" | "end" | "middle"}
      dominantBaseline="middle"
      style={{ fill: "white", fontSize: 11 }} dy={0}>
      {String(payload?.value ?? "")}
    </text>
  );
}

// Returns true if the axis id belongs to the EPA group (team-level constant)
const EPA_IDS = new Set(["epa_total","epa_auto","epa_teleop","epa_endgame"]);
function isEpaAxis(id: string) { return EPA_IDS.has(id); }

function ChartInner({ cfg, rows, teamRows, matchEpaRows, fields, axes }: {
  cfg: ChartCfg;
  rows: Record<string, unknown>[];          // one row per scouting submission
  teamRows: Record<string, unknown>[];       // one row per team (EPA + avg scouting)
  matchEpaRows: Record<string, unknown>[];   // one row per (team, match) with per-match EPA
  fields: FormField[];
  axes: AxisOpt[];
}) {
  // Normalise cfgTeamFilter: old persisted charts may not have a teams field
  const cfgTeamFilter = cfg.teams ?? [];

  const useTeamRows = isEpaAxis(cfg.xAxis) || (isEpaAxis(cfg.yAxis) && rows.length === 0);

  const source = useTeamRows ? teamRows : rows;

  const filtered = cfgTeamFilter.length
    ? source.filter((r) => cfgTeamFilter.includes(r._team as number))
    : source;

  // Radar reads teamRows directly, so we allow it through even with no scouting submissions
  if (!filtered.length && cfg.type !== "radar") {
    return <Empty msg={useTeamRows ? "No Statbotics data for this event" : "No scouting submissions yet"} />;
  }


  const xLabel = axes.find((a) => a.id === cfg.xAxis)?.label ?? cfg.xAxis;
  const yLabel = axes.find((a) => a.id === cfg.yAxis)?.label ?? cfg.yAxis;
  const teams = Array.from(new Set(filtered.map((r) => r._teamStr as string))).sort();

  // ── Bar ────────────────────────────────────────────────────────────────────
  if (cfg.type === "bar") {
    const byTeam = groupBy(filtered, "_teamStr");
    const data = teams.map((t) => {
      const vals = (byTeam[t] ?? []).map((r) => getNum(r, cfg.yAxis)).filter((v): v is number => v !== null);
      if (!vals.length) return null;
      const value = Number(avg(vals).toFixed(2));
      const mn = Math.min(...vals);
      const mx = Math.max(...vals);
      return { team: t, value, n: vals.length, min: Number(mn.toFixed(2)), max: Number(mx.toFixed(2)) };
    }).filter((d): d is NonNullable<typeof d> => d !== null);
    if (!data.length) return <Empty msg={`No numeric data for "${yLabel}"`} />;
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ReBarChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="team" tick={<WhiteTickX />} angle={-35} textAnchor="end" interval={0}
            tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }} />
          <YAxis tick={<WhiteTickY />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
            label={{ value: yLabel, angle: -90, position: "insideLeft", fill: "white", fontSize: 11 }} />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.05)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const d = payload[0].payload as typeof data[0];
              const i = data.findIndex((x) => x.team === d.team);
              return (
                <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-xs space-y-1.5 min-w-[140px]">
                  <div className="flex items-center gap-2 pb-1 border-b border-border">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: clr(i) }} />
                    <span className="font-bold text-sm">Team #{d.team}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Avg {yLabel}</span>
                    <span className="font-mono font-bold">{d.value.toFixed(2)}</span>
                  </div>
                  {d.n > 1 && (
                    <>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Max</span>
                        <span className="font-mono">{d.max.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Min</span>
                        <span className="font-mono">{d.min.toFixed(2)}</span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between gap-4 text-muted-foreground/60">
                    <span>Matches</span>
                    <span className="font-mono">{d.n}</span>
                  </div>
                </div>
              );
            }}
          />
          <Bar dataKey="value" name={yLabel} radius={[4, 4, 0, 0]} maxBarSize={60}>
            {data.map((_, i) => <Cell key={i} fill={clr(i)} />)}
          </Bar>
        </ReBarChart>
      </ResponsiveContainer>
    );
  }

  // ── Scatter ────────────────────────────────────────────────────────────────
  if (cfg.type === "scatter") {
    const byTeam = groupBy(filtered, "_teamStr");
    const series = teams.map((t, i) => ({
      name: t,
      color: clr(i),
      // Include `team` in each point so the tooltip can read it
      pts: (byTeam[t] ?? [])
        .map((r) => ({ x: getNum(r, cfg.xAxis), y: getNum(r, cfg.yAxis), match: r._match, team: t }))
        .filter((p) => p.x !== null && p.y !== null) as { x: number; y: number; match: unknown; team: string }[],
    })).filter((s) => s.pts.length);
    if (!series.length) return <Empty msg="No numeric data on both axes" />;
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ReScatterChart margin={MARGIN}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis
            type="number" dataKey="x" name={xLabel}
            tick={<WhiteTickX />}
            tickLine={{ stroke: "white" }}
            axisLine={{ stroke: "white" }}
            label={{ value: xLabel, position: "insideBottom", offset: -36, fill: "white", fontSize: 11 }}
          />
          <YAxis
            type="number" dataKey="y" name={yLabel}
            tick={<WhiteTickY />}
            tickLine={{ stroke: "white" }}
            axisLine={{ stroke: "white" }}
            label={{ value: yLabel, angle: -90, position: "insideLeft", fill: "white", fontSize: 11 }}
          />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const d = payload[0].payload as { x: number; y: number; match: unknown; team: string };
              return (
                <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-xs space-y-0.5">
                  <p className="font-bold text-sm">#{d.team}</p>
                  {d.match != null && <p className="text-muted-foreground">Match {String(d.match)}</p>}
                  <p>{xLabel}: <span className="font-mono font-semibold">{d.x.toFixed(2)}</span></p>
                  <p>{yLabel}: <span className="font-mono font-semibold">{d.y.toFixed(2)}</span></p>
                </div>
              );
            }}
          />
          {/* No <Legend /> — team is shown on hover only */}
          {series.map((s) => (
            <Scatter key={s.name} name={s.name} data={s.pts} fill={s.color} fillOpacity={0.8} r={5} />
          ))}
        </ReScatterChart>
      </ResponsiveContainer>
    );
  }

  // ── Line ────────────────────────────────────────────────────────────────────
  if (cfg.type === "line") {
    if (useTeamRows) {
      // ── Sub-mode A: match number X + EPA Y ───────────────────────────────
      // Use per-match EPA rows from Statbotics (EPA changes each match).
      // Falls back to flat teamRows lines if per-match data hasn't loaded yet.
      if (cfg.xAxis === "_match") {
        const source2 = matchEpaRows.length > 0 ? matchEpaRows : filtered;

        // Apply team filter
        const src2filtered = teams.length
          ? source2.filter((r) => teams.includes(r._teamStr as string))
          : source2;
        const filteredTeams = Array.from(new Set(src2filtered.map((r) => r._teamStr as string))).sort();

        const byTeam2 = groupBy(src2filtered, "_teamStr");
        const allMatchNums = Array.from(
          new Set(src2filtered.map((r) => getNum(r, "_match")).filter((v): v is number => v !== null))
        ).sort((a, b) => a - b);

        if (!allMatchNums.length) {
          // No match numbers in source — last-resort flat span 1-80
          const data = Array.from({ length: 80 }, (_, i) => {
            const pt: Record<string, unknown> = { x: i + 1 };
            for (const t of filteredTeams) {
              const tr = filtered.find((r) => r._teamStr === t);
              pt[t] = tr ? getNum(tr, cfg.yAxis) : null;
            }
            return pt;
          });
          return (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={MARGIN}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="x" tick={<WhiteTickX />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
                  label={{ value: xLabel, position: "insideBottom", offset: -36, fill: "white", fontSize: 11 }} />
                <YAxis tick={<WhiteTickY />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
                  label={{ value: yLabel, angle: -90, position: "insideLeft", fill: "white", fontSize: 11 }} />
                <Tooltip content={({ active, payload, label: xVal }) => {
                  if (!active || !payload?.length) return null;
                  const entries = payload.filter((p) => p.value !== undefined && p.value !== null);
                  return (
                    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-xs space-y-1">
                      <p className="font-bold">Match {xVal}</p>
                      {entries.map((p, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
                          <span className="text-muted-foreground">#{p.name}:</span>
                          <span className="font-mono font-semibold">{typeof p.value === "number" ? p.value.toFixed(2) : p.value}</span>
                        </div>
                      ))}
                    </div>
                  );
                }} />
                {filteredTeams.map((t, i) => (
                  <Line key={t} type="monotone" dataKey={t} name={t} stroke={clr(i)} strokeWidth={2.5}
                    dot={false} activeDot={{ r: 5, stroke: clr(i), fill: clr(i) }} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          );
        }

        // Real per-match EPA — one row per match, columns per team
        const data = allMatchNums.map((mn) => {
          const pt: Record<string, unknown> = { x: mn };
          for (const t of filteredTeams) {
            const teamMatchRows = (byTeam2[t] ?? []).filter((r) => getNum(r, "_match") === mn);
            const vals = teamMatchRows.map((r) => getNum(r, cfg.yAxis)).filter((v): v is number => v !== null);
            pt[t] = vals.length ? Number(avg(vals).toFixed(2)) : null;
          }
          return pt;
        });

        return (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={MARGIN}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="x" tick={<WhiteTickX />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
                label={{ value: xLabel, position: "insideBottom", offset: -36, fill: "white", fontSize: 11 }} />
              <YAxis tick={<WhiteTickY />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
                label={{ value: yLabel, angle: -90, position: "insideLeft", fill: "white", fontSize: 11 }} />
              <Tooltip
                content={({ active, payload, label: xVal }) => {
                  if (!active || !payload?.length) return null;
                  const entries = payload.filter((p) => p.value !== undefined && p.value !== null);
                  return (
                    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-xs space-y-1">
                      <p className="font-bold">Match {xVal}</p>
                      {entries.map((p, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
                          <span className="text-muted-foreground">#{p.name}:</span>
                          <span className="font-mono font-semibold">{typeof p.value === "number" ? p.value.toFixed(2) : p.value}</span>
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              {filteredTeams.map((t, i) => (
                <Line key={t} type="monotone" dataKey={t} name={t}
                  stroke={clr(i)} strokeWidth={2.5} dot={false}
                  activeDot={{ r: 5, stroke: clr(i), fill: clr(i) }}
                  connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        );
      }

      // ── Sub-mode B: EPA X vs anything — one line through all teams sorted by X
      const pts = filtered
        .map((r) => ({
          x: getNum(r, cfg.xAxis),
          y: getNum(r, cfg.yAxis),
          team: r._teamStr as string,
        }))
        .filter((p): p is { x: number; y: number; team: string } => p.x !== null && p.y !== null)
        .sort((a, b) => a.x - b.x);

      if (!pts.length) return <Empty msg="No data on both axes" />;

      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={pts} margin={MARGIN}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="x" tick={<WhiteTickX />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
              label={{ value: xLabel, position: "insideBottom", offset: -36, fill: "white", fontSize: 11 }} />
            <YAxis tick={<WhiteTickY />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
              label={{ value: yLabel, angle: -90, position: "insideLeft", fill: "white", fontSize: 11 }} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.[0]) return null;
                const d = payload[0].payload as { x: number; y: number; team: string };
                return (
                  <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-xs space-y-0.5">
                    <p className="font-bold text-sm">#{d.team}</p>
                    <p>{xLabel}: <span className="font-mono font-semibold">{d.x.toFixed(2)}</span></p>
                    <p>{yLabel}: <span className="font-mono font-semibold">{d.y.toFixed(2)}</span></p>
                  </div>
                );
              }}
            />
            <Line type="monotone" dataKey="y" name={yLabel}
              stroke="#6366f1" strokeWidth={2.5}
              dot={(props: { cx?: number; cy?: number; index?: number }) => (
                <circle key={props.index} cx={props.cx ?? 0} cy={props.cy ?? 0} r={4}
                  fill="#6366f1" stroke="white" strokeWidth={1} />
              )}
              activeDot={{ r: 6, stroke: "white", strokeWidth: 1.5, fill: "#6366f1" }}
            />
          </LineChart>
        </ResponsiveContainer>
      );
    }

    // Normal mode: one line per team over match/numeric X axis
    const byTeam = groupBy(filtered, "_teamStr");
    const allX = Array.from(new Set(
      filtered.map((r) => getNum(r, cfg.xAxis)).filter((v): v is number => v !== null)
    )).sort((a, b) => a - b);
    if (!allX.length) return <Empty msg={`No numeric data for X axis "${xLabel}"`} />;
    const data = allX.map((xv) => {
      const pt: Record<string, unknown> = { x: xv };
      for (const t of teams) {
        const matched = (byTeam[t] ?? []).filter((r) => getNum(r, cfg.xAxis) === xv);
        const vals = matched.map((r) => getNum(r, cfg.yAxis)).filter((v): v is number => v !== null);
        pt[t] = vals.length ? Number(avg(vals).toFixed(2)) : undefined;
      }
      return pt;
    });
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="x" tick={<WhiteTickX />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
            label={{ value: xLabel, position: "insideBottom", offset: -36, fill: "white", fontSize: 11 }} />
          <YAxis tick={<WhiteTickY />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
            label={{ value: yLabel, angle: -90, position: "insideLeft", fill: "white", fontSize: 11 }} />
          {/* No <Legend /> — team shown on hover */}
          <Tooltip
            content={({ active, payload, label: xVal }) => {
              if (!active || !payload?.length) return null;
              const entries = payload.filter((p) => p.value !== undefined && p.value !== null);
              return (
                <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-xs space-y-1">
                  <p className="font-bold">{xLabel} = {xVal}</p>
                  {entries.map((p, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
                      <span className="text-muted-foreground">#{p.name}:</span>
                      <span className="font-mono font-semibold">{typeof p.value === "number" ? p.value.toFixed(2) : p.value}</span>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          {teams.map((t, i) => (
            <Line
              key={t} type="monotone" dataKey={t} name={t}
              stroke={clr(i)} strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5, stroke: clr(i), fill: clr(i) }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }


  // ── Radar ────────────────────────────────────────────────────────────────────
  if (cfg.type === "radar") {
    // Require at least 1 team selected
    const radarTeamNums = cfgTeamFilter.length ? cfgTeamFilter : [];
    if (!radarTeamNums.length) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
          <p className="text-sm text-muted-foreground">Select 1–3 teams to compare in this radar.</p>
          <p className="text-xs text-muted-foreground opacity-60">Click <strong>Edit</strong> on this card to choose teams.</p>
        </div>
      );
    }

    // Build combined axis list: scouting numeric fields + EPA fields
    const scoutingAxes = fields
      .filter((f) => f.type === "number" || f.type === "counter" || f.type === "checkbox")
      .map((f) => ({ id: f.id, label: f.label }));

    // Include EPA axes that have at least one non-null value across teamRows
    const epaRadarAxes = EPA_AXES.filter((a) =>
      teamRows.some((r) => getNum(r, a.id) !== null)
    ).map((a) => ({ id: a.id, label: a.label }));

    const allAxes = [...scoutingAxes, ...epaRadarAxes];

    if (allAxes.length < 2) {
      return <Empty msg="Need at least 2 numeric fields or EPA data loaded for a radar chart" />;
    }

    const radarTeamStrs = radarTeamNums.map(String);
    const byTeam = groupBy(teamRows, "_teamStr");

    // Normalise per axis: max value across ALL teams (not just selected)
    const axisMaxes: Record<string, number> = {};
    for (const ax of allAxes) {
      const vals = teamRows.map((r) => getNum(r, ax.id)).filter((v): v is number => v !== null);
      axisMaxes[ax.id] = vals.length && Math.max(...vals) > 0 ? Math.max(...vals) : 1;
    }

    const radarData = allAxes.map((ax) => {
      const pt: Record<string, unknown> = { field: ax.label };
      for (const t of radarTeamStrs) {
        const row = byTeam[t]?.[0];
        const rawVal = row ? (getNum(row, ax.id) ?? 0) : 0;
        // Normalised 0-100 value drives the spoke length
        pt[t] = Number(((rawVal / axisMaxes[ax.id]) * 100).toFixed(1));
        // Raw value stored separately so the tooltip can display actual averages
        pt[`__raw_${t}`] = rawVal;
      }
      return pt;
    });

    return (
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={radarData} margin={{ top: 28, right: 72, left: 72, bottom: 28 }}>
          {/* Concentric circular rings + radial spoke lines */}
          <PolarGrid
            gridType="circle"
            stroke="rgba(255,255,255,0.15)"
            radialLines={true}
          />

          {/* Spoke labels — field names around the outside, white */}
          <PolarAngleAxis
            dataKey="field"
            tick={{ fill: "white", fontSize: 11, fontWeight: 500 }}
            tickLine={{ stroke: "rgba(255,255,255,0.3)" }}
          />

          {/* Radius axis — vertical at top-centre (angle=90), white ticks */}
          <PolarRadiusAxis
            angle={90}
            domain={[0, 100]}
            tickCount={5}
            tick={{ fill: "white", fontSize: 9, opacity: 0.7 }}
            axisLine={{ stroke: "rgba(255,255,255,0.25)" }}
            tickLine={false}
            tickFormatter={(v: number) => `${v}%`}
          />

          <Tooltip content={<RadarTip />} />
          <Legend
            formatter={(v) => `Team #${v}`}
            wrapperStyle={{ color: "white", fontSize: 11, paddingTop: 8 }}
          />

          {radarTeamStrs.map((t, i) => (
            <Radar
              key={t}
              name={t}
              dataKey={t}
              stroke={clr(i)}
              fill={clr(i)}
              fillOpacity={0.15}
              strokeWidth={2}
              dot={(props: Record<string, unknown>) => {
                const { cx, cy } = props as { cx: number; cy: number };
                return (
                  <circle
                    key={`dot-${t}-${cx}-${cy}`}
                    cx={cx}
                    cy={cy}
                    r={4}
                    fill={clr(i)}
                    stroke="rgba(0,0,0,0.4)"
                    strokeWidth={1}
                  />
                );
              }}
            />
          ))}
        </RadarChart>
      </ResponsiveContainer>
    );

  }

  // ── Histogram ────────────────────────────────────────────────────────────────
  if (cfg.type === "histogram") {
    // Collect (rounded-integer-value, team) pairs
    const pairs = filtered
      .map((r) => ({ v: getNum(r, cfg.yAxis), team: r._teamStr as string }))
      .filter((p): p is { v: number; team: string } => p.v !== null);
    if (!pairs.length) return <Empty msg={`No numeric data for "${yLabel}"`} />;

    const intVals = pairs.map((p) => Math.round(p.v));
    const mn = Math.min(...intVals), mx = Math.max(...intVals);
    const teamList = Array.from(new Set(pairs.map((p) => p.team))).sort();

    // Yellow-forward palette so bars are yellow-dominant
    const histClr = (i: number) =>
      (["#f59e0b","#6366f1","#10b981","#ef4444","#8b5cf6","#3b82f6","#f97316","#14b8a6","#ec4899","#84cc16"] as string[])[i % 10];

    // One data row per whole-number bucket
    const data: Record<string, unknown>[] = [];
    for (let bkt = mn; bkt <= mx; bkt++) {
      const row: Record<string, unknown> = { bucket: String(bkt) };
      for (const t of teamList) {
        row[t] = pairs.filter((p) => Math.round(p.v) === bkt && p.team === t).length;
      }
      data.push(row);
    }

    return (
      <ResponsiveContainer width="100%" height="100%">
        <ReBarChart data={data} margin={{ top: 12, right: 16, left: 4, bottom: 56 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="bucket" tick={<WhiteTickX />} angle={-35} textAnchor="end" interval={0}
            tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
            label={{ value: yLabel, position: "insideBottom", offset: -44, fill: "white", fontSize: 11 }} />
          <YAxis tick={<WhiteTickY />} tickLine={{ stroke: "white" }} axisLine={{ stroke: "white" }}
            allowDecimals={false}
            label={{ value: "Count", angle: -90, position: "insideLeft", fill: "white", fontSize: 11 }} />
          <Tooltip
            content={({ active, payload, label: bktLabel }) => {
              if (!active || !payload?.length) return null;
              const entries = payload.filter((p) => (p.value as number) > 0);
              const total = entries.reduce((s, p) => s + (p.value as number), 0);
              return (
                <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-xs space-y-1">
                  <p className="font-bold">{yLabel} = {bktLabel} <span className="text-muted-foreground font-normal">(total: {total})</span></p>
                  {entries.map((p, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
                      <span className="text-muted-foreground">#{p.name}:</span>
                      <span className="font-mono font-semibold">{p.value} match{Number(p.value) !== 1 ? "es" : ""}</span>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          <Legend wrapperStyle={{ color: "white", fontSize: 11, paddingTop: 8 }} formatter={(v) => `#${v}`} />
          {teamList.map((t, i) => (
            <Bar key={t} dataKey={t} name={t} stackId="hist" fill={histClr(i)} fillOpacity={0.9}
              radius={i === teamList.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
          ))}
        </ReBarChart>
      </ResponsiveContainer>
    );
  }




  // ── Box Plot ──────────────────────────────────────────────────────────────────
  // Fully responsive pure-SVG boxplot: ResizeObserver drives real pixel width,
  // one box per team, rich hover tooltip with big-5 stats.
  if (cfg.type === "boxplot") {
    return <BoxPlotRenderer cfg={cfg} filtered={filtered} teamRows={teamRows} matchEpaRows={matchEpaRows} yLabel={yLabel} isEpaY={isEpaAxis(cfg.yAxis)} />;
  }

  return <Empty msg="Unknown chart type" />;
}

// ─────────────────────────────── Box Plot Renderer ───────────────────────────

interface BoxEntry {
  teamLabel: string;
  s: NonNullable<ReturnType<typeof boxStats>>;
  color: string;
}

interface TooltipState {
  box: BoxEntry;
  x: number; // page X
  y: number; // page Y
}

function BoxPlotRenderer({
  cfg, filtered, teamRows, matchEpaRows, yLabel, isEpaY,
}: {
  cfg: ChartCfg;
  filtered: Record<string, unknown>[];
  teamRows: Record<string, unknown>[];
  matchEpaRows: Record<string, unknown>[];
  yLabel: string;
  isEpaY: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgW, setSvgW] = useState(600);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // ResizeObserver: keep svgW in sync with the actual container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setSvgW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Defensively normalise all array props — guards against undefined from stale/missing data
  const safeFiltered     = filtered     ?? [];
  const safeTeamRows     = teamRows     ?? [];
  const safeMatchEpaRows = matchEpaRows ?? [];
  const cfgTeams         = cfg.teams    ?? [];

  // For EPA axes: use per-match EPA rows so each team has multiple values → real spread.
  // Fall back to teamRows only when matchEpaRows hasn't loaded yet (n=0).
  // For scouting axes: use per-submission rows (filtered).
  const srcRows = isEpaY
    ? (safeMatchEpaRows.length > 0 ? safeMatchEpaRows : safeTeamRows)
    : safeFiltered;

  const srcByTeam = groupBy(srcRows, "_teamStr");
  const allSrcTeams = Array.from(new Set(srcRows.map((r) => r._teamStr as string))).sort();
  const srcTeams = cfgTeams.length
    ? allSrcTeams.filter((t) => cfgTeams.includes(Number(t)))
    : allSrcTeams;

  const boxes: BoxEntry[] = [];
  srcTeams.forEach((t, i) => {
    const vals = (srcByTeam[t] ?? [])
      .map((r) => getNum(r, cfg.yAxis))
      .filter((v): v is number => v !== null);
    const s = boxStats(vals);
    if (s) boxes.push({ teamLabel: t, s, color: clr(i) });
  });

  if (!srcTeams.length) return <Empty msg={isEpaY ? "No EPA data" : "No scouting submissions"} />;
  if (!boxes.length) return <Empty msg="No numeric data for selected teams" />;

  // Y range — computed from current visible boxes → auto-scales with filters
  const allY = boxes.flatMap((b) => [b.s.min, b.s.max]);
  const yDataMin = Math.min(...allY);
  const yDataMax = Math.max(...allY);
  const yPad = (yDataMax - yDataMin) * 0.12 || 1;
  const yMin = Math.max(0, yDataMin - yPad);
  const yMax = yDataMax + yPad;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // SVG layout
  const SVG_H = 280;
  const marginTop = 16, marginBottom = 60, marginLeft = 56, marginRight = 16;
  const plotH = SVG_H - marginTop - marginBottom;
  const plotW = svgW - marginLeft - marginRight;

  const yPx = (v: number) => marginTop + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const n = boxes.length;
  const slotW = plotW / n;
  const boxW = Math.min(60, Math.max(18, slotW * 0.5));
  const xCenter = (i: number) => marginLeft + slotW * i + slotW / 2;

  // Y axis ticks
  const tickCount = 6;
  const tickStep = (yMax - yMin) / (tickCount - 1 || 1);
  const yTicks = Array.from({ length: tickCount }, (_, i) => round2(yMin + tickStep * i));

  const handleMouseMove = useCallback((e: React.MouseEvent, box: BoxEntry) => {
    setTooltip({ box, x: e.clientX, y: e.clientY });
  }, []);
  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", minHeight: 200, position: "relative" }}>
      <svg
        width={svgW}
        height={SVG_H}
        style={{ display: "block", overflow: "visible" }}
      >
        {/* Y grid lines + ticks */}
        {yTicks.map((v) => {
          const py = yPx(v);
          return (
            <g key={v}>
              <line x1={marginLeft} y1={py} x2={svgW - marginRight} y2={py}
                stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
              <text x={marginLeft - 6} y={py} fill="white" fontSize={10}
                textAnchor="end" dominantBaseline="middle">
                {v}
              </text>
            </g>
          );
        })}

        {/* Y axis label */}
        <text
          x={12} y={marginTop + plotH / 2}
          fill="white" fontSize={11} textAnchor="middle"
          transform={`rotate(-90, 12, ${marginTop + plotH / 2})`}
        >
          {yLabel}
        </text>

        {/* One box per team */}
        {boxes.map((b, i) => {
          const cx = xCenter(i);
          const x1 = cx - boxW / 2;
          const x2 = cx + boxW / 2;
          const pMin = yPx(b.s.min);
          const pMax = yPx(b.s.max);
          const pQ1  = yPx(b.s.q1);
          const pQ3  = yPx(b.s.q3);
          const pMed = yPx(b.s.med);
          const boxH = Math.max(2, pQ1 - pQ3);
          const capW = boxW * 0.45;

          // Invisible hit area spanning the full box extent for easy hover
          const hitTop = pMax - 6;
          const hitHeight = Math.max(12, pMin - pMax + 12);

          return (
            <g key={b.teamLabel}>
              {/* Whisker: max → Q3 */}
              <line x1={cx} y1={pMax} x2={cx} y2={pQ3} stroke={b.color} strokeWidth={1.5} strokeDasharray="4 2" />
              {/* Whisker: Q1 → min */}
              <line x1={cx} y1={pQ1} x2={cx} y2={pMin} stroke={b.color} strokeWidth={1.5} strokeDasharray="4 2" />
              {/* Whisker caps */}
              <line x1={cx - capW} y1={pMax} x2={cx + capW} y2={pMax} stroke={b.color} strokeWidth={2.5} strokeLinecap="round" />
              <line x1={cx - capW} y1={pMin} x2={cx + capW} y2={pMin} stroke={b.color} strokeWidth={2.5} strokeLinecap="round" />
              {/* IQR box */}
              <rect x={x1} y={pQ3} width={boxW} height={boxH}
                fill={b.color} fillOpacity={0.2} stroke={b.color} strokeWidth={2} rx={3} />
              {/* Median line */}
              <line x1={x1} y1={pMed} x2={x2} y2={pMed} stroke="white" strokeWidth={3} strokeLinecap="round" />
              {/* X label */}
              <text
                x={cx} y={SVG_H - marginBottom + 14}
                fill="white" fontSize={10} textAnchor="middle"
                transform={n > 5 ? `rotate(-35, ${cx}, ${SVG_H - marginBottom + 14})` : undefined}
              >
                #{b.teamLabel}
              </text>
              {/* n= label */}
              <text x={cx} y={SVG_H - marginBottom + (n > 5 ? 28 : 26)}
                fill="rgba(255,255,255,0.4)" fontSize={9} textAnchor="middle">
                {`n=${b.s.n}`}
              </text>
              {/* Transparent hover hit area */}
              <rect
                x={x1 - 4} y={hitTop} width={boxW + 8} height={hitHeight}
                fill="transparent" style={{ cursor: "crosshair" }}
                onMouseMove={(e) => handleMouseMove(e, b)}
                onMouseLeave={handleMouseLeave}
              />
            </g>
          );
        })}
      </svg>

      {/* Rich React tooltip — rendered in the container, positioned via fixed offsets */}
      {tooltip && (
        <div
          style={{
            position: "fixed",
            left: tooltip.x + 14,
            top: tooltip.y - 10,
            zIndex: 9999,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 10,
              padding: "10px 14px",
              boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
              minWidth: 160,
              fontSize: 12,
            }}
          >
            {/* Team header */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{
                width: 10, height: 10, borderRadius: "50%",
                background: tooltip.box.color, display: "inline-block", flexShrink: 0,
              }} />
              <span style={{ fontWeight: 700, fontSize: 13 }}>
                Team #{tooltip.box.teamLabel}
              </span>
              <span style={{ color: "hsl(var(--muted-foreground))", fontSize: 10, marginLeft: "auto" }}>
                n={tooltip.box.s.n}
              </span>
            </div>
            {/* Big 5 stats */}
            {[
              { label: "Max",    value: tooltip.box.s.max  },
              { label: "Q3",     value: tooltip.box.s.q3   },
              { label: "Median", value: tooltip.box.s.med  },
              { label: "Q1",     value: tooltip.box.s.q1   },
              { label: "Min",    value: tooltip.box.s.min  },
            ].map(({ label, value }) => (
              <div key={label} style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "center", gap: 16,
                padding: "2px 0",
                borderBottom: label === "Median" ? `1px solid ${tooltip.box.color}55` : undefined,
                marginBottom: label === "Median" ? 4 : undefined,
                paddingBottom: label === "Median" ? 4 : undefined,
              }}>
                <span style={{
                  color: label === "Median" ? "white" : "hsl(var(--muted-foreground))",
                  fontWeight: label === "Median" ? 700 : 400,
                }}>
                  {label}
                </span>
                <span style={{
                  fontFamily: "monospace",
                  fontWeight: label === "Median" ? 700 : 600,
                  color: label === "Median" ? tooltip.box.color : "white",
                }}>
                  {value.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="flex items-center justify-center h-full text-muted-foreground text-sm opacity-60">{msg}</div>;
}

// ─────────────────────────────── Chart Card ───────────────────────────────────

function ChartCard({ cfg, rows, teamRows, matchEpaRows, fields, axes, onRemove, onEdit }: {
  cfg: ChartCfg; rows: Record<string, unknown>[]; teamRows: Record<string, unknown>[];
  matchEpaRows: Record<string, unknown>[];
  fields: FormField[]; axes: AxisOpt[];
  onRemove: () => void; onEdit: () => void;
}) {
  const yLabel = axes.find((a) => a.id === cfg.yAxis)?.label ?? cfg.yAxis;
  const xLabel = axes.find((a) => a.id === cfg.xAxis)?.label ?? cfg.xAxis;
  const needsX = cfg.type === "scatter" || cfg.type === "line";
  return (
    <div className="rounded-xl border border-border bg-card flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/20 shrink-0">
        <div>
          <p className="text-sm font-semibold">{cfg.title}</p>
          <p className="text-[10px] text-muted-foreground capitalize">
            {cfg.type}
            {cfg.type === "radar"
              ? ` · teams: ${(cfg.teams?.length ?? 0) > 0 ? cfg.teams.map(t => `#${t}`).join(", ") : "none selected"}`
              : ` · ${yLabel}`}
            {needsX && ` vs ${xLabel}`}
            {cfg.type !== "radar" && (cfg.teams?.length ?? 0) > 0 && ` · ${cfg.teams.length} teams`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onEdit} className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors">Edit</button>
          <button onClick={onRemove} className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-destructive/10 transition-colors"><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {/* Resizable chart area */}
      <div className="p-2 overflow-auto" style={{ resize: "vertical", minHeight: 220, height: 320 }}>
        <div style={{ width: "100%", height: "100%" }}>
          <ChartInner cfg={cfg} rows={rows} teamRows={teamRows} matchEpaRows={matchEpaRows} fields={fields} axes={axes} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────── Builder panel ────────────────────────────────

function Builder({ axes, fields: _fields, allTeams, initial, onSave, onCancel }: {
  axes: AxisOpt[]; fields: FormField[]; allTeams: number[];
  initial?: Partial<ChartCfg>;
  onSave: (c: ChartCfg) => void;
  onCancel: () => void;
}) {
  const scoutingAxes = axes.filter((a) => a.group === "scouting");
  const defaultY = scoutingAxes[0]?.id ?? axes[0]?.id ?? "";
  const defaultX = axes.find((a) => a.id === "_match")?.id ?? axes[0]?.id ?? "";

  const [type, setType]     = useState<ChartType>(initial?.type ?? "bar");
  const [title, setTitle]   = useState(initial?.title ?? "");
  const [xAxis, setXAxis]   = useState(initial?.xAxis ?? defaultX);
  const [yAxis, setYAxis]   = useState(initial?.yAxis ?? defaultY);
  const [selTeams, setSelTeams] = useState<number[]>(initial?.teams ?? []);
  const [teamsOpen, setTeamsOpen] = useState(false);

  // When axes load (fields populated async), reset defaults if still on empty strings
  useEffect(() => {
    if (!xAxis && defaultX) setXAxis(defaultX);
    if (!yAxis && defaultY) setYAxis(defaultY);
  }, [defaultX, defaultY]);

  const needsX = type === "scatter" || type === "line";

  const grouped: Record<string, AxisOpt[]> = {};
  for (const a of axes) (grouped[a.group] ??= []).push(a);
  const groupNames: Record<string, string> = { scouting: "Scouting Fields", epa: "Statbotics EPA", match: "Match Info" };

  function AxisSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
    return (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary">
        {Object.entries(grouped).map(([g, opts]) => (
          <optgroup key={g} label={groupNames[g] ?? g}>
            {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </optgroup>
        ))}
      </select>
    );
  }

  function save() {
    const autoTitle = `${type.charAt(0).toUpperCase() + type.slice(1)} — ${axes.find(a => a.id === yAxis)?.label ?? yAxis}`;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      title: title.trim() || autoTitle,
      type, xAxis: needsX ? xAxis : "_match", yAxis,
      teams: selTeams,
    });
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Chart type grid */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Chart Type</p>
        <div className="grid grid-cols-3 gap-1.5">
          {CHART_DEFS.map(({ type: t, label, icon: Icon, desc }) => (
            <button key={t} onClick={() => setType(t)}
              className={`flex flex-col items-center gap-1 p-2 rounded-lg border text-xs transition-all ${
                type === t ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted/50"
              }`}>
              <Icon className="h-4 w-4" />
              <span className="font-medium">{label}</span>
              <span className="text-[9px] text-center leading-tight opacity-70">{desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Title */}
      <div>
        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block" htmlFor="cv-title">Title</label>
        <input id="cv-title" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="Auto-generated if empty"
          className="w-full rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
      </div>

      {/* Axes */}
      {type !== "radar" && (
        <div className="flex flex-col gap-3">
          {needsX && (
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block" htmlFor="cv-x">X Axis</label>
              <AxisSelect id="cv-x" value={xAxis} onChange={setXAxis} />
            </div>
          )}
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block" htmlFor="cv-y">
              {type === "histogram" ? "Field to Distribute" : needsX ? "Y Axis" : "Metric"}
            </label>
            <AxisSelect id="cv-y" value={yAxis} onChange={setYAxis} />
          </div>
        </div>
      )}
      {type === "radar" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
            Radar charts use all numeric fields from your scouting form, normalised to 0–100.
            Select <strong>1–3 teams</strong> below to overlay and compare.
          </p>
        </div>
      )}

      {/* Teams selector — required for radar (1–3), optional filter for others */}
      <div>
        <button onClick={() => setTeamsOpen((o) => !o)}
          className="w-full flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wider py-1">
          <span>
            {type === "radar"
              ? <>Select Teams <span className="text-primary">(1–3 required)</span> {selTeams.length > 0 && `· ${selTeams.length} chosen`}</>
              : <>Filter Teams {selTeams.length > 0 && `(${selTeams.length})`}</>}
          </span>
          {teamsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        {teamsOpen && (
          <div className="mt-2 rounded-lg border border-border bg-muted/20 p-2">
            <button onClick={() => setSelTeams([])} className="text-xs text-primary hover:underline mb-2 block">
              Clear {type !== "radar" && "(all teams)"}
            </button>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
              {allTeams.map((t) => {
                const selected = selTeams.includes(t);
                const atLimit = type === "radar" && selTeams.length >= 3 && !selected;
                return (
                  <button key={t}
                    onClick={() => {
                      if (atLimit) return;
                      setSelTeams((p) => p.includes(t) ? p.filter((x) => x !== t) : [...p, t]);
                    }}
                    disabled={atLimit}
                    className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${
                      selected
                        ? "bg-primary text-primary-foreground border-primary"
                        : atLimit
                          ? "border-border text-muted-foreground opacity-30 cursor-not-allowed"
                          : "border-border text-muted-foreground hover:bg-muted"
                    }`}>
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <Button onClick={save} className="flex-1" size="sm">{initial?.id ? "Update" : "Add Chart"}</Button>
        <Button onClick={onCancel} variant="outline" size="sm">Cancel</Button>
      </div>
    </div>
  );
}

// ─────────────────────────────── Page ─────────────────────────────────────────

export default function DataViewerPage() {
  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const eventKey = currentEvent?.eventKey ?? "";
  const eventYear = eventKey ? Number(eventKey.slice(0, 4)) : new Date().getFullYear();

  const allSubsLive = useQuery(api.forms.listSubmissions, eventKey ? { eventKey } : "skip");
  const allSubs = useCached(allSubsLive, `submissions_${eventKey}`) as Submission[] | null;

  // Use listActiveTemplates so we get fields from the Default form specifically.
  // The Default form has numeric/counter fields that drive scouting axes.
  // Fallback: if no Default form is active, try any active template.
  const activeTemplatesLive = useQuery(api.forms.listActiveTemplates);
  const activeTemplates = useCached(activeTemplatesLive, "active_templates") as Array<{ _id: string; formType?: string; fields: FormField[]; isActive: boolean }> | null;
  const fields: FormField[] = useMemo(() => {
    if (!activeTemplates) return [];
    const defaultTpl = activeTemplates.find((t) => (t.formType ?? "default") === "default");
    const anyTpl = activeTemplates[0];
    return ((defaultTpl ?? anyTpl)?.fields as FormField[]) ?? [];
  }, [activeTemplates]);

  const [epaByTeam, setEpaByTeam]      = useState<Record<number, Record<string, number | null>>>({});
  const [matchEpaRows, setMatchEpaRows] = useState<Record<string, unknown>[]>([]);
  const [allTeams, setAllTeams]         = useState<number[]>([]);
  // Persist charts to localStorage keyed by event.
  // We use a ref+effect pattern because eventKey may resolve asynchronously
  // from a Convex query — so we re-load charts whenever the key changes.
  const [charts, setChartsRaw] = useState<ChartCfg[]>([]);
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = `falconscout_charts_${eventKey || "__global__"}`;
    if (loadedKeyRef.current === key) return; // already loaded for this event
    loadedKeyRef.current = key;
    try {
      const raw = localStorage.getItem(key);
      if (raw) setChartsRaw(JSON.parse(raw) as ChartCfg[]);
    } catch { /* corrupted storage — start fresh */ }
  }, [eventKey]);

  // Write to localStorage on every charts change
  useEffect(() => {
    if (!loadedKeyRef.current) return; // don't write before the first load
    try { localStorage.setItem(loadedKeyRef.current, JSON.stringify(charts)); }
    catch { /* storage quota exceeded */ }
  }, [charts]);

  function setCharts(updater: ChartCfg[] | ((prev: ChartCfg[]) => ChartCfg[])) {
    setChartsRaw(updater);
  }
  const [building, setBuilding]         = useState(false);
  const [editingId, setEditingId]       = useState<string | null>(null);

  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    async function load() {
      const [sbRaw, tbaRaw, matchRaw] = await Promise.all([
        fetchStatboticsEventTeams(eventKey),
        fetchTBAEventTeams(eventKey),
        fetchStatboticsEventTeamMatches(eventKey),
      ]);
      if (cancelled) return;

      function findEpa(obj: unknown, ...keys: string[]): number | null {
        if (!obj || typeof obj !== "object") return null;
        const o = obj as Record<string, unknown>;
        for (const k of keys) {
          const v = o[k];
          if (typeof v === "number") return Number(v.toFixed(2));
          if (v && typeof v === "object" && "mean" in (v as object)) return Number(((v as {mean: number}).mean).toFixed(2));
        }
        for (const val of Object.values(o)) {
          if (val && typeof val === "object" && !Array.isArray(val)) {
            const r = findEpa(val, ...keys);
            if (r !== null) return r;
          }
        }
        return null;
      }

      if (Array.isArray(sbRaw)) {
        const m: Record<number, Record<string, number | null>> = {};
        for (const t of sbRaw as Array<{ team: number; epa: unknown }>) {
          m[t.team] = {
            epa_total:   findEpa(t.epa, "total_points", "total"),
            epa_auto:    findEpa(t.epa, "auto_points",  "auto"),
            epa_teleop:  findEpa(t.epa, "teleop_points","teleop"),
            epa_endgame: findEpa(t.epa, "endgame_points","endgame"),
          };
        }
        setEpaByTeam(m);
      }

      if (Array.isArray(tbaRaw)) {
        setAllTeams((tbaRaw as Array<{ team_number: number }>).map((t) => t.team_number).sort((a, b) => a - b));
      }

      // Build per-match EPA rows from Statbotics team_match data.
      // Each entry: { _team, _teamStr, _match, epa_total, epa_auto, epa_teleop, epa_endgame }
      // epa values come from epa.start (EPA going INTO the match — changes each match).
      if (Array.isArray(matchRaw)) {
        const mRows = (matchRaw as Array<Record<string, unknown>>)
          .filter((m) => m.comp_level === "qm")  // quals only
          .map((m) => {
            const team = m.team as number;
            const mn   = m.match_number as number;
            const start = (m.epa as Record<string, unknown> | undefined)?.start as Record<string, unknown> | undefined;
            return {
              _team:       team,
              _teamStr:    String(team),
              _match:      mn,
              epa_total:   typeof start?.total   === "number" ? Number((start.total   as number).toFixed(2)) : null,
              epa_auto:    typeof start?.auto    === "number" ? Number((start.auto    as number).toFixed(2)) : null,
              epa_teleop:  typeof start?.teleop  === "number" ? Number((start.teleop  as number).toFixed(2)) : null,
              epa_endgame: typeof start?.endgame === "number" ? Number((start.endgame as number).toFixed(2)) : null,
            };
          });
        setMatchEpaRows(mRows);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [eventKey, eventYear]);

  const axes = useMemo<AxisOpt[]>(() => [
    ...MATCH_AXES,
    ...fields.filter((f) => ["number","counter","checkbox","rating"].includes(f.type))
              .map((f): AxisOpt => ({ id: f.id, label: f.label, group: "scouting" })),
    ...EPA_AXES,
  ], [fields]);

  const rows = useMemo(() => {
    if (!allSubs) return [];
    return buildRows(allSubs, fields, epaByTeam);
  }, [allSubs, fields, epaByTeam]);

  // One row per team — used by any chart that references an EPA axis
  const teamRows = useMemo(() => {
    return buildTeamRows(allSubs ?? [], fields, epaByTeam, allTeams);
  }, [allSubs, fields, epaByTeam, allTeams]);

  const scoutedTeams = useMemo(() =>
    Array.from(new Set((allSubs ?? []).map((s: Submission) => s.teamNumber))).sort((a, b) => a - b),
    [allSubs]);
  const teamList = allTeams.length ? allTeams : scoutedTeams;

  const editingCfg = charts.find((c) => c.id === editingId);

  function upsert(cfg: ChartCfg) {
    setCharts((p) => {
      const i = p.findIndex((c) => c.id === cfg.id);
      if (i >= 0) { const n = [...p]; n[i] = cfg; return n; }
      return [...p, cfg];
    });
    setBuilding(false);
    setEditingId(null);
  }

  if (!eventKey) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground">
        <BarChart2 className="h-10 w-10 opacity-20" />
        <p className="text-sm">No event selected. Set one in Settings.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Data Viewer</h2>
          <p className="text-muted-foreground text-sm">
            {currentEvent?.eventName ?? eventKey} · {rows.length} data points · {scoutedTeams.length} teams scouted
          </p>
        </div>
        <Button onClick={() => { setBuilding(true); setEditingId(null); }} className="gap-2 self-start sm:self-auto" disabled={axes.length <= 1}>
          <Plus className="h-4 w-4" />New Chart
        </Button>
      </div>

      <div className="flex-1 flex gap-4 min-h-0">
        {/* Sidebar */}
        {(building || editingId !== null) && (
          <div className="w-72 shrink-0 rounded-xl border border-border bg-card flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-muted/20 shrink-0 flex items-center justify-between">
              <p className="text-sm font-semibold">{editingId ? "Edit Chart" : "New Chart"}</p>
              <button onClick={() => { setBuilding(false); setEditingId(null); }}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
            <ScrollArea className="flex-1">
              <Builder
                key={editingId ?? "new"}
                axes={axes}
                fields={fields}
                allTeams={teamList}
                initial={editingCfg}
                onSave={upsert}
                onCancel={() => { setBuilding(false); setEditingId(null); }}
              />
            </ScrollArea>
          </div>
        )}

        {/* Canvas */}
        <div className="flex-1 min-w-0 min-h-0">
          {charts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground rounded-xl border-2 border-dashed border-border">
              <BarChart2 className="h-12 w-12 opacity-20" />
              <div className="text-center">
                <p className="font-medium">No charts yet</p>
                <p className="text-sm opacity-70">Click "New Chart" to visualize your scouting data</p>
              </div>
              <Button variant="outline" onClick={() => setBuilding(true)} className="gap-2" disabled={axes.length <= 1}>
                <Plus className="h-4 w-4" />Create Chart
              </Button>
              {axes.length <= 1 && (
                <p className="text-xs text-amber-500">⚠ No scouting form is active or no submissions exist yet</p>
              )}
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 pb-4">
                {charts.map((c) => (
                  <ChartCard
                    key={c.id} cfg={c} rows={rows} teamRows={teamRows} matchEpaRows={matchEpaRows} fields={fields} axes={axes}
                    onRemove={() => setCharts((p) => p.filter((x) => x.id !== c.id))}
                    onEdit={() => { setEditingId(c.id); setBuilding(false); }}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
