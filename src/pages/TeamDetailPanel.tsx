import { useState, useEffect, useMemo } from "react";
import { matchLabel, matchSortValue } from "@/lib/utils";
import { aggregateField } from "@/lib/rankingColumns";
import {
  rankIn,
  isLowerBetter,
  parseSubData,
  isEmptyValue,
  isNoteField,
  fieldsForData,
  newestFirst,
  latestPit,
  type Rank,
} from "@/lib/teamProfile";
import type { FieldType } from "@/types";
import { useUIStore } from "@/store/uiStore";
import { useAdminMutation } from "@/hooks/useAdminMutation";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import {
  X,
  ExternalLink,
  TrendingUp,
  BarChart2,
  ClipboardList,
  Search,
  CheckCircle2,
  XCircle,
  Star,
  Trash2,
  StickyNote,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FormField {
  id: string;
  type: FieldType;
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
  compLevel?: "qm" | "elim";
  scoutId?: string;
  syncedAt?: number;
  data: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const parseData = parseSubData;

interface Template {
  _id: string;
  name: string;
  formType?: string;
  fields: FormField[];
}

type TeamEpa = { event: number | null; overall: number | null; auto: number | null; teleop: number | null; endgame: number | null };

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
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  // Sort quals before elims, each by number — a bare matchNumber sort
  // interleaves elim 1 with qual 1.
  const sorted = [...submissions].sort(
    (a, b) =>
      matchSortValue(a.matchNumber, a.compLevel) -
      matchSortValue(b.matchNumber, b.compLevel),
  );

  const data = sorted.map((s) => {
    const d = parseData(s);
    const row: Record<string, number | string | undefined> = {
      match: matchLabel(s.matchNumber, s.compLevel),
      __sort: matchSortValue(s.matchNumber, s.compLevel),
    };
    for (const f of numericFields) {
      const v = d[f.id];
      if (typeof v === "number") row[f.id] = v;
    }
    // TBA scores are indexed by qual match number, so only attach them to
    // qualification rows — an elim row would otherwise pick up an unrelated
    // qual match's score.
    if (s.compLevel !== "elim" && matchScores[s.matchNumber] !== undefined) {
      row["__tbaScore"] = matchScores[s.matchNumber];
    }
    return row;
  });

  // Add matches with TBA scores but no submission. TBA's match_number here is
  // a qualification number, so label these as quals to match the rows above.
  for (const [matchNum, score] of Object.entries(matchScores)) {
    const mn = Number(matchNum);
    const label = matchLabel(mn, "qm");
    if (!data.find((d) => d.match === label)) {
      data.push({ match: label, __sort: matchSortValue(mn, "qm"), __tbaScore: score });
    }
  }
  data.sort((a, b) => (Number(a.__sort) || 0) - (Number(b.__sort) || 0));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
    fetchTBATeamAvatar(teamNumber, size).then(setSrc).catch(() => setSrc(null));
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

function StatTile({ label, value, sub, rank }: { label: string; value: string | null; sub?: string; rank?: Rank | null }) {
  return (
    <div className="bg-muted/30 border border-border rounded-xl p-3 flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate" title={label}>{label}</span>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xl font-bold font-mono">{value ?? "—"}</span>
        {rank && (
          <span
            className={`text-[11px] font-mono font-semibold shrink-0 ${rank.rank <= 3 ? "text-primary" : "text-muted-foreground"}`}
            title={`Ranked ${rank.rank} of ${rank.total} teams at this event`}
          >
            #{rank.rank}<span className="opacity-60">/{rank.total}</span>
          </span>
        )}
      </div>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

// ── Field answers (reports + pit) ─────────────────────────────────────────────

const isPhoto = (v: unknown): v is string => typeof v === "string" && v.startsWith("data:image/");

function AnswerValue({ field, raw, onPhoto }: { field: FormField; raw: unknown; onPhoto: (src: string) => void }) {
  if (field.type === "photo" || isPhoto(raw)) {
    if (!isPhoto(raw)) return <span className="text-xs text-muted-foreground italic">Photo not available</span>;
    return (
      <button type="button" onClick={() => onPhoto(raw)} className="block">
        <img src={raw} alt={field.label} loading="lazy" className="max-h-48 rounded-lg border border-border object-contain" />
      </button>
    );
  }
  if (field.type === "checkbox") {
    const yes = raw === true || raw === "true";
    return yes ? (
      <span className="inline-flex items-center gap-1 text-green-400 text-sm font-medium"><CheckCircle2 className="h-3.5 w-3.5" /> Yes</span>
    ) : (
      <span className="inline-flex items-center gap-1 text-muted-foreground text-sm"><XCircle className="h-3.5 w-3.5" /> No</span>
    );
  }
  if (field.type === "rating") {
    const max = Number(field.options?.[0] ?? "5");
    return (
      <span className="inline-flex items-center gap-1 text-sm font-semibold font-mono">
        <Star className="h-3.5 w-3.5 text-yellow-400 fill-yellow-400" />{String(raw)}<span className="text-muted-foreground font-normal">/{max}</span>
      </span>
    );
  }
  if (isNoteField(field.type)) {
    return <p className="text-sm whitespace-pre-wrap leading-relaxed break-words">{String(raw)}</p>;
  }
  return <span className="text-sm font-semibold break-words">{Array.isArray(raw) ? raw.join(", ") : String(raw)}</span>;
}

/** Answered fields grouped by section, in form order. Blank answers are
 *  omitted entirely; notes and photos span the full width. */
function AnswerList({ fields, data, onPhoto }: { fields: FormField[]; data: Record<string, unknown>; onPhoto: (src: string) => void }) {
  const sections: Array<[string, FormField[]]> = [];
  for (const f of fields) {
    if (isEmptyValue(data[f.id])) continue;
    const name = f.section ?? "";
    const last = sections[sections.length - 1];
    if (last && last[0] === name) last[1].push(f);
    else sections.push([name, [f]]);
  }
  return (
    <div className="space-y-3">
      {sections.map(([name, fs], i) => (
        <div key={`${name}-${i}`}>
          {name && <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{name}</p>}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {fs.map((f) => (
              <div key={f.id} className={isNoteField(f.type) || f.type === "photo" ? "col-span-2" : "min-w-0"}>
                <p className="text-[11px] text-muted-foreground mb-0.5">{f.label}</p>
                <AnswerValue field={f} raw={data[f.id]} onPhoto={onPhoto} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Scouting report card ──────────────────────────────────────────────────────

type ReportMode = "full" | "notes" | "data";

/** The answered fields a report shows under the current filter. */
function reportFields(fields: FormField[], data: Record<string, unknown>, mode: ReportMode): FormField[] {
  return fields.filter(
    (f) =>
      f.type !== "teamNumber" &&
      !isEmptyValue(data[f.id]) &&
      (mode === "full" || (mode === "notes") === isNoteField(f.type)),
  );
}

function ReportCard({
  sub,
  shown,
  data,
  formName,
  canDelete,
  onDelete,
  onPhoto,
}: {
  sub: Submission;
  shown: FormField[];
  data: Record<string, unknown>;
  formName: string | null;
  canDelete: boolean;
  onDelete: () => void;
  onPhoto: (src: string) => void;
}) {
  const date = sub.syncedAt
    ? new Date(sub.syncedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/20">
        <span className="font-bold text-sm">
          {sub.compLevel === "elim" ? "Elim" : "Match"} {sub.matchNumber}
        </span>
        {formName && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{formName}</span>
        )}
        {date && <span className="text-[10px] text-muted-foreground">{date}</span>}
        <div className="flex-1" />
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="Delete report"
            aria-label={`Delete match ${sub.matchNumber} report`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="px-4 py-3 bg-background/50">
        {shown.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No answers recorded.</p>
        ) : (
          <AnswerList fields={shown} data={data} onPhoto={onPhoto} />
        )}
      </div>
    </div>
  );
}

// ── Photo lightbox ────────────────────────────────────────────────────────────

function PhotoLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-4" onClick={onClose}>
      <img src={src} alt="Robot" className="max-w-full max-h-full rounded-lg object-contain" />
      <Button variant="ghost" size="icon" className="absolute top-3 right-3 h-9 w-9 text-white" onClick={onClose} aria-label="Close photo">
        <X className="h-5 w-5" />
      </Button>
    </div>
  );
}

// ── Team Detail Panel ─────────────────────────────────────────────────────────

const EPA_TILES: Array<{ key: keyof TeamEpa; label: string }> = [
  { key: "event", label: "Event EPA" },
  { key: "overall", label: "Season EPA" },
];
const EPA_PARTS: Array<{ key: keyof TeamEpa; label: string }> = [
  { key: "auto", label: "Auto EPA" },
  { key: "teleop", label: "Teleop EPA" },
  { key: "endgame", label: "Endgame EPA" },
];

const REPORT_MODES: ReadonlyArray<readonly [ReportMode, string]> = [
  ["full", "Full report"],
  ["notes", "Notes"],
  ["data", "Data"],
];

function NotesTab({ value, canEdit, readOnlyHint, onSave }: NonNullable<TeamDetailProps["notes"]>) {
  const [draft, setDraft] = useState(value);
  // Follow server updates (another admin saving) unless we're mid-edit.
  const [base, setBase] = useState(value);
  if (value !== base) {
    setBase(value);
    if (draft === base) setDraft(value);
  }
  const dirty = draft !== value;

  return (
    <div className="px-5 py-4 flex flex-col gap-3 h-full">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={!canEdit}
        aria-label="Team notes"
        placeholder={canEdit ? "Notes about this team..." : "No notes yet."}
        className="flex-1 min-h-48 resize-none text-sm leading-relaxed"
      />
      {canEdit ? (
        <div className="flex items-center justify-end gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => setDraft(value)}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!dirty} onClick={() => onSave(draft)}>
            Save notes
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{readOnlyHint}</p>
      )}
    </div>
  );
}

export interface TeamDetailProps {
  teamNumber: number;
  eventKey: string;
  eventYear: number;
  submissions: Submission[];
  fields: FormField[];
  epa: TeamEpa;
  avgScore: number | null;
  tbaRank: Record<string, unknown> | null;
  pitSubmissions: Submission[];
  pitFields: FormField[];
  /** Every live template, so each report renders with its own form's fields. */
  templates: Template[];
  /** Event-wide data for the per-stat rankings. */
  epaByTeam: Record<number, TeamEpa>;
  avgScoreByTeam: Record<number, number>;
  submissionsByTeam: Record<number, Submission[]>;
  /** Picklist only: adds a Notes tab. Who may edit is decided by the caller
   *  (and enforced server-side); everyone else sees the notes read-only. */
  notes?: { value: string; canEdit: boolean; readOnlyHint: string; onSave: (text: string) => void };
  onClose: () => void;
}

export default function TeamDetailPanel({
  teamNumber,
  eventKey,
  eventYear: _eventYear,
  submissions,
  fields,
  epa,
  avgScore,
  tbaRank,
  pitSubmissions,
  pitFields,
  templates,
  epaByTeam,
  avgScoreByTeam,
  submissionsByTeam,
  notes,
  onClose,
}: TeamDetailProps) {
  const [teamInfo, setTeamInfo] = useState<{ nickname?: string; city?: string } | null>(null);
  const [tab, setTab] = useState("overview");
  const [reportMode, setReportMode] = useState<ReportMode>("full");
  const [photo, setPhoto] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Submission | null>(null);
  const { isAdminMode } = useUIStore();
  const deleteSubmission = useAdminMutation(api.forms.deleteSubmission);

  useEffect(() => {
    fetchTBATeamInfo(teamNumber).then((d) => {
      if (d && typeof d === "object") setTeamInfo(d as { nickname?: string; city?: string });
    }).catch(() => {});
  }, [teamNumber]);

  const templateById = useMemo(() => new Map(templates.map((t) => [t._id, t])), [templates]);
  // Every field any template defines — labels answers whose own form was
  // edited or deleted after the report was submitted.
  const knownFields = useMemo(() => {
    const m = new Map<string, FormField>();
    for (const t of templates) for (const f of t.fields) if (!m.has(f.id)) m.set(f.id, f);
    return m;
  }, [templates]);

  const statFields = useMemo(
    () => fields.filter((f) => ["number", "counter", "rating", "checkbox"].includes(f.type)),
    [fields],
  );

  // Scouted value per stat field for every team: this team's tile and its
  // event rank use the same aggregation as the Dashboard's field columns.
  const scoutedByField = useMemo(() => {
    const out: Record<string, Record<number, number | null>> = {};
    const rowsByTeam = Object.entries(submissionsByTeam).map(
      ([tn, subs]) => [Number(tn), subs.map(parseData)] as const,
    );
    for (const f of statFields) {
      const vals: Record<number, number | null> = {};
      for (const [tn, rows] of rowsByTeam) {
        const sort = aggregateField(f, rows.map((d) => d[f.id])).sort;
        vals[tn] = typeof sort === "number" ? sort : null;
      }
      out[f.id] = vals;
    }
    return out;
  }, [statFields, submissionsByTeam]);

  const epaRank = (key: keyof TeamEpa) =>
    rankIn(Object.fromEntries(Object.entries(epaByTeam).map(([tn, e]) => [tn, e[key]])), teamNumber);

  // One pit report per team: the latest. Deleting it falls back to the one before.
  const pit = latestPit(pitSubmissions);
  const pitFormFields = (pit && templateById.get(pit.templateId)?.fields) || pitFields;
  const pitData = pit ? parseData(pit) : {};
  const pitAllFields = fieldsForData(pitFormFields, pitData, knownFields);
  // Prefer a photo-type field; fall back to any image answer on the report.
  const robotPhoto =
    pitAllFields.filter((f) => f.type === "photo").map((f) => pitData[f.id]).find(isPhoto) ??
    Object.values(pitData).find(isPhoto) ??
    null;
  const pitAnswerFields = pitAllFields.filter(
    (f) => f.type !== "photo" && f.type !== "teamNumber" && !isPhoto(pitData[f.id]),
  );
  const pitHasAnswers = pitAnswerFields.some((f) => !isEmptyValue(pitData[f.id]));

  // Newest first; in Notes/Data view a report with nothing of that kind is skipped.
  const reports = useMemo(
    () =>
      newestFirst(submissions)
        .map((sub) => {
          const tpl = templateById.get(sub.templateId);
          const data = parseData(sub);
          const all = fieldsForData(tpl?.fields ?? fields, data, knownFields);
          return { sub, tpl, data, shown: reportFields(all, data, reportMode) };
        })
        .filter((r) => reportMode === "full" || r.shown.length > 0),
    [submissions, templateById, knownFields, fields, reportMode],
  );

  const rank = tbaRank ? (tbaRank as { rank?: number }).rank ?? null : null;
  const record = tbaRank ? (tbaRank as { record?: { wins: number; losses: number; ties: number } }).record ?? null : null;
  const hasStats = epa.event !== null || epa.overall !== null || avgScore !== null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-2xl bg-background border-l border-border flex flex-col h-full overflow-hidden shadow-2xl animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="flex items-center gap-4 px-5 py-4 border-b border-border shrink-0">
          {robotPhoto ? (
            <button
              type="button"
              onClick={() => setPhoto(robotPhoto)}
              className="shrink-0 rounded-lg overflow-hidden border border-border bg-muted hover:ring-2 hover:ring-primary/50 transition"
              title="View robot photo"
            >
              <img src={robotPhoto} alt={`Team ${teamNumber} robot`} className="h-20 w-20 object-cover" />
            </button>
          ) : (
            <TeamAvatar teamNumber={teamNumber} size={48} />
          )}
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
            {notes && (
              <TabsTrigger value="notes" className="gap-1.5">
                <StickyNote className="h-3.5 w-3.5" /> Notes
              </TabsTrigger>
            )}
          </TabsList>

          {/* ── OVERVIEW ── */}
          <TabsContent value="overview" className="flex-1 min-h-0 mt-0">
            <ScrollArea className="h-full">
              <div className="px-5 py-4 space-y-5 pb-8">
                {hasStats && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Statistics</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {EPA_TILES.map(({ key, label }) =>
                        epa[key] !== null && <StatTile key={key} label={label} value={String(epa[key])} rank={epaRank(key)} />,
                      )}
                      {avgScore !== null && (
                        <StatTile label="Avg TBA Score" value={String(avgScore)} rank={rankIn(avgScoreByTeam, teamNumber)} />
                      )}
                      {EPA_PARTS.map(({ key, label }) =>
                        epa[key] !== null && <StatTile key={key} label={label} value={String(epa[key])} rank={epaRank(key)} />,
                      )}
                    </div>
                  </div>
                )}
                {submissions.length > 0 ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Scouting Data ({submissions.length} report{submissions.length !== 1 ? "s" : ""})
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {statFields.map((f) => {
                        const v = scoutedByField[f.id]?.[teamNumber] ?? null;
                        const rk = rankIn(scoutedByField[f.id] ?? {}, teamNumber, isLowerBetter(f.label));
                        if (f.type === "checkbox") {
                          return v === null ? null : (
                            <StatTile key={f.id} label={f.label} value={`${Math.round(v)}%`} sub="of reports" rank={rk} />
                          );
                        }
                        return <StatTile key={f.id} label={f.label} value={v === null ? null : fmt(v)} rank={rk} />;
                      })}
                    </div>
                    {statFields.length === 0 && (
                      <p className="text-sm text-muted-foreground">No numeric fields in the active form.</p>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                    <ClipboardList className="h-8 w-8 opacity-30" />
                    <p className="text-sm">No scouting data for this team yet.</p>
                  </div>
                )}

                {/* Pit report — only the latest one is shown */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Pit Report
                    {pit?.syncedAt && (
                      <span className="ml-2 normal-case tracking-normal font-normal">
                        {new Date(pit.syncedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </p>
                  {!pit ? (
                    <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-dashed border-border text-sm text-muted-foreground">
                      <Search className="h-4 w-4 opacity-40" /> No pit scouting data yet.
                    </div>
                  ) : !pitHasAnswers ? (
                    <p className="text-sm text-muted-foreground italic">No pit answers besides the photo.</p>
                  ) : (
                    <div className="bg-card border border-border rounded-xl px-4 py-3">
                      <AnswerList fields={pitAnswerFields} data={pitData} onPhoto={setPhoto} />
                    </div>
                  )}
                </div>
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
                <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/40 w-fit" role="radiogroup" aria-label="Report filter">
                  {REPORT_MODES.map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={reportMode === m}
                      onClick={() => setReportMode(m)}
                      className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                        reportMode === m ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {reports.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                    <ClipboardList className="h-8 w-8 opacity-30" />
                    <p className="text-sm">
                      {submissions.length === 0 ? "No reports yet." : reportMode === "notes" ? "No notes in any report." : "No data in any report."}
                    </p>
                  </div>
                ) : (
                  reports.map(({ sub, tpl, data, shown }) => (
                    <ReportCard
                      key={sub._id}
                      sub={sub}
                      shown={shown}
                      data={data}
                      formName={tpl && (tpl.formType ?? "default") !== "default" ? tpl.name : null}
                      canDelete={isAdminMode}
                      onDelete={() => setToDelete(sub)}
                      onPhoto={setPhoto}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {notes && (
            <TabsContent value="notes" className="flex-1 min-h-0 mt-0">
              <NotesTab {...notes} />
            </TabsContent>
          )}
        </Tabs>
      </div>

      {photo && <PhotoLightbox src={photo} onClose={() => setPhoto(null)} />}

      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => { if (!o) setToDelete(null); }}
        title="Delete scouting report?"
        description={
          toDelete
            ? `This permanently deletes the ${matchLabel(toDelete.matchNumber, toDelete.compLevel)} report for Team ${teamNumber}. This can't be undone.`
            : ""
        }
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteSubmission({ id: toDelete._id as Id<"formSubmissions"> });
          toast.success("Report deleted");
        }}
      />
    </div>
  );
}
