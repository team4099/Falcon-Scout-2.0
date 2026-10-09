import { useState, useEffect, useMemo } from "react";
import { matchLabel } from "@/lib/utils";
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
  fetchStatboticsEventTeamMatches,
  fetchStatboticsTeamSeason,
} from "@/lib/api";
import { buildTimelines, seasonTrend, slimTbaMatch } from "@/lib/chartData";
import type { SeasonTrend, SlimMatch, SlimTeamMatch } from "@/lib/chartData";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
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

// ── Charts: season trends ─────────────────────────────────────────────────────

const GRID = { strokeDasharray: "3 3", stroke: "currentColor", opacity: 0.12 };
const AXIS = { stroke: "currentColor", opacity: 0.35 };
const AXIS_TICK = { fontSize: 10, fill: "currentColor", opacity: 0.7 };

function SeasonTrendChart({
  title,
  hint,
  valueLabel,
  trend,
  color,
  loading,
}: {
  title: string;
  hint: string;
  valueLabel: string;
  trend: SeasonTrend;
  color: string;
  loading: boolean;
}) {
  const { rows, events } = trend;
  const step = Math.max(1, Math.ceil(rows.length / 8));
  const ticks = rows.filter((r) => (r.i - 1) % step === 0).map((r) => r.i);

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      </div>

      {rows.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
          {loading ? "Loading season matches…" : "No data for this season yet"}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={rows} margin={{ top: 20, right: 12, bottom: 0, left: -16 }}>
            <CartesianGrid {...GRID} vertical={false} />
            <XAxis
              type="number"
              dataKey="i"
              domain={[0.5, rows.length + 0.5]}
              ticks={ticks}
              tick={AXIS_TICK}
              tickLine={AXIS}
              axisLine={AXIS}
            />
            <YAxis tick={AXIS_TICK} tickLine={AXIS} axisLine={AXIS} domain={["auto", "auto"]} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as SeasonTrend["rows"][number];
                return (
                  <div className="bg-popover border border-border rounded-lg px-3 py-2 text-xs shadow-xl">
                    <p className="text-muted-foreground mb-1 font-mono">{r.event.slice(4)} {r.label}</p>
                    <p className="font-semibold" style={{ color }}>{valueLabel}: {fmt(r.value)}</p>
                    {r.score !== undefined && <p className="text-muted-foreground">This match: {fmt(r.score)}</p>}
                  </div>
                );
              }}
            />
            {/* One divider where each event starts, labelled with its event code. */}
            {events.map((e) => (
              <ReferenceLine
                key={e.event}
                x={e.start - 0.5}
                stroke="currentColor"
                strokeOpacity={0.45}
                strokeDasharray="4 3"
                label={({ viewBox }: { viewBox: { x: number; y: number } }) => (
                  <text x={viewBox.x + 4} y={viewBox.y - 6} fontSize={10} fill="currentColor" opacity={0.75}>
                    {e.event.slice(4)}
                  </text>
                )}
              />
            ))}
            <Line
              type="monotone"
              dataKey="value"
              name={valueLabel}
              stroke={color}
              strokeWidth={2}
              dot={rows.length <= 40 ? { r: 2, fill: color } : false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** EPA and average score across the team's whole season. Mounted only while
 *  the Charts tab is open, so the season fetch waits until it's wanted. */
function SeasonCharts({ teamNumber, eventKey, eventYear }: { teamNumber: number; eventKey: string; eventYear: number }) {
  const want = `${teamNumber}|${eventKey}|${eventYear}`;
  const [loaded, setLoaded] = useState<{ key: string; matches: SlimMatch[]; teamMatches: SlimTeamMatch[] } | null>(null);
  // Ignore a previous team's data while this one loads.
  const src = loaded?.key === want ? loaded : null;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchStatboticsTeamSeason(teamNumber, eventYear).catch(() => ({ matches: [], teamMatches: [] })),
      eventKey ? fetchTBAEventMatches(eventKey).catch(() => null) : null,
      eventKey ? fetchStatboticsEventTeamMatches(eventKey).catch(() => null) : null,
    ]).then(([season, tba, eventTeamMatches]) => {
      if (cancelled) return;
      setLoaded({
        key: `${teamNumber}|${eventKey}|${eventYear}`,
        // Current-event TBA matches first: the first copy of a key wins, and
        // TBA has scores before Statbotics does.
        matches: [...(Array.isArray(tba) ? tba.map(slimTbaMatch) : []), ...season.matches],
        teamMatches: [...(eventTeamMatches ?? []), ...season.teamMatches],
      });
    });
    return () => { cancelled = true; };
  }, [teamNumber, eventKey, eventYear]);

  const { epa, score } = useMemo(() => {
    const timeline = (metric: string) =>
      buildTimelines({
        teams: [teamNumber], scope: "season", eventKey, metric,
        matches: src?.matches ?? [], teamMatches: src?.teamMatches ?? [],
        submissions: [], fieldColumns: [],
      })[teamNumber] ?? [];
    return {
      epa: seasonTrend(timeline("epaEvent"), "epaEvent"),
      score: seasonTrend(timeline("avgScore"), "avgScore", true),
    };
  }, [src, teamNumber, eventKey]);

  return (
    <>
      <SeasonTrendChart
        title="EPA Over Time"
        hint="going into each match · dashed line = new event"
        valueLabel="EPA"
        trend={epa}
        color="var(--primary)"
        loading={src === null}
      />
      <SeasonTrendChart
        title="Avg Score Over Time"
        hint="running average of alliance score · dashed line = new event"
        valueLabel="Avg score"
        trend={score}
        color="#60a5fa"
        loading={src === null}
      />
    </>
  );
}

// ── Team avatar ───────────────────────────────────────────────────────────────

export function TeamAvatar({ teamNumber, size = 40 }: { teamNumber: number; size?: number }) {
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
export function AnswerList({ fields, data, onPhoto }: { fields: FormField[]; data: Record<string, unknown>; onPhoto: (src: string) => void }) {
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

export function PhotoLightbox({ src, onClose }: { src: string; onClose: () => void }) {
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
  eventYear,
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
                <SeasonCharts teamNumber={teamNumber} eventKey={eventKey} eventYear={eventYear} />
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
