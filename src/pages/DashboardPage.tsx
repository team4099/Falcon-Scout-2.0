import { useState, useEffect, useMemo, useRef } from "react";
import { useUIStore } from "@/store/uiStore";
import { useQuery } from "convex/react";
import { useCached } from "@/hooks/useCached";
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
import {
  fetchStatboticsEventTeams,
  fetchStatboticsTeamYearsBatch,
  fetchTBAEventTeams,
  fetchTBAEventRankings,
  fetchTBAEventMatches,
  fetchTBATeamAvatar,
  fetchTBATeamInfo,
  fetchNexusTeamStatus,
} from "@/lib/api";
import type { TBAMatch, NexusTeamStatus } from "@/lib/api";
import { ExternalLink, Search, FileText, TrendingUp, ClipboardList, Trash2, AlertTriangle, ChevronDown, ChevronUp, Clock, SlidersHorizontal, KeyRound, CalendarCheck, Radio, Users2 } from "lucide-react";
import { getTBAKey } from "@/lib/api";
import TeamDetailPanel from "@/pages/TeamDetailPanel";
import { useMutation } from "convex/react";
import type { Id } from "../../convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { idbGet, lsGetStale, lsSet, TTL } from "@/lib/persistentCache";

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
  data: string; // JSON string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseSubmissions(submissions: Submission[]): Record<string, unknown>[] {
  return submissions.map((s) => {
    try { return JSON.parse(s.data) as Record<string, unknown>; }
    catch { return {}; }
  });
}

/** Average of numeric/counter values across submissions (null if no data). */
function avgNumeric(parsed: Record<string, unknown>[], fieldId: string): number | null {
  const vals = parsed
    .map((d) => d[fieldId])
    .filter((v) => typeof v === "number") as number[];
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Percentage of submissions where the checkbox is true. */
function pctChecked(parsed: Record<string, unknown>[], fieldId: string): number | null {
  const vals = parsed.map((d) => d[fieldId]).filter((v) => v !== undefined);
  if (vals.length === 0) return null;
  return (vals.filter(Boolean).length / vals.length) * 100;
}

/** Most common value for select fields. */
function mostCommon(parsed: Record<string, unknown>[], fieldId: string): string | null {
  const counts: Record<string, number> = {};
  for (const d of parsed) {
    const v = String(d[fieldId] ?? "");
    if (v) counts[v] = (counts[v] ?? 0) + 1;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
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
            Text submissions — {teamNumber}
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

// ── Scouting Reports Review Dialog ────────────────────────────────────────────

function SubmissionsReviewDialog({
  open,
  onClose,
  teamNumber,
  submissions,
  fields,
  isAdminMode,
}: {
  open: boolean;
  onClose: () => void;
  teamNumber: number;
  submissions: Submission[];
  fields: FormField[];
  isAdminMode: boolean;
}) {
  const deleteSubmission = useMutation(api.forms.deleteSubmission);
  const allUsers = useQuery(api.users.listUsers);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Build userId → profile lookup from Google OAuth data
  const userMap = useMemo(() => {
    const map: Record<string, { name?: string; email?: string; image?: string }> = {};
    for (const u of allUsers ?? []) {
      if (u._id) map[u._id] = { name: u.name as string | undefined, email: u.email as string | undefined, image: u.image as string | undefined };
    }
    return map;
  }, [allUsers]);

  // Sort oldest → newest match for reading chronologically
  const sorted = [...submissions].sort((a, b) => a.matchNumber - b.matchNumber);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleDelete() {
    if (!confirmId) return;
    setDeleting(true);
    try {
      await deleteSubmission({ id: confirmId as Id<"formSubmissions"> });
    } finally {
      setDeleting(false);
      setConfirmId(null);
    }
  }

  function renderValue(field: FormField, raw: unknown): React.ReactNode {
    if (raw === undefined || raw === null || raw === "") {
      return <span className="text-muted-foreground/50 italic">—</span>;
    }
    if (field.type === "checkbox") {
      const checked = raw === true || raw === "true";
      return (
        <span className={`font-semibold ${checked ? "text-green-500" : "text-muted-foreground"}`}>
          {checked ? "✓ Yes" : "✗ No"}
        </span>
      );
    }
    return <span>{String(raw)}</span>;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          className="max-w-2xl flex flex-col overflow-hidden"
          style={{ maxHeight: "85vh" }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-primary" />
              Scouting Reports — Team {teamNumber}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              {submissions.length} report{submissions.length !== 1 ? "s" : ""} submitted
              {submissions.length > 0 && (
                <> · Click a report to expand · <span className="text-destructive">Delete removes it permanently</span></>
              )}
            </p>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-2 py-1">
            {sorted.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                <ClipboardList className="h-8 w-8 opacity-30" />
                <p className="text-sm">No scouting reports for this team yet.</p>
              </div>
            ) : (
              sorted.map((sub) => {
                const data: Record<string, unknown> = (() => {
                  try { return JSON.parse(sub.data); } catch { return {}; }
                })();
                const isExpanded = expandedIds.has(sub._id);
                const date = sub.syncedAt
                  ? new Date(sub.syncedAt).toLocaleString(undefined, {
                      month: "short", day: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    })
                  : null;

                // Quick text preview for collapsed state
                const textFields = fields.filter((f) => f.type === "text" || f.type === "textarea");
                const preview = textFields
                  .map((f) => String(data[f.id] ?? "").trim())
                  .filter(Boolean)[0];

                return (
                  <div
                    key={sub._id}
                    className="border border-border rounded-lg overflow-hidden"
                  >
                    {/* Header row — always visible */}
                    <div
                      className="flex items-center gap-3 px-3 py-2.5 bg-muted/30 cursor-pointer hover:bg-muted/50 transition-colors select-none"
                      onClick={() => toggleExpand(sub._id)}
                    >
                      <div className="flex-1 flex items-center gap-3 min-w-0">
                        <span className="font-bold text-sm shrink-0">
                          Match {sub.matchNumber}
                        </span>
                        {date && (
                          <span className="text-[10px] text-muted-foreground shrink-0">{date}</span>
                        )}
                        {/* Scouter identity */}
                        {sub.scoutId && userMap[sub.scoutId] && (() => {
                          const u = userMap[sub.scoutId];
                          const displayName = u.name ?? u.email ?? "Unknown scout";
                          return (
                            <span className="flex items-center gap-1 shrink-0">
                              {u.image
                                ? <img src={u.image} alt={displayName} className="h-4 w-4 rounded-full object-cover" />
                                : <span className="h-4 w-4 rounded-full bg-primary/20 text-primary text-[9px] flex items-center justify-center font-bold">
                                    {displayName.charAt(0).toUpperCase()}
                                  </span>
                              }
                              <span className="text-[10px] text-muted-foreground">{displayName}</span>
                            </span>
                          );
                        })()}
                        {!isExpanded && preview && (
                          <span className="text-xs text-muted-foreground truncate italic">
                            "{preview}"
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {isAdminMode ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmId(sub._id);
                            }}
                            className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            title="Delete this report"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <span
                            className="p-1.5 rounded text-muted-foreground/30 cursor-not-allowed"
                            title="Enable admin mode to delete reports"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </span>
                        )}
                        {isExpanded
                          ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                          : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        }
                      </div>
                    </div>

                    {/* Expanded field values */}
                    {isExpanded && (
                      <div className="px-3 pb-3 pt-2">
                        {fields.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">No active form template.</p>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                            {fields
                              .filter((f) => f.type === "number" || f.type === "counter" || f.type === "checkbox")
                              .map((f) => (
                              <div key={f.id} className="flex items-start gap-2 min-w-0">
                                <span className="text-xs text-muted-foreground shrink-0 pt-px w-32 truncate" title={f.label}>
                                  {f.label}
                                </span>
                                <span className="text-xs font-medium leading-snug" style={{ overflowWrap: "anywhere" }}>
                                  {renderValue(f, data[f.id])}
                                </span>
                              </div>
                            ))}</div>
                        )}
                        {/* Raw match info */}
                        <div className="mt-2 pt-2 border-t border-border/50 flex gap-4 text-[10px] text-muted-foreground/70">
                          <span>Match #{sub.matchNumber}</span>
                          {date && <span>Submitted {date}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={confirmId !== null} onOpenChange={(o) => !o && setConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Delete scouting report?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  This will permanently remove Match{" "}
                  <strong className="text-foreground">
                    {sorted.find((s) => s._id === confirmId)?.matchNumber ?? "?"}
                  </strong>{" "}
                  for team <strong className="text-foreground">{teamNumber}</strong>. This cannot be undone.
                </p>
                {(() => {
                  const sub = sorted.find((s) => s._id === confirmId);
                  if (!sub?.scoutId) return null;
                  const u = userMap[sub.scoutId];
                  if (!u) return null;
                  const displayName = u.name ?? u.email ?? "Unknown scout";
                  return (
                    <div className="flex items-center gap-2 pt-1 border-t border-border/50">
                      <span className="text-xs text-muted-foreground">Scouted by:</span>
                      {u.image
                        ? <img src={u.image} alt={displayName} className="h-5 w-5 rounded-full object-cover" />
                        : <span className="h-5 w-5 rounded-full bg-primary/20 text-primary text-[10px] flex items-center justify-center font-bold shrink-0">
                            {displayName.charAt(0).toUpperCase()}
                          </span>
                      }
                      <span className="text-xs font-medium text-foreground">{displayName}</span>
                      {u.email && u.name && (
                        <span className="text-xs text-muted-foreground">({u.email})</span>
                      )}
                    </div>
                  );
                })()}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {deleting ? "Deleting…" : "Delete Report"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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

interface TeamEpa {
  event: number | null;
  overall: number | null;
  auto: number | null;
  teleop: number | null;
  endgame: number | null;
}

function TeamRow({
  teamNumber,
  eventYear,
  submissions,
  epa,
  avgScore,
  tbaRank,
  fields,
  visibleColumns,
  onOpenDetail,
}: {
  teamNumber: number;
  eventYear: number;
  submissions: Submission[];
  epa: TeamEpa;
  avgScore: number | null;
  tbaRank: Record<string, unknown> | null;
  fields: FormField[];
  visibleColumns: Set<string>;
  onOpenDetail: () => void;
}) {
  const [textOpen, setTextOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);
  const { isAdminMode } = useUIStore();
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

  // Compute per-field stats
  const numericFields = fields.filter((f) => f.type === "number" || f.type === "counter" || f.type === "rating");
  const checkboxFields = fields.filter((f) => f.type === "checkbox");
  const selectFields = fields.filter((f) => f.type === "select");
  const textFields = fields.filter((f) => f.type === "text" || f.type === "textarea");
  const hasTextData = textFields.some((f) =>
    parsed.some((d) => d[f.id] && String(d[f.id]).trim() !== "")
  );

  // Build the ordered stat chips data (shared between mobile + desktop)
  const allStats: { label: string; value: string; color: "default" | "primary" | "success" | "muted" }[] = [
    { label: "Matches", value: String(submissions.length), color: submissions.length > 0 ? "default" : "muted" },
    { label: "Avg Score", value: avgScore !== null ? Number(avgScore.toFixed(0)).toString() : "—", color: avgScore !== null ? "default" : "muted" },
    { label: "Event EPA", value: epa.event !== null ? String(epa.event) : "—", color: epa.event !== null ? "primary" : "muted" },
    { label: "Season EPA", value: epa.overall !== null ? String(epa.overall) : "—", color: epa.overall !== null ? "primary" : "muted" },
    { label: "Auto", value: epa.auto !== null ? String(epa.auto) : "—", color: epa.auto !== null ? "default" : "muted" },
    { label: "Teleop", value: epa.teleop !== null ? String(epa.teleop) : "—", color: epa.teleop !== null ? "default" : "muted" },
    { label: "Endgame", value: epa.endgame !== null ? String(epa.endgame) : "—", color: epa.endgame !== null ? "default" : "muted" },
    ...numericFields.filter((f) => visibleColumns.has(f.id)).map((f) => {
      const av = avgNumeric(parsed, f.id);
      return { label: f.label, value: av === null ? "—" : (Number.isInteger(av) ? String(av) : av.toFixed(1)), color: (av === null ? "muted" : "default") as "default" | "muted" };
    }),
    ...checkboxFields.filter((f) => visibleColumns.has(f.id)).map((f) => {
      const pct = pctChecked(parsed, f.id);
      return { label: f.label, value: pct === null ? "—" : `${Math.round(pct)}%`, color: (pct === null ? "muted" : pct >= 50 ? "success" : "muted") as "default" | "primary" | "success" | "muted" };
    }),
    ...selectFields.filter((f) => visibleColumns.has(f.id)).map((f) => {
      const top = mostCommon(parsed, f.id);
      return { label: f.label, value: top ?? "—", color: (top ? "default" : "muted") as "default" | "muted" };
    }),
  ];

  const actionButtons = (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {submissions.length > 0 && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-primary"
          title="View & manage scouting reports"
          onClick={() => setReportsOpen(true)}
        >
          <ClipboardList className="h-3.5 w-3.5" />
        </Button>
      )}
      {hasTextData && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          title="View text notes"
          onClick={() => setTextOpen(true)}
        >
          <FileText className="h-3.5 w-3.5" />
        </Button>
      )}
      <a
        href={`https://www.statbotics.io/team/${teamNumber}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
        title="View on Statbotics"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );

  return (
    <>
      {/* ── Mobile card layout (hidden on sm+) ── */}
      <div
        className="sm:hidden border-b border-border px-3 py-3 hover:bg-muted/20 active:bg-muted/30 transition-colors cursor-pointer"
        onClick={onOpenDetail}
      >
        {/* Top row: avatar + team info + actions */}
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
          {actionButtons}
        </div>

        {/* Stats chips — wrap freely, no fixed columns */}
        <div className="mt-2.5 flex flex-wrap gap-x-2 gap-y-1.5">
          {allStats
            .filter((s) => s.value !== "—")
            .map((s) => (
              <StatChip key={s.label} label={s.label} value={s.value} color={s.color} />
            ))}
        </div>
      </div>

      {/* ── Desktop table row (hidden on mobile) ── */}
      <div
        className="hidden sm:flex items-center gap-3 px-4 py-3 border-b border-border hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={onOpenDetail}
      >
        {/* Avatar + team # */}
        <div className="flex items-center gap-2 w-32 shrink-0">
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

        {/* Stats columns — fixed grid so every cell always occupies the same slot */}
        <div className="flex-1 grid gap-x-4 gap-y-1 min-w-0 items-start"
          style={{
            gridTemplateColumns: [
              "56px",   // Matches
              "64px",   // Avg Score
              "64px",   // Event EPA
              "64px",   // Season EPA
              "48px",   // Auto
              "56px",   // Teleop
              "56px",   // Endgame
              ...numericFields.filter((f) => visibleColumns.has(f.id)).map(() => "minmax(52px, 96px)"),
              ...checkboxFields.filter((f) => visibleColumns.has(f.id)).map(() => "minmax(52px, 96px)"),
              ...selectFields.filter((f) => visibleColumns.has(f.id)).map(() => "minmax(52px, 96px)"),
            ].join(" "),
          }}
        >
          {allStats.map((s) => (
            <StatChip key={s.label} label={s.label} value={s.value} color={s.color} />
          ))}
        </div>

        {/* Actions */}
        <div className="shrink-0">
          {actionButtons}
        </div>
      </div>

      {/* Scouting reports viewer & delete */}
      <SubmissionsReviewDialog
        open={reportsOpen}
        onClose={() => setReportsOpen(false)}
        teamNumber={teamNumber}
        submissions={submissions}
        fields={fields}
        isAdminMode={isAdminMode}
      />

      {/* Text notes shortcut dialog */}
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

function ColumnHeader({ fields, visibleColumns }: { fields: FormField[]; visibleColumns: Set<string> }) {
  const numericFields = fields.filter((f) => (f.type === "number" || f.type === "counter" || f.type === "rating") && visibleColumns.has(f.id));
  const checkboxFields = fields.filter((f) => f.type === "checkbox" && visibleColumns.has(f.id));
  const selectFields = fields.filter((f) => f.type === "select" && visibleColumns.has(f.id));

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-muted/40 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sticky top-0">
      <div className="w-32 shrink-0">Team</div>
      <div className="flex-1 grid gap-x-4"
        style={{
          gridTemplateColumns: [
            "56px",   // Matches
            "64px",   // Avg Score
            "64px",   // Event EPA
            "64px",   // Season EPA
            "48px",   // Auto
            "56px",   // Teleop
            "56px",   // Endgame
            ...numericFields.map(() => "minmax(52px, 96px)"),
            ...checkboxFields.map(() => "minmax(52px, 96px)"),
            ...selectFields.map(() => "minmax(52px, 96px)"),
          ].join(" "),
        }}
      >
        <span>Matches</span>
        <span>Avg Score</span>
        <span>Event EPA</span>
        <span>Season EPA</span>
        <span>Auto</span>
        <span>Teleop</span>
        <span>Endgame</span>
        {numericFields.map((f) => (
          <span key={f.id} className="truncate" title={`avg ${f.label}`}>⏀ {f.label}</span>
        ))}
        {checkboxFields.map((f) => (
          <span key={f.id} className="truncate" title={`% ${f.label}`}>% {f.label}</span>
        ))}
        {selectFields.map((f) => (
          <span key={f.id} className="truncate" title={f.label}>↑ {f.label}</span>
        ))}
      </div>
      <div className="w-14 text-right">Links</div>
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
      .slice(0, 5);
  }, [assignments, matchData, nowMs]);

  const loading = assignmentsLive === undefined;

  return (
    <div className="rounded-xl border border-border bg-card flex flex-col h-full min-h-0">
      {/* Card header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2 border-b border-border shrink-0">
        <div className="h-6 w-6 rounded-md bg-primary/15 flex items-center justify-center">
          <CalendarCheck className="h-3.5 w-3.5 text-primary" />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">My Assignments</p>
        {!loading && assignments.length > 0 && (
          <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
            {upcoming.length} upcoming
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
        {loading ? (
          <div className="space-y-1.5 p-1">
            {[0,1,2].map((i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-2 rounded-lg">
                <div className="h-7 w-7 rounded-md bg-muted animate-pulse shrink-0" />
                <div className="space-y-1 flex-1">
                  <div className="h-2.5 w-14 bg-muted rounded animate-pulse" />
                  <div className="h-2 w-20 bg-muted rounded animate-pulse" />
                </div>
              </div>
            ))}
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

// ── Next 3 Matches (event-wide, Nexus-powered) ─────────────────────────────────

function NextThreeMatches({
  eventKey,
  matchData,
  epaMap,
  tbaRankings,
  nowMs,
}: {
  eventKey: string;
  matchData: TBAMatch[];
  epaMap: Record<number, TeamEpa>;
  tbaRankings: Record<number, Record<string, unknown>>;
  nowMs: number;
}) {
  // Next 3 unplayed matches across the whole event
  const next3 = useMemo(() => {
    return matchData
      .filter((m) => !isConsideredPlayed(m, nowMs))
      .sort((a, b) => (matchTime(a) ?? 9e12) - (matchTime(b) ?? 9e12))
      .slice(0, 3);
  }, [matchData, nowMs]);

  // Poll Nexus for each unique team in the next 3 matches
  const allTeamNums = useMemo(() => {
    const nums = new Set<number>();
    for (const m of next3) {
      for (const tk of [...m.alliances.red.team_keys, ...m.alliances.blue.team_keys]) {
        nums.add(Number(tk.replace("frc", "")));
      }
    }
    return [...nums];
  }, [next3]);

  const [nexusMap, setNexusMap] = useState<Record<number, NexusTeamStatus | null>>({});

  useEffect(() => {
    if (!eventKey || allTeamNums.length === 0) return;
    let cancelled = false;

    async function pollAll() {
      const results = await Promise.all(
        allTeamNums.map((tn) =>
          fetchNexusTeamStatus(eventKey, tn).then((s) => ({ tn, s }))
        )
      );
      if (cancelled) return;
      const map: Record<number, NexusTeamStatus | null> = {};
      for (const { tn, s } of results) map[tn] = s;
      setNexusMap(map);
    }

    pollAll();
    const id = setInterval(pollAll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [eventKey, allTeamNums.join(",")]);

  function rank(tn: number) {
    const r = tbaRankings[tn];
    return r ? (r as { rank: number }).rank : null;
  }

  // Loading skeleton — matchData not yet fetched
  const isLoading = matchData.length === 0;

  return (
    <div className="shrink-0 space-y-2">
      <div className="flex items-center gap-1.5">
        <Radio className="h-3.5 w-3.5 text-primary" />
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Next Matches On Field</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="h-3.5 w-10 bg-muted rounded animate-pulse" />
                <div className="h-3 w-12 bg-muted rounded animate-pulse" />
              </div>
              <div className="space-y-1.5">
                <div className="h-5 bg-muted/60 rounded animate-pulse" />
                <div className="h-5 bg-muted/40 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : next3.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border bg-card text-muted-foreground">
          <Radio className="h-4 w-4 shrink-0 opacity-40" />
          <p className="text-xs">No upcoming matches — all done or schedule not yet loaded.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {next3.map((match, idx) => {
            const t = matchTime(match);
            const ms = t ? t * 1000 - nowMs : null;
            const isFirst = idx === 0;
            const timeStr = t
              ? new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
              : null;

            return (
              <div
                key={match.key}
                className={`rounded-xl border p-3 flex flex-col gap-2 ${
                  isFirst
                    ? "border-primary/40 bg-primary/5"
                    : "border-border bg-card"
                }`}
              >
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {isFirst && <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />}
                    <p className="text-sm font-bold font-mono tracking-tight">{matchLabel(match)}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {isFirst && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30">NEXT</span>
                    )}
                    {timeStr && (
                      <span className="text-[10px] text-muted-foreground font-mono">{timeStr}</span>
                    )}
                    {ms !== null && ms > 0 && (
                      <span className={`text-[10px] font-mono tabular-nums ${
                        ms < 5 * 60_000 ? "text-red-400 font-bold" : "text-muted-foreground"
                      }`}>
                        {formatCountdown(ms)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Alliances */}
                {(["red", "blue"] as const).map((side) => (
                  <div key={side} className="flex items-center gap-1.5">
                    <span className={`text-[9px] font-bold uppercase tracking-widest w-5 shrink-0 ${
                      side === "red" ? "text-red-400" : "text-blue-400"
                    }`}>
                      {side === "red" ? "R" : "B"}
                    </span>
                    <div className="flex gap-1 flex-wrap">
                      {match.alliances[side].team_keys.map((tk) => {
                        const tn = Number(tk.replace("frc", ""));
                        const nx = nexusMap[tn];
                        const r = rank(tn);
                        const epa = epaMap[tn]?.event ?? null;
                        const isUs = tn === MY_TEAM;
                        const nxStatus = nx?.status?.toLowerCase() ?? "";
                        const onField = nxStatus.includes("onfield") || nxStatus.includes("field");
                        const onDeck = nxStatus.includes("ondeck") || nxStatus.includes("deck");
                        const queuing = nxStatus.includes("queu");

                        return (
                          <div
                            key={tk}
                            className={`flex flex-col items-center px-1.5 py-0.5 rounded-lg border min-w-[52px] relative ${
                              isUs
                                ? side === "red"
                                  ? "bg-red-500/15 border-red-400/50 ring-1 ring-red-400/50"
                                  : "bg-blue-500/15 border-blue-400/50 ring-1 ring-blue-400/50"
                                : side === "red"
                                  ? "bg-red-500/5 border-red-500/20"
                                  : "bg-blue-500/5 border-blue-500/20"
                            }`}
                          >
                            {r && <span className="text-[8px] text-muted-foreground">#{r}</span>}
                            <span className={`text-[11px] font-bold leading-tight ${
                              isUs ? "text-foreground" : "text-foreground/80"
                            }`}>
                              {tn}{isUs && <span className="text-yellow-400"> ★</span>}
                            </span>
                            {epa !== null && (
                              <span className="text-[8px] text-muted-foreground font-mono">{epa.toFixed(0)}</span>
                            )}
                            {(onField || onDeck || queuing) && (
                              <span className={`absolute -top-1 -right-1 h-2 w-2 rounded-full border border-background ${
                                onField ? "bg-green-400 animate-pulse" :
                                onDeck  ? "bg-yellow-400" :
                                          "bg-primary"
                              }`} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {match.alliances[side].score >= 0 && (
                      <span className="ml-auto text-sm font-bold tabular-nums">
                        {match.alliances[side].score}
                      </span>
                    )}
                  </div>
                ))}

                {match.alliances.red.team_keys.concat(match.alliances.blue.team_keys).some((tk) => {
                  const s = nexusMap[Number(tk.replace("frc", ""))]?.status?.toLowerCase() ?? "";
                  return s.includes("onfield") || s.includes("field") || s.includes("deck") || s.includes("queu");
                }) && (
                  <div className="flex items-center gap-1 pt-1 border-t border-border">
                    <Users2 className="h-3 w-3 text-muted-foreground" />
                    <div className="flex gap-1 flex-wrap">
                      {match.alliances.red.team_keys.concat(match.alliances.blue.team_keys).map((tk) => {
                        const tn = Number(tk.replace("frc", ""));
                        const nx = nexusMap[tn];
                        if (!nx) return null;
                        const s = nx.status.toLowerCase();
                        if (s.includes("noshow") || s === "" || s.includes("post") || s.includes("scoring")) return null;
                        return (
                          <span key={tk} className="text-[9px] font-semibold">
                            {tn}:{" "}
                            <span className={`${
                              s.includes("onfield") || s.includes("field") ? "text-green-400" :
                              s.includes("deck")   ? "text-yellow-400" :
                                                     "text-primary"
                            }`}>
                              {s.includes("onfield") || s.includes("field") ? "Field" :
                               s.includes("deck")   ? "Deck" : "Q"}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── TBA Key Warning Banner ─────────────────────────────────────────────────────

function TbaKeyWarningBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [hasKey, setHasKey] = useState(() => Boolean(getTBAKey()));

  // Re-check when localStorage changes (e.g. user saves key in another tab)
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "falconscout_api_key_tba") {
        setHasKey(Boolean(getTBAKey()));
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Also re-check periodically in case the key was set in this tab via Settings
  useEffect(() => {
    const id = setInterval(() => setHasKey(Boolean(getTBAKey())), 2000);
    return () => clearInterval(id);
  }, []);

  if (hasKey || dismissed) return null;

  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-500/40 bg-amber-500/8 text-amber-700 dark:text-amber-300 animate-in slide-in-from-top-2 duration-300">
      <KeyRound className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-snug">No TBA API key configured</p>
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
          Team lists, rankings, and match schedules won't load without a key.{" "}
          <a
            href="/settings"
            className="underline underline-offset-2 hover:text-amber-500 font-medium"
          >
            Add it in Settings →
          </a>
        </p>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 text-amber-500/70 hover:text-amber-500 transition-colors text-lg leading-none mt-0.5"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

// ── Dashboard Page ─────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const eventKey = currentEvent?.eventKey ?? "";

  const allSubmissionsLive = useQuery(
    api.forms.listSubmissions,
    eventKey ? { eventKey } : "skip"
  );
  const allSubmissions = useCached(allSubmissionsLive, `submissions_${eventKey}`);

  const activeTemplatesLive = useQuery(api.forms.listActiveTemplates);
  const activeTemplates = useCached(activeTemplatesLive, "active_templates");
  const fields: FormField[] = useMemo(() => {
    const tpls = activeTemplates as Array<{ formType?: string; fields: FormField[] }> | null;
    if (!tpls) return [];
    const defaultTpl = tpls.find((t) => (t.formType ?? "default") === "default");
    return ((defaultTpl ?? tpls[0])?.fields as FormField[]) ?? [];
  }, [activeTemplates]);

  // Pit scouting template + fields
  const pitTemplate = useMemo(() => {
    const tpls = activeTemplates as Array<{ _id: string; formType?: string; fields: FormField[] }> | null;
    return tpls?.find((t) => t.formType === "pit") ?? null;
  }, [activeTemplates]);
  const pitFields: FormField[] = (pitTemplate?.fields ?? []) as FormField[];

  // ── Seed external state from stale localStorage on first render ─────────────
  // This ensures the full team list & EPA data appear instantly on reload,
  // without waiting for the async loadExternal() fetch to complete.
  const [sbTeams, setSbTeams] = useState<Record<number, Record<string, unknown>>>(() =>
    (lsGetStale<Record<number, Record<string, unknown>>>(`dash_sbTeams_${eventKey ?? ""}`) ?? {})
  );
  const [sbOverall, setSbOverall] = useState<Record<number, number>>(() =>
    (lsGetStale<Record<number, number>>(`dash_sbOverall_${eventKey ?? ""}`) ?? {})
  );
  const [tbaTeams, setTbaTeams] = useState<number[]>(() =>
    (lsGetStale<number[]>(`dash_tbaTeams_${eventKey ?? ""}`) ?? [])
  );
  const [tbaRankings, setTbaRankings] = useState<Record<number, Record<string, unknown>>>(() =>
    (lsGetStale<Record<number, Record<string, unknown>>>(`dash_tbaRankings_${eventKey ?? ""}`) ?? {})
  );
  const [avgScoreByTeam, setAvgScoreByTeam] = useState<Record<number, number>>(() =>
    (lsGetStale<Record<number, number>>(`dash_avgScore_${eventKey ?? ""}`) ?? {})
  );
  const [matchData, setMatchData] = useState<TBAMatch[]>(() =>
    // Try dashboard-specific key first, fall back to the key written by fetchTBAEventMatches
    (lsGetStale<TBAMatch[]>(`dash_matches_${eventKey ?? ""}`) ??
     lsGetStale<TBAMatch[]>(`tba_matches_${eventKey ?? ""}`) ?? [])
  );
  // Track which eventKey the state was seeded for; re-seed when it changes
  const seededEventKeyRef = useRef<string>("");
  // True while loadExternal() is in-flight (no cached TBA data yet)
  const [loadingExternal, setLoadingExternal] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now());
  const [search, setSearch] = useState("");
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const eventYear = eventKey ? Number(eventKey.slice(0, 4)) : new Date().getFullYear();

  // ── Column visibility — stored as HIDDEN set so new fields are visible by default ──
  // Load once when eventKey is available. Save happens inside user actions (never on mount)
  // so there is no race where the initial empty state overwrites saved prefs.
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!eventKey) return;
    try {
      const saved = localStorage.getItem(`falconscout_hidden_cols_${eventKey}`);
      setHiddenColumns(saved ? new Set(JSON.parse(saved) as string[]) : new Set());
    } catch { setHiddenColumns(new Set()); }
  }, [eventKey]);

  // Derived: a field is visible when it is NOT in hiddenColumns
  const visibleColumns = useMemo(
    () => new Set(fields.filter((f) => !hiddenColumns.has(f.id)).map((f) => f.id)),
    [fields, hiddenColumns]
  );

  // Save helper — called explicitly after every user action, never automatically
  function persistHidden(next: Set<string>) {
    if (!eventKey) return;
    try {
      localStorage.setItem(`falconscout_hidden_cols_${eventKey}`, JSON.stringify([...next]));
    } catch { /* ignore */ }
  }

  function toggleColumn(id: string) {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      persistHidden(next);
      return next;
    });
  }

  // Live 1-second ticker for countdowns
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── EPA helpers ──────────────────────────────────────────────────────────────────

  /** Extract mean from a {mean, sd} leaf, or a bare number. */
  function readMean(v: unknown): number | null {
    if (typeof v === "number") return Number(v.toFixed(1));
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.mean === "number") return Number((o.mean as number).toFixed(1));
    }
    return null;
  }

  /** Recursively search EPA object for any of the named keys and return its mean.
   *  Handles both flat (epa.auto_points) and nested (epa.breakdown.auto_points) structures. */
  function findInEpa(obj: unknown, ...keys: string[]): number | null {
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    for (const key of keys) {
      if (key in o) {
        const m = readMean(o[key]);
        if (m !== null) return m;
      }
    }
    // Recurse into sub-objects (bounded by depth — plain objects only, skip arrays)
    for (const val of Object.values(o)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const found = findInEpa(val, ...keys);
        if (found !== null) return found;
      }
    }
    return null;
  }

  /** Total / event EPA: prefer total_points > mean directly on the epa object. */
  function totalEpa(epaObj: Record<string, unknown>): number | null {
    return (
      findInEpa(epaObj, "total_points", "total") ??
      readMean(epaObj)
    );
  }

  // Re-seed state maps whenever eventKey changes (e.g. user switches event in Settings)
  useEffect(() => {
    if (!eventKey || seededEventKeyRef.current === eventKey) return;
    seededEventKeyRef.current = eventKey;
    setSbTeams(lsGetStale<Record<number, Record<string, unknown>>>(`dash_sbTeams_${eventKey}`) ?? {});
    setSbOverall(lsGetStale<Record<number, number>>(`dash_sbOverall_${eventKey}`) ?? {});
    setTbaTeams(lsGetStale<number[]>(`dash_tbaTeams_${eventKey}`) ?? []);
    setTbaRankings(lsGetStale<Record<number, Record<string, unknown>>>(`dash_tbaRankings_${eventKey}`) ?? {});
    setAvgScoreByTeam(lsGetStale<Record<number, number>>(`dash_avgScore_${eventKey}`) ?? {});
    setMatchData(lsGetStale<TBAMatch[]>(`dash_matches_${eventKey}`) ?? []);
  }, [eventKey]);

  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    setLoadingExternal(true);

    async function loadExternal() {
      const [sbData, tbaTeamData, tbaRankData, matchData] = await Promise.all([
        fetchStatboticsEventTeams(eventKey),
        fetchTBAEventTeams(eventKey),
        fetchTBAEventRankings(eventKey),
        fetchTBAEventMatches(eventKey),
      ]);
      if (cancelled) return;

      // Statbotics per-team event EPA
      if (Array.isArray(sbData)) {
        const map: Record<number, Record<string, unknown>> = {};
        for (const t of sbData as Array<{ team: number } & Record<string, unknown>>) {
          map[t.team] = t;
        }
        setSbTeams(map);
        // Persist transformed map so it can be seeded next render
        lsSet(`dash_sbTeams_${eventKey}`, map, TTL.SHORT);

        // Also fetch overall (season) EPA for all teams — one batch request instead of N individual calls
        const eventTeamSet = new Set((sbData as Array<{ team: number }>).map((t) => t.team));
        fetchStatboticsTeamYearsBatch(eventYear).then((allYears) => {
          if (cancelled) return;
          if (!Array.isArray(allYears)) return;
          const overall: Record<number, number> = {};
          for (const d of allYears as Array<{ team: number; epa: unknown }>) {
            if (!eventTeamSet.has(d.team)) continue; // only care about teams at this event
            if (d.epa && typeof d.epa === "object") {
              const epaO = d.epa as Record<string, unknown>;
              const v = totalEpa(epaO) ?? findInEpa(epaO, "total_points", "total");
              if (v !== null) overall[d.team] = v;
            }
          }
          setSbOverall(overall);
          lsSet(`dash_sbOverall_${eventKey}`, overall, TTL.SHORT);
        }).catch(() => {/* ignore */});
      }

      if (Array.isArray(tbaTeamData)) {
        const nums = (tbaTeamData as Array<{ team_number: number }>).map((t) => t.team_number);
        setTbaTeams(nums);
        lsSet(`dash_tbaTeams_${eventKey}`, nums, TTL.MEDIUM);
        // Prime avatar memory cache for all event teams in the background
        for (const num of nums) primeAvatar(num, eventYear);
      }

      if (tbaRankData && typeof tbaRankData === "object" && "rankings" in tbaRankData) {
        const map: Record<number, Record<string, unknown>> = {};
        for (const r of (
          tbaRankData as { rankings: Array<{ team_key: string } & Record<string, unknown>> }
        ).rankings) {
          const num = Number(r.team_key.replace("frc", ""));
          map[num] = r;
        }
        setTbaRankings(map);
        lsSet(`dash_tbaRankings_${eventKey}`, map, TTL.SHORT);
      }

      // Per-team average qual score from TBA match results
      if (Array.isArray(matchData)) {
        const totals: Record<number, { sum: number; count: number }> = {};
        for (const match of matchData) {
          // Only count qual matches; score of -1 means the match hasn't been played
          if (match.comp_level !== "qm") continue;
          for (const color of ["red", "blue"] as const) {
            const alliance = match.alliances[color];
            if (!alliance || alliance.score < 0) continue;
            for (const teamKey of alliance.team_keys) {
              const num = Number(teamKey.replace("frc", ""));
              if (!num) continue;
              if (!totals[num]) totals[num] = { sum: 0, count: 0 };
              totals[num].sum += alliance.score;
              totals[num].count += 1;
            }
          }
        }
        const avgMap: Record<number, number> = {};
        for (const [team, { sum, count }] of Object.entries(totals)) {
          if (count > 0) avgMap[Number(team)] = Math.round(sum / count);
        }
        setAvgScoreByTeam(avgMap);
        lsSet(`dash_avgScore_${eventKey}`, avgMap, TTL.SHORT);
        // Store full match list for schedule tab and next-match banner
        setMatchData(matchData as TBAMatch[]);
        lsSet(`dash_matches_${eventKey}`, matchData, TTL.SHORT);
      }
      if (!cancelled) setLoadingExternal(false);
    }

    loadExternal().catch(() => { if (!cancelled) setLoadingExternal(false); });
    return () => { cancelled = true; };
  }, [eventKey]);

  // Build a per-team EPA map for the schedule / banner components
  const epaMap = useMemo(() => {
    const map: Record<number, TeamEpa> = {};
    for (const [num, sb] of Object.entries(sbTeams)) {
      const epaObj = sb && "epa" in sb ? sb.epa as Record<string, unknown> : null;
      map[Number(num)] = {
        event:   epaObj ? totalEpa(epaObj) : null,
        overall: sbOverall[Number(num)] ?? null,
        auto:    epaObj ? findInEpa(epaObj, "auto_points", "auto") : null,
        teleop:  epaObj ? findInEpa(epaObj, "teleop_points", "teleop") : null,
        endgame: epaObj ? findInEpa(epaObj, "endgame_points", "endgame") : null,
      };
    }
    return map;
  }, [sbTeams, sbOverall]);

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

  // Build team list
  const scoutedTeams = new Set(
    (allSubmissions ?? []).map((s: { teamNumber: number }) => s.teamNumber)
  );
  const allTeams = Array.from(new Set([...tbaTeams, ...scoutedTeams])).sort(
    (a, b) => (a as number) - (b as number)
  );

  const submissionsByTeam = (allSubmissions ?? []).reduce<
    Record<number, Submission[]>
  >((acc, s: Submission) => {
    // Only include non-pit submissions in the match scouting view
    if (pitTemplate && s.templateId === pitTemplate._id) return acc;
    acc[s.teamNumber] = [...(acc[s.teamNumber] ?? []), s];
    return acc;
  }, {});

  // Pit submissions grouped by team
  const pitSubmissionsByTeam = useMemo(() => {
    if (!pitTemplate) return {} as Record<number, Submission[]>;
    return (allSubmissions ?? []).reduce<Record<number, Submission[]>>((acc, s: Submission) => {
      if (s.templateId !== pitTemplate._id) return acc;
      acc[s.teamNumber] = [...(acc[s.teamNumber] ?? []), s];
      return acc;
    }, {});
  }, [allSubmissions, pitTemplate]);

  const filtered = allTeams.filter((t) =>
    search ? String(t).includes(search) : true
  );

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
      <TbaKeyWarningBanner />

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
          {/* ── Bento top row: Next Match (2/3) + My Assignments sidebar (1/3) ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 shrink-0 items-stretch">
            {/* Next match banner — spans 2 cols on desktop, stretches full height */}
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
            {/* My scouting assignments sidebar */}
            <div className="lg:col-span-1 min-h-[160px] max-h-[260px] lg:max-h-none">
              <MyScouting
                eventKey={eventKey}
                matchData={matchData}
                nowMs={nowMs}
              />
            </div>
          </div>

          {/* ── Next 3 event matches (Nexus-powered) ── */}
          <NextThreeMatches
            eventKey={eventKey}
            matchData={matchData}
            epaMap={epaMap}
            tbaRankings={tbaRankings}
            nowMs={nowMs}
          />

          {/* Search + column picker */}
          <div className="relative shrink-0 flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search by team number…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="relative">
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={() => setShowColumnPicker((v) => !v)}
                title="Choose visible columns"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </Button>

              {/* Column picker dropdown */}
              {showColumnPicker && (
                <div className="absolute right-0 top-full mt-1 z-30 bg-popover border border-border rounded-xl shadow-xl p-3 min-w-[220px] space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-2">Visible columns</p>
                  {fields.filter((f) => ["number","counter","rating","checkbox","select"].includes(f.type)).map((f) => (
                    <label key={f.id} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-muted cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={!hiddenColumns.has(f.id)}
                        onChange={() => toggleColumn(f.id)}
                        className="accent-primary"
                      />
                      <span className="truncate">{f.label}</span>
                    </label>
                  ))}
                  {fields.filter((f) => ["number","counter","rating","checkbox","select"].includes(f.type)).length === 0 && (
                    <p className="text-xs text-muted-foreground px-1">No columnar fields yet.</p>
                  )}
                  <div className="pt-1 flex gap-1">
                    <button
                      className="text-[10px] text-primary hover:underline"
                      onClick={() => {
                        const next = new Set<string>();
                        setHiddenColumns(next);
                        persistHidden(next);
                      }}
                    >All</button>
                    <span className="text-muted-foreground text-[10px]">·</span>
                    <button
                      className="text-[10px] text-muted-foreground hover:underline"
                      onClick={() => {
                        const next = new Set(fields.map((f) => f.id));
                        setHiddenColumns(next);
                        persistHidden(next);
                      }}
                    >None</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {fields.length === 0 && (
            <p className="text-xs text-amber-500 dark:text-amber-400 shrink-0">
              ⚠ No active scouting form — columns will appear once a form template is active.
            </p>
          )}

          <div className="flex-1 bg-card border border-border rounded-xl overflow-hidden flex flex-col min-h-0">
            {/* Column header — desktop only (mobile uses card layout) */}
            <div className="hidden sm:block overflow-x-auto shrink-0">
              <div className="min-w-[540px]">
                <ColumnHeader fields={fields} visibleColumns={visibleColumns} />
              </div>
            </div>

            <ScrollArea className="flex-1">
              {/* Desktop table rows */}
              <div className="hidden sm:block min-w-[540px]">
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
                ) : filtered.length === 0 ? (
                  <p className="text-center py-12 text-muted-foreground text-sm">
                    {search ? "No teams match your search." : "No teams found for this event."}
                  </p>
                ) : (
                  filtered.map((teamNumber) => {
                    const teamEpa = epaMap[teamNumber as number] ?? {
                      event: null, overall: null, auto: null, teleop: null, endgame: null,
                    };
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
                        visibleColumns={visibleColumns}
                        onOpenDetail={() => setSelectedTeam(teamNumber as number)}
                      />
                    );
                  })
                )}
              </div>

              {/* Mobile card list */}
              <div className="sm:hidden">
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
                ) : filtered.length === 0 ? (
                  <p className="text-center py-12 text-muted-foreground text-sm px-4">
                    {search ? "No teams match your search." : "No teams found for this event."}
                  </p>
                ) : (
                  filtered.map((teamNumber) => {
                    const teamEpa = epaMap[teamNumber as number] ?? {
                      event: null, overall: null, auto: null, teleop: null, endgame: null,
                    };
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
                        visibleColumns={visibleColumns}
                        onOpenDetail={() => setSelectedTeam(teamNumber as number)}
                      />
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>
        </>
      )}

      {/* Team detail panel */}
      {selectedTeam !== null && (() => {
        const teamEpa = epaMap[selectedTeam] ?? { event: null, overall: null, auto: null, teleop: null, endgame: null };
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
            onClose={() => setSelectedTeam(null)}
          />
        );
      })()}
    </div>
  );
}
