import React, { useState, useEffect, useMemo } from "react";
import {
  fetchTBATeamInfo,
  fetchTBATeamAvatar,
  fetchTBAEventMatches,
} from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import {
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  X,
  ExternalLink,
  TrendingUp,
  BarChart2,
  ClipboardList,
  ChevronDown,
  ChevronUp,
  Activity,
  Search,
  CheckCircle2,
  XCircle,
  Star,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FormField {
  id: string;
  type: "text" | "number" | "checkbox" | "select" | "counter" | "textarea" | "teamNumber" | "rating";
  label: string;
  required: boolean;
  options?: string[];
  section?: string;
}

interface Submission {
  _id: string;
  templateId: string;
  teamNumber: number;
  matchNumber: number;
  scoutId?: string;
  syncedAt?: number;
  data: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseData(s: Submission): Record<string, unknown> {
  try { return JSON.parse(s.data) as Record<string, unknown>; } catch { return {}; }
}

function getNumericVals(submissions: Submission[], fieldId: string): number[] {
  return submissions
    .map((s) => parseData(s)[fieldId])
    .filter((v): v is number => typeof v === "number");
}

function avg(vals: number[]): number | null {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Compute box-plot statistics */
function boxStats(vals: number[]) {
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const n = sorted.length;
  const medianOf = (arr: number[]) =>
    arr.length % 2 === 0
      ? (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2
      : arr[Math.floor(arr.length / 2)];
  const median = medianOf(sorted);
  const lower = sorted.slice(0, Math.floor(n / 2));
  const upper = sorted.slice(Math.ceil(n / 2));
  return {
    min: sorted[0],
    q1: lower.length ? medianOf(lower) : median,
    median,
    q3: upper.length ? medianOf(upper) : median,
    max: sorted[n - 1],
    mean: vals.reduce((a, b) => a + b, 0) / n,
    n,
  };
}

// ── Stat toggle chips ──────────────────────────────────────────────────────────

function StatToggle({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-all ${
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border text-muted-foreground hover:border-primary/50"
      }`}
      style={active && color ? { borderColor: color, color, backgroundColor: color + "22" } : {}}
    >
      {label}
    </button>
  );
}

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function ChartTip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color?: string }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border border-border rounded-lg px-3 py-2 text-xs shadow-xl">
      {label !== undefined && <p className="text-muted-foreground mb-1 font-mono">Match {label}</p>}
      {payload.map((p, i) => (
        <p key={i} className="font-semibold" style={{ color: p.color ?? "inherit" }}>
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}
        </p>
      ))}
    </div>
  );
}

// ── CHART 1: Radar ─────────────────────────────────────────────────────────────

const RADAR_COLORS = [
  "hsl(var(--primary))",
  "#60a5fa", "#34d399", "#f97316", "#c084fc", "#f43f5e",
];

const YELLOW = "#eab308";

function RadarStatsChart({
  fields,
  submissions,
}: {
  fields: FormField[];
  submissions: Submission[];
}) {
  const numericFields = fields.filter((f) =>
    ["number", "counter", "rating"].includes(f.type)
  );
  const checkboxFields = fields.filter((f) => f.type === "checkbox");
  const allFields = [...numericFields, ...checkboxFields];

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(allFields.slice(0, 6).map((f) => f.id))
  );

  function toggle(id: string) {
    setSelected((prev) => {
      // Enforce minimum 3 selected
      if (prev.has(id) && prev.size <= 3) return prev;
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const activeFields = allFields.filter((f) => selected.has(f.id));

  // Build radar data: one entry per field, value = avg
  const radarData = useMemo(() => {
    return activeFields.map((f) => {
      let raw: number | null;
      if (f.type === "checkbox") {
        const vals = submissions.map((s) => parseData(s)[f.id]);
        const filled = vals.filter((v) => v !== undefined);
        raw = filled.length ? (filled.filter(Boolean).length / filled.length) * 100 : null;
      } else {
        const vals = getNumericVals(submissions, f.id);
        raw = avg(vals);
      }
      return { subject: f.label, value: raw ?? 0, fullMark: 100, rawVal: raw };
    });
  }, [activeFields, submissions]);

  // Normalize non-checkbox fields: scale so max across active fields = 100
  const maxVal = useMemo(() => {
    const nonBool = activeFields
      .filter((f) => f.type !== "checkbox")
      .map((f) => avg(getNumericVals(submissions, f.id)) ?? 0);
    return Math.max(...nonBool, 1);
  }, [activeFields, submissions]);

  const normalizedData = radarData.map((d) => {
    const field = activeFields.find((f) => f.label === d.subject);
    const isCheckbox = field?.type === "checkbox";
    return {
      ...d,
      value: isCheckbox ? d.value : (d.value / maxVal) * 100,
    };
  });

  const hasData = submissions.length > 0 && activeFields.length > 0;

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Radar — Field Averages</h3>
        <span className="text-[10px] text-muted-foreground">min 3 fields · normalized</span>
      </div>

      {/* Field toggles */}
      <div className="flex flex-wrap gap-1.5">
        {allFields.map((f) => {
          const isActive = selected.has(f.id);
          const wouldUnderflow = isActive && selected.size <= 3;
          return (
            <StatToggle
              key={f.id}
              label={f.label}
              active={isActive}
              color={isActive ? YELLOW : undefined}
              onClick={() => !wouldUnderflow && toggle(f.id)}
            />
          );
        })}
      </div>

      {!hasData || activeFields.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
          {submissions.length === 0 ? "No data yet" : "Select at least 3 fields"}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <RadarChart data={normalizedData} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
            <PolarGrid stroke="rgba(255,255,255,0.1)" />
            <PolarAngleAxis
              dataKey="subject"
              tick={{ fontSize: 11, fill: "rgba(255,255,255,0.55)" }}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as { subject: string; rawVal: number | null };
                return (
                  <div className="bg-popover border border-border rounded-lg px-3 py-2 text-xs shadow-xl">
                    <p className="font-semibold text-foreground">{d.subject}</p>
                    <p className="text-muted-foreground">
                      avg: {d.rawVal !== null ? d.rawVal.toFixed(2) : "—"}
                    </p>
                  </div>
                );
              }}
            />
            <Radar
              name="Average"
              dataKey="value"
              stroke={YELLOW}
              fill={YELLOW}
              fillOpacity={0.25}
              strokeWidth={2}
              dot={{ r: 3, fill: YELLOW }}
            />
          </RadarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── CHART 2: Line — Performance over Matches ───────────────────────────────────

const LINE_COLORS = [
  "hsl(var(--primary))",
  "#60a5fa", "#34d399", "#f97316", "#c084fc", "#f43f5e", "#fbbf24",
];

function MatchTrendChart({
  fields,
  submissions,
  eventKey,
  teamNumber,
}: {
  fields: FormField[];
  submissions: Submission[];
  eventKey: string;
  teamNumber: number;
}) {
  const numericFields = fields.filter((f) =>
    ["number", "counter", "rating"].includes(f.type)
  );

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(numericFields.slice(0, 3).map((f) => f.id))
  );

  // TBA match score overlay
  const [matchScores, setMatchScores] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!eventKey) return;
    fetchTBAEventMatches(eventKey).then((data) => {
      if (!Array.isArray(data)) return;
      const scores: Record<number, number> = {};
      for (const m of data as TBAMatch[]) {
        const key = `frc${teamNumber}`;
        const redTeams = m.alliances.red.team_keys;
        const blueTeams = m.alliances.blue.team_keys;
        if (!redTeams.includes(key) && !blueTeams.includes(key)) continue;
        const side = redTeams.includes(key) ? "red" : "blue";
        const score = m.alliances[side].score;
        if (score >= 0) scores[m.match_number] = score;
      }
      setMatchScores(scores);
    }).catch(() => {});
  }, [eventKey, teamNumber]);

  const sorted = [...submissions].sort((a, b) => a.matchNumber - b.matchNumber);

  const data = sorted.map((s) => {
    const d = parseData(s);
    const row: Record<string, number | undefined> = { match: s.matchNumber };
    for (const f of numericFields) {
      const v = d[f.id];
      if (typeof v === "number") row[f.id] = v;
    }
    if (matchScores[s.matchNumber] !== undefined) {
      row["__tbaScore"] = matchScores[s.matchNumber];
    }
    return row;
  });

  // Add matches with TBA scores but no submission
  for (const [matchNum, score] of Object.entries(matchScores)) {
    const mn = Number(matchNum);
    if (!data.find((d) => d.match === mn)) {
      data.push({ match: mn, __tbaScore: score });
    }
  }
  data.sort((a, b) => (a.match ?? 0) - (b.match ?? 0));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const hasTBA = Object.keys(matchScores).length > 0;
  const [showTBA, setShowTBA] = useState(true);

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Performance Over Matches</h3>
        <span className="text-[10px] text-muted-foreground">by match number</span>
      </div>

      {/* Toggles */}
      <div className="flex flex-wrap gap-1.5">
        {hasTBA && (
          <StatToggle
            label="TBA Score"
            active={showTBA}
            color="#94a3b8"
            onClick={() => setShowTBA((v) => !v)}
          />
        )}
        {numericFields.map((f, i) => (
          <StatToggle
            key={f.id}
            label={f.label}
            active={selected.has(f.id)}
            color={LINE_COLORS[(i + 1) % LINE_COLORS.length]}
            onClick={() => toggle(f.id)}
          />
        ))}
      </div>

      {data.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
          No data yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="match"
              tick={{ fontSize: 10 }}
              stroke="rgba(255,255,255,0.15)"
              label={{ value: "Match #", position: "insideBottomRight", offset: -4, fontSize: 10, fill: "rgba(255,255,255,0.4)" }}
            />
            <YAxis tick={{ fontSize: 10 }} stroke="rgba(255,255,255,0.15)" />
            <Tooltip content={<ChartTip />} />
            <Legend wrapperStyle={{ fontSize: 11 }} />

            {/* TBA match score */}
            {hasTBA && showTBA && (
              <Line
                type="monotone"
                dataKey="__tbaScore"
                name="TBA Score"
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                connectNulls={false}
              />
            )}

            {/* Scouted fields */}
            {numericFields
              .filter((f) => selected.has(f.id))
              .map((f, i) => (
                <Line
                  key={f.id}
                  type="monotone"
                  dataKey={f.id}
                  name={f.label}
                  stroke={LINE_COLORS[(i + 1) % LINE_COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls={false}
                />
              ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── CHART 3: Box Plot ─────────────────────────────────────────────────────────

interface BoxData {
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  n: number;
}

function BoxPlotSVG({ boxes }: { boxes: BoxData[] }) {
  if (!boxes.length) return null;

  const PAD_T = 24, PAD_B = 46, PAD_L = 38, PAD_R = 100; // PAD_R leaves room for legend
  const HEIGHT = 240;
  const COL_W = 80;
  const WIDTH = PAD_L + PAD_R + COL_W * boxes.length;
  const PLOT_H = HEIGHT - PAD_T - PAD_B;

  // Y scale (use unique names to avoid any shadowing confusion)
  const allVals = boxes.flatMap((b) => [b.min, b.max]);
  const scaleMin = Math.min(0, ...allVals);
  const scaleMax = Math.max(...allVals, 1);
  const scaleRange = scaleMax - scaleMin || 1;

  const toY = (v: number) =>
    PAD_T + PLOT_H - ((v - scaleMin) / scaleRange) * PLOT_H;

  const gridVals = Array.from({ length: 6 }, (_, i) =>
    scaleMin + (scaleRange * i) / 5
  );

  return (
    <svg
      width="100%"
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMinYMid meet"
    >
      {/* Grid lines */}
      {gridVals.map((v, i) => (
        <g key={i}>
          <line
            x1={PAD_L} y1={toY(v)} x2={WIDTH - PAD_R} y2={toY(v)}
            stroke="rgba(255,255,255,0.07)" strokeWidth={1}
          />
          <text
            x={PAD_L - 5} y={toY(v)}
            textAnchor="end" dominantBaseline="middle"
            fontSize={9} fill="rgba(255,255,255,0.4)"
          >
            {Number.isInteger(v) ? v : v.toFixed(1)}
          </text>
        </g>
      ))}

      {/* Per-field boxes */}
      {boxes.map((b, i) => {
        const cx = PAD_L + COL_W * i + COL_W / 2;
        const BOX_W = 32;
        const CAP_W = BOX_W * 0.45;

        // Compute SVG y positions with unique variable names
        const svgYMax  = toY(b.max);
        const svgYQ3   = toY(b.q3);
        const svgYMed  = toY(b.median);
        const svgYQ1   = toY(b.q1);
        const svgYMin  = toY(b.min);
        const svgYMean = toY(b.mean);

        // IQR box: top = Q3 (small y), height = Q1 - Q3 (must be >= 2)
        const boxTop = svgYQ3;
        const boxH   = Math.max(svgYQ1 - svgYQ3, 2);

        return (
          <g key={b.label}>
            {/* Top whisker stem: from box top (Q3) up to max */}
            <line
              x1={cx} y1={svgYMax}
              x2={cx} y2={svgYQ3}
              stroke={YELLOW} strokeWidth={1.5} strokeDasharray="3 2"
            />
            {/* Top cap at max */}
            <line
              x1={cx - CAP_W} y1={svgYMax}
              x2={cx + CAP_W} y2={svgYMax}
              stroke={YELLOW} strokeWidth={2}
            />

            {/* Bottom whisker stem: from box bottom (Q1) down to min */}
            <line
              x1={cx} y1={svgYQ1}
              x2={cx} y2={svgYMin}
              stroke={YELLOW} strokeWidth={1.5} strokeDasharray="3 2"
            />
            {/* Bottom cap at min */}
            <line
              x1={cx - CAP_W} y1={svgYMin}
              x2={cx + CAP_W} y2={svgYMin}
              stroke={YELLOW} strokeWidth={2}
            />

            {/* IQR box */}
            <rect
              x={cx - BOX_W / 2} y={boxTop}
              width={BOX_W} height={boxH}
              fill="rgba(234,179,8,0.18)"
              stroke={YELLOW}
              strokeWidth={1.5}
              rx={3}
            />

            {/* Median line — white, inside box */}
            <line
              x1={cx - BOX_W / 2} y1={svgYMed}
              x2={cx + BOX_W / 2} y2={svgYMed}
              stroke="white" strokeWidth={2.5}
            />

            {/* Mean dot — orange */}
            <circle cx={cx} cy={svgYMean} r={3.5} fill="#f97316" />

            {/* Median value label above median line */}
            <text
              x={cx} y={svgYMed - 7}
              textAnchor="middle" fontSize={9}
              fill="white" fontWeight="bold"
            >
              {b.median % 1 === 0 ? b.median : b.median.toFixed(1)}
            </text>

            {/* Field name below the plot */}
            <text
              x={cx} y={HEIGHT - PAD_B + 14}
              textAnchor="middle" fontSize={10}
              fill="rgba(255,255,255,0.65)"
            >
              {b.label.length > 9 ? b.label.slice(0, 8) + "…" : b.label}
            </text>
            <text
              x={cx} y={HEIGHT - PAD_B + 26}
              textAnchor="middle" fontSize={8}
              fill="rgba(255,255,255,0.35)"
            >
              n={b.n}
            </text>
          </g>
        );
      })}

      {/* Legend — fixed to the right */}
      <g transform={`translate(${WIDTH - PAD_R + 8}, ${PAD_T})`}>
        <rect x={0} y={0} width={9} height={9} fill="rgba(234,179,8,0.18)" stroke={YELLOW} strokeWidth={1} rx={1} />
        <text x={13} y={8} fontSize={9} fill="rgba(255,255,255,0.5)">IQR (Q1–Q3)</text>
        <line x1={0} y1={20} x2={9} y2={20} stroke="white" strokeWidth={2.5} />
        <text x={13} y={24} fontSize={9} fill="rgba(255,255,255,0.5)">Median</text>
        <circle cx={4.5} cy={35} r={3.5} fill="#f97316" />
        <text x={13} y={38} fontSize={9} fill="rgba(255,255,255,0.5)">Mean</text>
      </g>
    </svg>
  );
}

function BoxPlotChart({ fields, submissions }: { fields: FormField[]; submissions: Submission[] }) {
  const numericFields = fields.filter((f) =>
    ["number", "counter", "rating"].includes(f.type)
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(numericFields.slice(0, 5).map((f) => f.id))
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const boxes: BoxData[] = useMemo(() => {
    return numericFields
      .filter((f) => selected.has(f.id))
      .map((f) => {
        const vals = getNumericVals(submissions, f.id);
        const stats = boxStats(vals);
        if (!stats) return null;
        return { label: f.label, ...stats };
      })
      .filter((b): b is BoxData => b !== null);
  }, [selected, submissions, numericFields]);

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Box Plot — Distribution</h3>
        <span className="text-[10px] text-muted-foreground">
          white line = median · orange dot = mean
        </span>
      </div>

      {/* Field toggles */}
      <div className="flex flex-wrap gap-1.5">
        {numericFields.map((f) => (
          <StatToggle
            key={f.id}
            label={f.label}
            active={selected.has(f.id)}
            onClick={() => toggle(f.id)}
          />
        ))}
      </div>

      {submissions.length === 0 || boxes.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
          {submissions.length === 0 ? "No data yet" : "Select at least one field"}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div style={{ minWidth: Math.max(300, boxes.length * 80) }}>
            <BoxPlotSVG boxes={boxes} />
          </div>
        </div>
      )}

      {/* Stats table */}
      {boxes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] text-muted-foreground">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-1 pr-2 font-semibold">Field</th>
                <th className="text-right py-1 px-1">n</th>
                <th className="text-right py-1 px-1">Min</th>
                <th className="text-right py-1 px-1">Q1</th>
                <th className="text-right py-1 px-1 text-white">Med</th>
                <th className="text-right py-1 px-1">Q3</th>
                <th className="text-right py-1 px-1">Max</th>
                <th className="text-right py-1 pl-1 text-orange-400">Mean</th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((b) => (
                <tr key={b.label} className="border-b border-border/30">
                  <td className="py-1 pr-2 font-medium truncate max-w-[100px]">{b.label}</td>
                  <td className="text-right px-1">{b.n}</td>
                  <td className="text-right px-1">{b.min % 1 === 0 ? b.min : b.min.toFixed(1)}</td>
                  <td className="text-right px-1">{b.q1 % 1 === 0 ? b.q1 : b.q1.toFixed(1)}</td>
                  <td className="text-right px-1 text-white font-bold">{b.median % 1 === 0 ? b.median : b.median.toFixed(1)}</td>
                  <td className="text-right px-1">{b.q3 % 1 === 0 ? b.q3 : b.q3.toFixed(1)}</td>
                  <td className="text-right px-1">{b.max % 1 === 0 ? b.max : b.max.toFixed(1)}</td>
                  <td className="text-right pl-1 text-orange-400 font-semibold">{b.mean.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Team avatar ───────────────────────────────────────────────────────────────

function TeamAvatar({ teamNumber, size = 40 }: { teamNumber: number; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    fetchTBATeamAvatar(teamNumber).then(setSrc).catch(() => setSrc(null));
  }, [teamNumber]);
  if (src) return (
    <img src={src} alt={`Team ${teamNumber}`}
      className="rounded-lg object-contain bg-muted"
      style={{ width: size, height: size }} />
  );
  return (
    <div className="rounded-lg bg-primary/10 flex items-center justify-center font-bold text-primary"
      style={{ width: size, height: size, fontSize: size * 0.3 }}>
      {teamNumber}
    </div>
  );
}

// ── Stat tile ─────────────────────────────────────────────────────────────────

function StatTile({ label, value, sub }: { label: string; value: string | null; sub?: string }) {
  return (
    <div className="bg-muted/30 border border-border rounded-xl p-3 flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-xl font-bold font-mono">{value ?? "—"}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ── Raw report row ────────────────────────────────────────────────────────────

function ReportRow({ sub, fields }: { sub: Submission; fields: FormField[] }) {
  const [open, setOpen] = useState(false);
  const data = parseData(sub);
  const date = sub.syncedAt
    ? new Date(sub.syncedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  const numericFields = fields.filter((f) => ["number", "counter", "rating"].includes(f.type));
  const textFields = fields.filter((f) => ["text", "textarea"].includes(f.type));
  const checkboxFields = fields.filter((f) => f.type === "checkbox");
  const selectFields = fields.filter((f) => f.type === "select");

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 bg-muted/20 hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-bold text-sm">Match {sub.matchNumber}</span>
        {date && <span className="text-[10px] text-muted-foreground">{date}</span>}
        <div className="flex-1 flex gap-2 flex-wrap">
          {numericFields.slice(0, 4).map((f) => {
            const v = data[f.id];
            if (typeof v !== "number") return null;
            return (
              <span key={f.id} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono">
                {f.label}: {v}
              </span>
            );
          })}
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>
      {open && (
        <div className="px-4 py-3 space-y-3 bg-background/50">
          {numericFields.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Numeric</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {numericFields.map((f) => (
                  <div key={f.id} className="text-xs">
                    <span className="text-muted-foreground">{f.label}: </span>
                    <span className="font-semibold font-mono">{String(data[f.id] ?? "—")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {checkboxFields.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Checkboxes</p>
              <div className="flex flex-wrap gap-2">
                {checkboxFields.map((f) => {
                  const checked = data[f.id] === true || data[f.id] === "true";
                  return (
                    <span key={f.id} className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${checked ? "border-green-500/50 text-green-400 bg-green-500/10" : "border-border text-muted-foreground"}`}>
                      {checked ? "✓" : "✗"} {f.label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          {selectFields.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Selections</p>
              <div className="flex flex-wrap gap-2">
                {selectFields.map((f) => (
                  <span key={f.id} className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground">
                    {f.label}: <strong className="text-foreground">{String(data[f.id] ?? "—")}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
          {textFields.map((f) => {
            const val = String(data[f.id] ?? "").trim();
            if (!val) return null;
            return (
              <div key={f.id}>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">{f.label}</p>
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{val}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Team Detail Panel ─────────────────────────────────────────────────────────

export interface TeamDetailProps {
  teamNumber: number;
  eventKey: string;
  eventYear: number;
  submissions: Submission[];
  fields: FormField[];
  epa: { event: number | null; overall: number | null; auto: number | null; teleop: number | null; endgame: number | null };
  avgScore: number | null;
  tbaRank: Record<string, unknown> | null;
  pitSubmissions: Submission[];
  pitFields: FormField[];
  onClose: () => void;
}

export default function TeamDetailPanel({
  teamNumber,
  eventKey,
  eventYear,
  submissions,
  fields,
  epa,
  avgScore,
  tbaRank,
  pitSubmissions,
  pitFields,
  onClose,
}: TeamDetailProps) {
  const [teamInfo, setTeamInfo] = useState<{ nickname?: string; city?: string } | null>(null);
  const [tab, setTab] = useState("overview");

  useEffect(() => {
    fetchTBATeamInfo(teamNumber).then((d) => {
      if (d && typeof d === "object") setTeamInfo(d as { nickname?: string; city?: string });
    }).catch(() => {});
  }, [teamNumber]);

  const numericFields = fields.filter((f) => ["number", "counter", "rating"].includes(f.type));
  const checkboxFields = fields.filter((f) => f.type === "checkbox");
  const parsed = submissions.map(parseData);
  function fieldAvg(id: string) {
    const vals = parsed.map((d) => d[id]).filter((v): v is number => typeof v === "number");
    return avg(vals);
  }
  const rank = tbaRank ? (tbaRank as { rank?: number }).rank ?? null : null;
  const record = tbaRank ? (tbaRank as { record?: { wins: number; losses: number; ties: number } }).record ?? null : null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-2xl bg-background border-l border-border flex flex-col h-full overflow-hidden shadow-2xl animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="flex items-center gap-4 px-5 py-4 border-b border-border shrink-0">
          <TeamAvatar teamNumber={teamNumber} size={48} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-xl font-bold">Team {teamNumber}</h2>
              {rank && <span className="text-sm text-muted-foreground font-mono">#{rank}</span>}
            </div>
            {teamInfo?.nickname && <p className="text-sm text-muted-foreground truncate">{teamInfo.nickname}</p>}
            {teamInfo?.city && <p className="text-xs text-muted-foreground">{teamInfo.city}</p>}
            {record && <p className="text-xs font-mono text-muted-foreground">{record.wins}-{record.losses}-{record.ties}</p>}
          </div>
          <div className="flex items-center gap-1">
            <a href={`https://www.statbotics.io/team/${teamNumber}`} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground hover:text-primary hover:bg-muted transition-colors" title="Statbotics">
              <ExternalLink className="h-4 w-4" />
            </a>
            <a href={`https://www.thebluealliance.com/team/${teamNumber}`} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground hover:text-primary hover:bg-muted transition-colors" title="TBA">
              <ExternalLink className="h-4 w-4" />
            </a>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-5 mt-3 shrink-0 w-fit">
            <TabsTrigger value="overview" className="gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="charts" className="gap-1.5">
              <BarChart2 className="h-3.5 w-3.5" /> Charts
            </TabsTrigger>
            <TabsTrigger value="reports" className="gap-1.5">
              <ClipboardList className="h-3.5 w-3.5" /> Reports
            </TabsTrigger>
            {pitFields.length > 0 && (
              <TabsTrigger value="pit" className="gap-1.5">
                <Search className="h-3.5 w-3.5" /> Pit Report
                {pitSubmissions.length > 0 && (
                  <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 font-bold">
                    {pitSubmissions.length}
                  </span>
                )}
              </TabsTrigger>
            )}
          </TabsList>

          {/* ── OVERVIEW ── */}
          <TabsContent value="overview" className="flex-1 min-h-0 mt-0">
            <ScrollArea className="h-full">
              <div className="px-5 py-4 space-y-5 pb-8">
                {(epa.event !== null || epa.overall !== null) && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">EPA (Statbotics)</p>
                    <div className="grid grid-cols-3 gap-2">
                      {epa.event !== null && <StatTile label="Event EPA" value={String(epa.event)} />}
                      {epa.overall !== null && <StatTile label="Season EPA" value={String(epa.overall)} />}
                      {avgScore !== null && <StatTile label="Avg TBA Score" value={String(avgScore)} />}
                      {epa.auto !== null && <StatTile label="Auto EPA" value={String(epa.auto)} />}
                      {epa.teleop !== null && <StatTile label="Teleop EPA" value={String(epa.teleop)} />}
                      {epa.endgame !== null && <StatTile label="Endgame EPA" value={String(epa.endgame)} />}
                    </div>
                  </div>
                )}
                {submissions.length > 0 ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Scouted Averages ({submissions.length} match{submissions.length !== 1 ? "es" : ""})
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {numericFields.map((f) => {
                        const a = fieldAvg(f.id);
                        return <StatTile key={f.id} label={f.label} value={a === null ? null : (Number.isInteger(a) ? String(a) : a.toFixed(1))} />;
                      })}
                      {checkboxFields.map((f) => {
                        const vals = parsed.map((d) => d[f.id]).filter((v) => v !== undefined);
                        if (!vals.length) return null;
                        const pct = Math.round((vals.filter(Boolean).length / vals.length) * 100);
                        return <StatTile key={f.id} label={f.label} value={`${pct}%`} sub="success rate" />;
                      })}
                    </div>
                    {numericFields.length === 0 && checkboxFields.length === 0 && (
                      <p className="text-sm text-muted-foreground">No numeric fields in the active form.</p>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                    <ClipboardList className="h-8 w-8 opacity-30" />
                    <p className="text-sm">No scouting data for this team yet.</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── CHARTS ── */}
          <TabsContent value="charts" className="flex-1 min-h-0 mt-0">
            <ScrollArea className="h-full">
              <div className="px-5 py-4 space-y-4 pb-8">
                {/* Radar */}
                <RadarStatsChart fields={fields} submissions={submissions} />

                {/* Line: performance over matches */}
                <MatchTrendChart
                  fields={fields}
                  submissions={submissions}
                  eventKey={eventKey}
                  teamNumber={teamNumber}
                />

                {/* Box plot */}
                <BoxPlotChart fields={fields} submissions={submissions} />
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── REPORTS ── */}
          <TabsContent value="reports" className="flex-1 min-h-0 mt-0">
            <ScrollArea className="h-full">
              <div className="px-5 py-4 space-y-3 pb-8">
                {submissions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                    <ClipboardList className="h-8 w-8 opacity-30" />
                    <p className="text-sm">No reports yet.</p>
                  </div>
                ) : (
                  [...submissions]
                    .sort((a, b) => a.matchNumber - b.matchNumber)
                    .map((sub) => (
                      <ReportRow key={sub._id} sub={sub} fields={fields} />
                    ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── PIT SCOUTING REPORT ── */}
          <TabsContent value="pit" className="flex-1 min-h-0 mt-0">
            <ScrollArea className="h-full">
              <div className="px-5 py-4 pb-8">
                {pitSubmissions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
                    <Search className="h-9 w-9 opacity-20" />
                    <p className="text-sm font-medium">No pit scouting data yet</p>
                    <p className="text-xs text-center max-w-xs">
                      Use <strong>Scout Pit</strong> to record pit data for this team.
                    </p>
                  </div>
                ) : (() => {
                  // Use the most recent pit submission
                  const latestPit = [...pitSubmissions].sort((a, b) => (b.syncedAt ?? 0) - (a.syncedAt ?? 0))[0];
                  const pitData = parseData(latestPit);
                  // Group non-teamNumber fields by section
                  const visibleFields = pitFields.filter((f) => f.type !== "teamNumber");
                  const sections = visibleFields.reduce<Record<string, FormField[]>>((acc, f) => {
                    const key = f.section ?? "General";
                    acc[key] = [...(acc[key] ?? []), f];
                    return acc;
                  }, {});

                  return (
                    <div className="space-y-5">
                      {pitSubmissions.length > 1 && (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-xs text-cyan-400">
                          <Search className="h-3.5 w-3.5 shrink-0" />
                          Showing most recent of {pitSubmissions.length} pit submissions
                        </div>
                      )}
                      {Object.entries(sections).map(([section, sectionFields]) => (
                        <div key={section} className="bg-card border border-border rounded-xl overflow-hidden">
                          <div className="px-4 py-2 bg-cyan-500/10 border-b border-border">
                            <h3 className="font-semibold text-sm text-cyan-400">{section}</h3>
                          </div>
                          <div className="divide-y divide-border">
                            {sectionFields.map((f) => {
                              const raw = pitData[f.id];
                              const isEmpty = raw === undefined || raw === null || raw === "" || raw === 0;

                              let display: React.ReactNode;
                              if (f.type === "checkbox") {
                                display = raw ? (
                                  <span className="flex items-center gap-1 text-green-400 text-sm font-medium">
                                    <CheckCircle2 className="h-4 w-4" /> Yes
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-1 text-muted-foreground text-sm">
                                    <XCircle className="h-4 w-4" /> No
                                  </span>
                                );
                              } else if (f.type === "rating") {
                                const max = Number(f.options?.[0] ?? "5");
                                const val = Number(raw ?? 0);
                                display = (
                                  <div className="flex items-center gap-1">
                                    {Array.from({ length: max }).map((_, i) => (
                                      <Star
                                        key={i}
                                        className={`h-4 w-4 ${
                                          i < val ? "text-yellow-400 fill-yellow-400" : "text-muted-foreground/20"
                                        }`}
                                      />
                                    ))}
                                    <span className="ml-1 text-sm font-mono text-muted-foreground">{val}/{max}</span>
                                  </div>
                                );
                              } else if (f.type === "textarea") {
                                display = (
                                  <p className="text-sm whitespace-pre-wrap leading-relaxed">
                                    {isEmpty ? <span className="text-muted-foreground italic">No response</span> : String(raw)}
                                  </p>
                                );
                              } else {
                                display = (
                                  <span className={`text-sm font-medium ${
                                    isEmpty ? "text-muted-foreground italic" : ""
                                  }`}>
                                    {isEmpty ? "No response" : String(raw)}
                                  </span>
                                );
                              }

                              return (
                                <div key={f.id} className="px-4 py-3 flex items-start justify-between gap-4">
                                  <span className="text-sm text-muted-foreground shrink-0 pt-0.5">{f.label}</span>
                                  <div className="text-right">{display}</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      {visibleFields.length === 0 && (
                        <p className="text-sm text-muted-foreground italic">No fields in the pit form.</p>
                      )}
                    </div>
                  );
                })()}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
