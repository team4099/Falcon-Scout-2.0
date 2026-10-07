import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useCurrentEvent } from "@/hooks/useCurrentEvent";
import { useEventTeamData } from "@/hooks/useEventTeamData";
import type { EventSubmission } from "@/hooks/useEventTeamData";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { BarChart2, ScatterChart as ScatterIcon, TrendingUp, Plus, X } from "lucide-react";
import {
  ScatterChart as ReScatterChart, Scatter, LabelList,
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { fetchStatboticsEventTeamMatches, fetchStatboticsTeamSeason } from "@/lib/api";
import { EMPTY_TEAM_EPA } from "@/lib/epa";
import type { TeamStats } from "@/lib/rankingColumns";
import {
  buildTimelines, chartMetrics, scatterValue, slimTbaMatch,
} from "@/lib/chartData";
import type {
  ChartCfg, ChartMetric, ChartType, FieldColumn, LineScope, SlimMatch, SlimTeamMatch,
} from "@/lib/chartData";

// ─────────────────────────────── Mobile hook ──────────────────────────────────

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}

// ─────────────────────────────── Constants ────────────────────────────────────

const CHART_DEFS: { type: ChartType; label: string; icon: React.ElementType; desc: string }[] = [
  { type: "scatter", label: "Scatter", icon: ScatterIcon, desc: "One dot per team" },
  { type: "line",    label: "Line",    icon: TrendingUp,  desc: "Trend over matches" },
];

const COLORS = [
  "#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6",
  "#3b82f6","#f97316","#14b8a6","#ec4899","#84cc16",
];
const clr = (i: number) => COLORS[i % COLORS.length];

const SCOPE_LABEL: Record<LineScope, string> = { event: "This event", season: "Whole season" };

/** Everything a chart needs, shared by every card on the page. */
interface ChartContext {
  eventKey: string;
  allTeams: number[];
  metrics: Record<ChartType, ChartMetric[]>;
  statsFor: (team: number) => TeamStats;
  fieldColumns: FieldColumn[];
  submissions: EventSubmission[];
  eventMatches: SlimMatch[];
  eventTeamMatches: SlimTeamMatch[];
  season: Record<number, { matches: SlimMatch[]; teamMatches: SlimTeamMatch[] }>;
  seasonLoading: boolean;
}

const chartTeams = (cfg: ChartCfg, ctx: ChartContext) => (cfg.teams?.length ? cfg.teams : ctx.allTeams);
const metricLabel = (ctx: ChartContext, type: ChartType, id: string) =>
  ctx.metrics[type].find((m) => m.id === id)?.label;

// ─────────────────────────────── Chart renderers ──────────────────────────────

// Chart chrome inherits `color` from the chart container (see ChartCard's
// wrapper), so `currentColor` resolves correctly in both light and dark themes.
// Do NOT use `var(--token)` here: recharts passes most of these through as SVG
// presentation attributes, which do not resolve CSS custom properties.
const GRID_PROPS = { strokeDasharray: "3 3", stroke: "currentColor", opacity: 0.15 };
const AXIS_LINE  = { stroke: "currentColor", opacity: 0.35 };
const MARGIN = { top: 16, right: 16, left: 4, bottom: 44 };

// Bottom-axis tick: dy=10 pushes label clearly below the tick line
function AxisTickX({ x, y, payload, textAnchor, angle }: {
  x?: number; y?: number; payload?: { value: unknown }; textAnchor?: string; angle?: number;
}) {
  return (
    <text x={x} y={y} textAnchor={(textAnchor ?? "middle") as "inherit" | "start" | "end" | "middle"}
      style={{ fill: "currentColor", fontSize: 11, opacity: 0.75 }} dy={10}
      transform={angle ? `rotate(${angle} ${x} ${y})` : undefined}>
      {String(payload?.value ?? "")}
    </text>
  );
}

// Left-axis tick: dominantBaseline keeps text vertically centered on its tick mark
function AxisTickY({ x, y, payload, textAnchor }: {
  x?: number; y?: number; payload?: { value: unknown }; textAnchor?: string;
}) {
  return (
    <text x={x} y={y} textAnchor={(textAnchor ?? "end") as "inherit" | "start" | "end" | "middle"}
      dominantBaseline="middle"
      style={{ fill: "currentColor", fontSize: 11, opacity: 0.75 }} dy={0}>
      {String(payload?.value ?? "")}
    </text>
  );
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// Above this many overlaid lines, a line chart turns into unreadable "spaghetti" —
// nudge the user toward the team picker instead of silently rendering a mess.
const LINE_SPAGHETTI_THRESHOLD = 8;
function TooManyLinesHint({ count }: { count: number }) {
  return (
    <div className="absolute top-1 right-1 z-10 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-600 dark:text-amber-400">
      {count} teams shown — click <strong>Edit</strong> to pick specific teams
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="flex items-center justify-center h-full px-4 text-center text-muted-foreground text-sm opacity-60">{msg}</div>;
}

function ScatterView({ cfg, ctx }: { cfg: ChartCfg; ctx: ChartContext }) {
  const xLabel = metricLabel(ctx, "scatter", cfg.xAxis);
  const yLabel = metricLabel(ctx, "scatter", cfg.yAxis);
  const pts = useMemo(() => chartTeams(cfg, ctx).flatMap((team) => {
    const s = ctx.statsFor(team);
    const x = scatterValue(cfg.xAxis, s);
    const y = scatterValue(cfg.yAxis, s);
    return x !== null && y !== null ? [{ team, x, y }] : [];
  }), [cfg, ctx]);

  if (!xLabel || !yLabel) return <Empty msg="This chart uses a column that no longer exists — click Edit to pick new axes" />;
  if (!pts.length) return <Empty msg={`No teams have both ${xLabel} and ${yLabel} yet`} />;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ReScatterChart margin={MARGIN}>
        <CartesianGrid {...GRID_PROPS} />
        {/* Rank: #1 is best, so it reads left-to-right / bottom-to-top like the other stats. */}
        <XAxis type="number" dataKey="x" name={xLabel} domain={["auto", "auto"]} reversed={cfg.xAxis === "rank"}
          tick={<AxisTickX />} tickLine={AXIS_LINE} axisLine={AXIS_LINE}
          label={{ value: xLabel, position: "insideBottom", offset: -28, fill: "currentColor", fontSize: 11 }} />
        <YAxis type="number" dataKey="y" name={yLabel} domain={["auto", "auto"]} reversed={cfg.yAxis === "rank"}
          tick={<AxisTickY />} tickLine={AXIS_LINE} axisLine={AXIS_LINE}
          label={{ value: yLabel, angle: -90, position: "insideLeft", fill: "currentColor", fontSize: 11 }} />
        <Tooltip
          cursor={{ strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null;
            const d = payload[0].payload as { team: number; x: number; y: number };
            return (
              <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-xs space-y-0.5">
                <p className="font-bold text-sm">#{d.team}</p>
                <p>{xLabel}: <span className="font-mono font-semibold">{fmt(d.x)}</span></p>
                <p>{yLabel}: <span className="font-mono font-semibold">{fmt(d.y)}</span></p>
              </div>
            );
          }}
        />
        {/* No animation: it restarts on every data refresh, and LabelList only
            draws once an animation finishes, so team labels never appeared. */}
        <Scatter data={pts} fill={COLORS[0]} fillOpacity={0.85} isAnimationActive={false}>
          <LabelList dataKey="team" position="top" offset={6} style={{ fill: "currentColor", fontSize: 9, opacity: 0.7 }} />
        </Scatter>
      </ReScatterChart>
    </ResponsiveContainer>
  );
}

function LineView({ cfg, ctx }: { cfg: ChartCfg; ctx: ChartContext }) {
  const scope: LineScope = cfg.scope ?? "event";
  const yLabel = metricLabel(ctx, "line", cfg.yAxis);

  const { data, teams } = useMemo(() => {
    const teamList = chartTeams(cfg, ctx);
    const seasonRows = scope === "season" ? teamList.map((t) => ctx.season[t]) : [];
    const timelines = buildTimelines({
      teams: teamList,
      scope,
      eventKey: ctx.eventKey,
      matches: [...ctx.eventMatches, ...seasonRows.flatMap((r) => r?.matches ?? [])],
      teamMatches: [...ctx.eventTeamMatches, ...seasonRows.flatMap((r) => r?.teamMatches ?? [])],
      submissions: ctx.submissions,
      fieldColumns: ctx.fieldColumns,
      metric: cfg.yAxis,
    });

    // One row per X position; each team is a column (absent where it didn't play).
    const rows = new Map<number, Record<string, unknown>>();
    const withData: number[] = [];
    for (const team of teamList) {
      let any = false;
      for (const p of timelines[team] ?? []) {
        const v = p.values[cfg.yAxis];
        if (v === undefined) continue;
        any = true;
        const row = rows.get(p.order) ?? { order: p.order, x: scope === "season" ? p.order : p.label };
        row[`t${team}`] = v;
        row[`l${team}`] = scope === "season" ? `${p.event.slice(4)} ${p.label}` : p.label;
        rows.set(p.order, row);
      }
      if (any) withData.push(team);
    }
    return { data: [...rows.values()].sort((a, b) => (a.order as number) - (b.order as number)), teams: withData };
  }, [cfg, ctx, scope]);

  if (!yLabel) return <Empty msg="This chart uses a column that no longer exists — click Edit to pick a new one" />;
  if (!data.length) {
    if (scope === "season" && ctx.seasonLoading) return <Empty msg="Loading season matches…" />;
    return <Empty msg={`No ${yLabel} data for ${scope === "season" ? "this season" : "this event"}'s matches yet`} />;
  }

  const xLabel = scope === "season" ? "Match # this season" : "Match";
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {teams.length > LINE_SPAGHETTI_THRESHOLD && <TooManyLinesHint count={teams.length} />}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="x" tick={<AxisTickX />} tickLine={AXIS_LINE} axisLine={AXIS_LINE} minTickGap={8}
            label={{ value: xLabel, position: "insideBottom", offset: -28, fill: "currentColor", fontSize: 11 }} />
          <YAxis tick={<AxisTickY />} tickLine={AXIS_LINE} axisLine={AXIS_LINE} domain={["auto", "auto"]}
            label={{ value: yLabel, angle: -90, position: "insideLeft", fill: "currentColor", fontSize: 11 }} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as Record<string, unknown>;
              const entries = payload.filter((p) => typeof p.value === "number");
              return (
                <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-xs space-y-1">
                  <p className="font-bold">{scope === "season" ? `Match #${label}` : String(label)}</p>
                  {entries.map((p) => {
                    const team = String(p.dataKey).slice(1);
                    return (
                      <div key={team} className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
                        <span className="text-muted-foreground">#{team}</span>
                        {scope === "season" && <span className="text-muted-foreground/70">{String(row[`l${team}`] ?? "")}</span>}
                        <span className="ml-auto pl-2 font-mono font-semibold">{fmt(p.value as number)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          {teams.map((t, i) => (
            <Line key={t} type="monotone" dataKey={`t${t}`} name={String(t)}
              stroke={clr(i)} strokeWidth={2.5} dot={data.length <= 24 ? { r: 2.5, fill: clr(i) } : false}
              activeDot={{ r: 5, stroke: clr(i), fill: clr(i) }} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─────────────────────────────── Chart Card ───────────────────────────────────

function ChartCard({
  cfg, ctx,
  onRemove, onEdit,
  isDragOver, onDragStart, onDragEnter, onDragLeave, onDragOver: onDragOverProp, onDrop, onDragEnd,
  initialSize, onSizeChange, isMobile,
}: {
  cfg: ChartCfg; ctx: ChartContext;
  onRemove: () => void; onEdit: () => void;
  isDragOver: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  initialSize?: { width: number | "100%"; height: number };
  onSizeChange: (size: { width: number | "100%"; height: number }) => void;
  isMobile?: boolean;
}) {
  const yLabel = metricLabel(ctx, cfg.type, cfg.yAxis) ?? "?";
  const subtitle = cfg.type === "scatter"
    ? `Scatter · ${yLabel} vs ${metricLabel(ctx, "scatter", cfg.xAxis) ?? "?"}`
    : `Line · ${yLabel} · ${SCOPE_LABEL[cfg.scope ?? "event"]}`;

  // ── Resizable card via custom drag handle ────────────────────────────────
  const [size, setSize] = useState<{ width: number | "100%"; height: number }>(
    initialSize ?? { width: "100%", height: 360 }
  );
  // Track current size in a ref so onResizePointerUp can read it without
  // calling onSizeChange inside a setState updater (which triggers the
  // "update during render" React warning).
  const currentSizeRef = useRef(size);
  const resizeOrigin = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Allow HTML5 drag only when initiated from the grip handle
  const draggableRef = useRef(false);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    resizeOrigin.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizeOrigin.current) return;
    const dx = e.clientX - resizeOrigin.current.x;
    const dy = e.clientY - resizeOrigin.current.y;
    const next = { width: Math.max(280, resizeOrigin.current.w + dx), height: Math.max(240, resizeOrigin.current.h + dy) };
    currentSizeRef.current = next;
    setSize(next);
  }, []);

  // Save to parent on drag-end only.
  const onResizePointerUp = useCallback(() => {
    resizeOrigin.current = null;
    onSizeChange(currentSizeRef.current);
  }, [onSizeChange]);

  // On mobile: always fill container width, no horizontal resize
  const effectiveWidth = isMobile ? "100%" : size.width;

  return (
    <div
      ref={cardRef}
      draggable
      onDragStart={(e) => {
        if (!draggableRef.current) { e.preventDefault(); return; }
        onDragStart(e);
      }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOverProp}
      onDrop={onDrop}
      onDragEnd={() => { draggableRef.current = false; onDragEnd(); }}
      className="rounded-xl border bg-card flex flex-col transition-[border-color,box-shadow] duration-150"
      style={{
        width: effectiveWidth,
        height: size.height,
        minWidth: isMobile ? 0 : 280,
        minHeight: 240,
        position: "relative",
        overflow: "hidden",
        borderColor: isDragOver ? "var(--primary)" : "var(--border)",
        boxShadow: isDragOver ? "inset 3px 0 0 var(--primary)" : undefined,
      }}
    >
      {/* Header — grip on the left activates drag */}
      <div className="flex items-center gap-2 px-2 py-2.5 border-b border-border bg-muted/20 shrink-0">
        <div
          onMouseDown={() => { draggableRef.current = true; }}
          onMouseUp={() => { draggableRef.current = false; }}
          className="cursor-grab active:cursor-grabbing p-1 rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/60 transition-colors shrink-0"
          title="Drag to reorder"
        >
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="2" cy="3"  r="1.5" />
            <circle cx="8" cy="3"  r="1.5" />
            <circle cx="2" cy="8"  r="1.5" />
            <circle cx="8" cy="8"  r="1.5" />
            <circle cx="2" cy="13" r="1.5" />
            <circle cx="8" cy="13" r="1.5" />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{cfg.title}</p>
          <p className="text-[10px] text-muted-foreground truncate">
            {subtitle}
            {` · ${cfg.teams?.length ? `${cfg.teams.length} teams` : "All teams"}`}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onEdit} className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors">Edit</button>
          <button onClick={onRemove} aria-label="Remove chart" className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-destructive/10 transition-colors"><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {/* Chart area. `color` here is what every `currentColor` in the chart
          chrome resolves against, which keeps axes legible in both themes. */}
      <div className="flex-1 min-h-0 p-2 text-foreground" style={{ minHeight: 180 }}>
        <div style={{ width: "100%", height: "100%", minHeight: 180 }}>
          {cfg.type === "scatter" ? <ScatterView cfg={cfg} ctx={ctx} /> : <LineView cfg={cfg} ctx={ctx} />}
        </div>
      </div>

      {/* Resize handle — bottom-right on desktop, bottom-center on mobile (height only) */}
      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        style={{
          position: "absolute",
          bottom: 0,
          ...(isMobile
            ? { left: 0, right: 0, height: 20, cursor: "ns-resize", justifyContent: "center" }
            : { right: 0, width: 18, height: 18, cursor: "nwse-resize", justifyContent: "flex-end" }
          ),
          display: "flex", alignItems: "flex-end",
          padding: 3, zIndex: 10, touchAction: "none",
        }}
        title="Drag to resize"
      >
        {isMobile ? (
          <svg width="32" height="4" viewBox="0 0 32 4" fill="none" className="mb-1">
            <rect x="0" y="1" width="32" height="2" rx="1" fill="currentColor" className="text-muted-foreground/40" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="10" cy="10" r="1.5" fill="currentColor" className="text-muted-foreground/60" />
            <circle cx="6"  cy="10" r="1.5" fill="currentColor" className="text-muted-foreground/40" />
            <circle cx="10" cy="6"  r="1.5" fill="currentColor" className="text-muted-foreground/40" />
            <circle cx="2"  cy="10" r="1.5" fill="currentColor" className="text-muted-foreground/20" />
            <circle cx="10" cy="2"  r="1.5" fill="currentColor" className="text-muted-foreground/20" />
          </svg>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────── Builder panel ────────────────────────────────

/**
 * Axis picker. Defined at module scope on purpose — defined inside the
 * builder, every parent render produced a new component type and React
 * remounted the select, dropping focus mid-interaction.
 */
function AxisSelect({ id, value, onChange, metrics }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  metrics: ChartMetric[];
}) {
  const groups = useMemo(() => {
    const g = new Map<string, ChartMetric[]>();
    for (const m of metrics) g.set(m.group, [...(g.get(m.group) ?? []), m]);
    return [...g];
  }, [metrics]);

  return (
    <Select value={value} onValueChange={(v) => { if (v !== null) onChange(v); }}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue>{(v: string | null) => (v ? metrics.find((m) => m.id === v)?.label ?? "Pick a column" : "")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {groups.map(([g, opts]) => (
          <SelectGroup key={g}>
            <SelectLabel>{g}</SelectLabel>
            {opts.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Two-option toggle used for "All / Specific teams" and "This event / Season". */
function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/30 p-1">
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
            value === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
          }`}>
          {text}
        </button>
      ))}
    </div>
  );
}

const SECTION = "text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block";

function defaultAxis(metrics: ChartMetric[], preferred: string[]): string {
  return preferred.find((id) => metrics.some((m) => m.id === id)) ?? metrics[0]?.id ?? "";
}

function Builder({ metrics, allTeams, initial, onSave, onCancel }: {
  metrics: Record<ChartType, ChartMetric[]>;
  allTeams: number[];
  initial?: ChartCfg;
  onSave: (c: ChartCfg) => void;
  onCancel: () => void;
}) {
  const [type, setType]   = useState<ChartType>(initial?.type ?? "scatter");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [xAxis, setXAxis] = useState(initial?.xAxis ?? "");
  const [yAxis, setYAxis] = useState(initial?.yAxis ?? "");
  const [scope, setScope] = useState<LineScope>(initial?.scope ?? "event");
  const [teamMode, setTeamMode] = useState<"all" | "pick">(initial?.teams?.length ? "pick" : "all");
  const [selTeams, setSelTeams] = useState<number[]>(initial?.teams ?? []);

  const opts = metrics[type];
  const valid = (id: string) => opts.some((m) => m.id === id);
  // Keep the pick when switching chart type if the other type offers it too.
  const x = valid(xAxis) ? xAxis : defaultAxis(opts, ["epaEvent"]);
  const y = valid(yAxis) ? yAxis : defaultAxis(opts, type === "line" ? ["epaEvent"] : ["avgScore"]);
  const canSave = !!y && (type === "line" || !!x) && (teamMode === "all" || selTeams.length > 0);

  function save() {
    if (!canSave) return;
    const yLabel = opts.find((m) => m.id === y)?.label ?? y;
    const autoTitle = type === "scatter"
      ? `${yLabel} vs ${opts.find((m) => m.id === x)?.label ?? x}`
      : `${yLabel} by match`;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      title: title.trim() || autoTitle,
      type,
      xAxis: type === "scatter" ? x : "",
      yAxis: y,
      teams: teamMode === "pick" ? [...selTeams].sort((a, b) => a - b) : [],
      ...(type === "line" ? { scope } : {}),
    });
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <p className={SECTION}>Chart Type</p>
        <div className="grid grid-cols-2 gap-2">
          {CHART_DEFS.map(({ type: t, label, icon: Icon, desc }) => (
            <button key={t} type="button" onClick={() => setType(t)} aria-pressed={type === t}
              className={`flex flex-col items-center gap-1 p-3 rounded-lg border text-xs transition-all ${
                type === t ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted/50"
              }`}>
              <Icon className="h-5 w-5" />
              <span className="font-medium">{label}</span>
              <span className="text-[9px] text-center leading-tight opacity-70">{desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className={SECTION} htmlFor="cv-title">Title</label>
        <input id="cv-title" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="Auto-generated if empty"
          className="w-full rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
      </div>

      <div className="flex flex-col gap-3">
        {type === "scatter" ? (
          <div>
            <label className={SECTION} htmlFor="cv-x">X Axis</label>
            <AxisSelect id="cv-x" value={x} onChange={setXAxis} metrics={opts} />
          </div>
        ) : (
          <div>
            <p className={SECTION}>X Axis · Matches from</p>
            <Segmented label="Matches from" value={scope} onChange={setScope}
              options={[["event", SCOPE_LABEL.event], ["season", SCOPE_LABEL.season]]} />
          </div>
        )}
        <div>
          <label className={SECTION} htmlFor="cv-y">Y Axis</label>
          <AxisSelect id="cv-y" value={y} onChange={setYAxis} metrics={opts} />
        </div>
      </div>

      <div>
        <p className={SECTION}>Teams</p>
        <Segmented label="Teams" value={teamMode} onChange={setTeamMode}
          options={[["all", `All teams (${allTeams.length})`], ["pick", "Specific teams"]]} />
        {teamMode === "pick" && (
          <div className="mt-2 rounded-lg border border-border bg-muted/20 p-2">
            <div className="flex items-center justify-between mb-2 text-xs">
              <span className="text-muted-foreground">{selTeams.length} selected</span>
              {selTeams.length > 0 && (
                <button type="button" onClick={() => setSelTeams([])} className="text-primary hover:underline">Clear</button>
              )}
            </div>
            <div className="grid grid-cols-4 gap-1.5 max-h-48 overflow-y-auto">
              {allTeams.map((t) => {
                const selected = selTeams.includes(t);
                return (
                  <button key={t} type="button" aria-pressed={selected}
                    onClick={() => setSelTeams((p) => (p.includes(t) ? p.filter((v) => v !== t) : [...p, t]))}
                    className={`text-xs py-1.5 rounded-md border font-mono transition-colors ${
                      selected
                        ? "bg-primary text-primary-foreground border-primary"
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
        <Button onClick={save} disabled={!canSave} className="flex-1" size="sm">{initial?.id ? "Update" : "Add Chart"}</Button>
        <Button onClick={onCancel} variant="outline" size="sm">Cancel</Button>
      </div>
    </div>
  );
}

// ─────────────────────────────── Season data ──────────────────────────────────

const SEASON_FETCH_CONCURRENCY = 6;

/** Whole-season Statbotics matches for the teams season-scope line charts
 *  show, fetched lazily and a few teams at a time. */
function useSeasonData(teams: number[], year: number) {
  const [season, setSeason] = useState<ChartContext["season"]>({});
  const [loading, setLoading] = useState(false);
  const fetched = useRef(new Set<string>());
  const key = teams.join(",");

  useEffect(() => {
    const todo = teams.filter((t) => !fetched.current.has(`${t}_${year}`));
    if (!todo.length) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      for (let i = 0; i < todo.length; i += SEASON_FETCH_CONCURRENCY) {
        const batch = todo.slice(i, i + SEASON_FETCH_CONCURRENCY);
        const results = await Promise.all(batch.map((t) => fetchStatboticsTeamSeason(t, year)));
        if (cancelled) return;
        batch.forEach((t) => fetched.current.add(`${t}_${year}`));
        setSeason((prev) => {
          const next = { ...prev };
          batch.forEach((t, j) => { next[t] = results[j]; });
          return next;
        });
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; setLoading(false); };
    // `key` stands in for `teams` (a fresh array each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, year]);

  return { season, loading };
}

// ─────────────────────────────── Page ─────────────────────────────────────────

const KNOWN_TYPES = new Set<ChartType>(["scatter", "line"]);

export default function DataViewerPage() {
  const currentEvent = useCurrentEvent();
  const eventKey = currentEvent?.eventKey ?? "";

  const data = useEventTeamData(eventKey);

  // Persist charts to localStorage keyed by event. eventKey may resolve
  // asynchronously from a Convex query, so re-load whenever the key changes.
  const [charts, setCharts] = useState<ChartCfg[]>([]);
  const loadedKeyRef = useRef<string | null>(null);

  // Card sizes — persisted separately so layout survives page reloads
  type CardSizes = Record<string, { width: number | "100%"; height: number }>;
  const [cardSizes, setCardSizesRaw] = useState<CardSizes>({});

  useEffect(() => {
    const key = `falconscout_charts_${eventKey || "__global__"}`;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    try {
      const raw = localStorage.getItem(key);
      // Bar and box-plot charts were retired; drop any saved ones.
      if (raw) setCharts((JSON.parse(raw) as ChartCfg[]).filter((c) => KNOWN_TYPES.has(c.type)));
    } catch { /* corrupted storage — start fresh */ }
    try {
      const rawSizes = localStorage.getItem(`${key}_sizes`);
      if (rawSizes) setCardSizesRaw(JSON.parse(rawSizes) as CardSizes);
    } catch { /* ignore */ }
  }, [eventKey]);

  useEffect(() => {
    if (!loadedKeyRef.current) return;
    try { localStorage.setItem(loadedKeyRef.current, JSON.stringify(charts)); }
    catch { /* storage quota exceeded */ }
  }, [charts]);

  useEffect(() => {
    if (!loadedKeyRef.current) return;
    try { localStorage.setItem(`${loadedKeyRef.current}_sizes`, JSON.stringify(cardSizes)); }
    catch { /* storage quota exceeded */ }
  }, [cardSizes]);

  function setCardSizes(id: string, size: { width: number | "100%"; height: number }) {
    setCardSizesRaw((prev) => ({ ...prev, [id]: size }));
  }

  const [building, setBuilding]   = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // ── Drag-to-reorder state ──────────────────────────────────────────────
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  function handleDragStart(id: string, e: React.DragEvent) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    setDragId(id);
  }

  function handleDragEnter(id: string, e: React.DragEvent) {
    e.preventDefault();
    if (id !== dragId) setDropId(id);
  }

  function handleDragLeave(id: string, e: React.DragEvent) {
    // Only clear if the pointer truly left this card (not just entered a child)
    const rel = e.relatedTarget as Node | null;
    if (rel && (e.currentTarget as HTMLElement).contains(rel)) return;
    if (dropId === id) setDropId(null);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function handleDrop(targetId: string, e: React.DragEvent) {
    e.preventDefault();
    const srcId = e.dataTransfer.getData("text/plain") || dragId;
    if (!srcId || srcId === targetId) { setDragId(null); setDropId(null); return; }
    setCharts((prev) => {
      const next = [...prev];
      const fromIdx = next.findIndex((c) => c.id === srcId);
      const toIdx   = next.findIndex((c) => c.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
    setDragId(null);
    setDropId(null);
  }

  function handleDragEnd() {
    setDragId(null);
    setDropId(null);
  }

  // ── Chart data ─────────────────────────────────────────────────────────
  const allTeams = useMemo(() => {
    const roster = data.tbaTeams.length
      ? data.tbaTeams
      : Object.keys(data.submissionsByTeam).map(Number);
    return [...roster].sort((a, b) => a - b);
  }, [data.tbaTeams, data.submissionsByTeam]);

  const [eventTeamMatches, setEventTeamMatches] = useState<SlimTeamMatch[]>([]);
  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    fetchStatboticsEventTeamMatches(eventKey).then((rows) => {
      if (!cancelled) setEventTeamMatches(rows ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [eventKey]);

  const seasonTeams = useMemo(() => {
    const s = new Set<number>();
    for (const c of charts) {
      if (c.type !== "line" || c.scope !== "season") continue;
      for (const t of c.teams?.length ? c.teams : allTeams) s.add(t);
    }
    return [...s].sort((a, b) => a - b);
  }, [charts, allTeams]);
  const { season, loading: seasonLoading } = useSeasonData(seasonTeams, data.eventYear);

  const eventMatches = useMemo(() => data.matchData.map(slimTbaMatch), [data.matchData]);
  const metrics = useMemo(() => ({
    scatter: chartMetrics("scatter", data.fieldColumns),
    line: chartMetrics("line", data.fieldColumns),
  }), [data.fieldColumns]);

  const { tbaRankings, avgScoreByTeam, epaMap, submissionsByTeam, fieldCellsByTeam } = data;
  const statsFor = useCallback((team: number): TeamStats => ({
    rank: (tbaRankings[team] as { rank?: number } | undefined)?.rank ?? null,
    avgScore: avgScoreByTeam[team] ?? null,
    epa: epaMap[team] ?? EMPTY_TEAM_EPA,
    reportCount: submissionsByTeam[team]?.length ?? 0,
    fieldCells: fieldCellsByTeam[team] ?? {},
  }), [tbaRankings, avgScoreByTeam, epaMap, submissionsByTeam, fieldCellsByTeam]);

  const ctx = useMemo<ChartContext>(() => ({
    eventKey,
    allTeams,
    metrics,
    statsFor,
    fieldColumns: data.fieldColumns,
    submissions: data.allSubmissions ?? [],
    eventMatches,
    eventTeamMatches,
    season,
    seasonLoading,
  }), [eventKey, allTeams, metrics, statsFor, data.fieldColumns, data.allSubmissions,
       eventMatches, eventTeamMatches, season, seasonLoading]);

  const reportCount = useMemo(
    () => Object.values(data.submissionsByTeam).reduce((n, l) => n + l.length, 0),
    [data.submissionsByTeam]);

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

  const isMobile = useIsMobile();
  const builderOpen = building || editingId !== null;
  const closeBuilder = () => { setBuilding(false); setEditingId(null); };

  if (!eventKey) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground">
        <BarChart2 className="h-10 w-10 opacity-20" />
        <p className="text-sm">No event selected. Set one in Settings.</p>
      </div>
    );
  }

  const builder = (
    <Builder
      key={editingId ?? "new"}
      metrics={metrics}
      allTeams={allTeams}
      initial={editingCfg}
      onSave={upsert}
      onCancel={closeBuilder}
    />
  );

  return (
    <div className="h-full flex flex-col gap-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Data Viewer</h2>
          <p className="text-muted-foreground text-sm truncate">
            {currentEvent?.eventName ?? eventKey} · {reportCount} reports · {allTeams.length} teams
          </p>
        </div>
        <Button
          onClick={() => { setBuilding(true); setEditingId(null); }}
          className="gap-2 shrink-0"
          size={isMobile ? "sm" : "default"}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New Chart</span>
          <span className="sm:hidden">New</span>
        </Button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex gap-4 min-h-0 relative">

        {/* ── Desktop sidebar ── */}
        {!isMobile && builderOpen && (
          <div className="w-72 shrink-0 rounded-xl border border-border bg-card flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-muted/20 shrink-0 flex items-center justify-between">
              <p className="text-sm font-semibold">{editingId ? "Edit Chart" : "New Chart"}</p>
              <button onClick={closeBuilder} aria-label="Close"
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
            <ScrollArea className="flex-1">{builder}</ScrollArea>
          </div>
        )}

        {/* ── Canvas ── */}
        <div className="flex-1 min-w-0 min-h-0">
          {charts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground rounded-xl border-2 border-dashed border-border px-4">
              <BarChart2 className="h-12 w-12 opacity-20" />
              <div className="text-center">
                <p className="font-medium">No charts yet</p>
                <p className="text-sm opacity-70">Tap "New" to visualize your scouting data</p>
              </div>
              <Button variant="outline" onClick={() => setBuilding(true)} className="gap-2">
                <Plus className="h-4 w-4" />Create Chart
              </Button>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="flex flex-wrap gap-3 sm:gap-4 pb-4 items-start">
                {charts.map((c) => (
                  <ChartCard
                    key={c.id} cfg={c} ctx={ctx}
                    onRemove={() => setCharts((p) => p.filter((x) => x.id !== c.id))}
                    onEdit={() => { setEditingId(c.id); setBuilding(false); }}
                    isDragOver={dropId === c.id}
                    onDragStart={(e) => handleDragStart(c.id, e)}
                    onDragEnter={(e) => handleDragEnter(c.id, e)}
                    onDragLeave={(e) => handleDragLeave(c.id, e)}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(c.id, e)}
                    onDragEnd={handleDragEnd}
                    initialSize={cardSizes[c.id]}
                    onSizeChange={(size) => setCardSizes(c.id, size)}
                    isMobile={isMobile}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>

      {/* ── Mobile bottom-sheet builder ── */}
      {isMobile && builderOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={closeBuilder} />
          <div
            className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl border-t border-border bg-card flex flex-col"
            style={{ maxHeight: "85dvh" }}
          >
            <div className="flex justify-center pt-2.5 pb-1 shrink-0">
              <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
            </div>
            <div className="px-4 py-2.5 border-b border-border bg-muted/20 shrink-0 flex items-center justify-between">
              <p className="text-sm font-semibold">{editingId ? "Edit Chart" : "New Chart"}</p>
              <button onClick={closeBuilder} aria-label="Close"
                className="text-muted-foreground hover:text-foreground p-1.5 rounded hover:bg-muted transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
            <ScrollArea className="flex-1">{builder}</ScrollArea>
          </div>
        </>
      )}
    </div>
  );
}
