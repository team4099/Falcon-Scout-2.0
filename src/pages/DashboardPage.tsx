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
  fetchStatboticsTeamYear,
  fetchTBAEventTeams,
  fetchTBAEventRankings,
  fetchTBAEventMatches,
  fetchTBATeamAvatar,
  fetchTBATeamInfo,
} from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import { ExternalLink, Search, FileText, TrendingUp, ClipboardList, Trash2, AlertTriangle, ChevronDown, ChevronUp, Clock, SlidersHorizontal } from "lucide-react";
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

  return (
    <>
      <div
        className="flex items-center gap-3 px-4 py-3 border-b border-border hover:bg-muted/30 transition-colors cursor-pointer"
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

        {/* Stats columns */}
        <div className="flex-1 flex flex-wrap gap-x-4 gap-y-1 min-w-0">
          {/* Scouted count — always shown so columns stay aligned */}
          <StatChip
            label="Matches"
            value={String(submissions.length)}
            color={submissions.length > 0 ? "default" : "muted"}
          />

          {/* Average score from TBA */}
          {avgScore !== null && (
            <StatChip label="Avg Score" value={Number(avgScore.toFixed(0)).toString()} color="default" />
          )}

          {/* Event EPA */}
          {epa.event !== null && (
            <StatChip label="Event EPA" value={String(epa.event)} color="primary" />
          )}

          {/* Overall / season EPA */}
          {epa.overall !== null && (
            <StatChip label="Season EPA" value={String(epa.overall)} color="primary" />
          )}

          {/* Auto EPA */}
          {epa.auto !== null && (
            <StatChip label="Auto" value={String(epa.auto)} color="default" />
          )}

          {/* Teleop EPA */}
          {epa.teleop !== null && (
            <StatChip label="Teleop" value={String(epa.teleop)} color="default" />
          )}

          {/* Endgame EPA */}
          {epa.endgame !== null && (
            <StatChip label="Endgame" value={String(epa.endgame)} color="default" />
          )}

          {/* Numeric / counter / rating → average, shown based on visibleColumns */}
          {numericFields.filter((f) => visibleColumns.has(f.id)).map((f) => {
            const av = avgNumeric(parsed, f.id);
            return (
              <StatChip
                key={f.id}
                label={f.label}
                value={av === null ? "N/A" : (Number.isInteger(av) ? String(av) : av.toFixed(1))}
                color={av === null ? "muted" : "default"}
              />
            );
          })}

          {/* Checkbox → % checked, shown based on visibleColumns */}
          {checkboxFields.filter((f) => visibleColumns.has(f.id)).map((f) => {
            const pct = pctChecked(parsed, f.id);
            if (pct === null) return null;
            return (
              <StatChip
                key={f.id}
                label={f.label}
                value={`${Math.round(pct)}%`}
                color={pct >= 50 ? "success" : "muted"}
              />
            );
          })}

          {/* Select → most common, shown based on visibleColumns */}
          {selectFields.filter((f) => visibleColumns.has(f.id)).map((f) => {
            const top = mostCommon(parsed, f.id);
            if (!top) return null;
            return (
              <StatChip key={f.id} label={f.label} value={top} color="default" />
            );
          })}

        </div>

        {/* Actions — stop propagation so buttons don't open the panel */}
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* All reports — always shown if any submissions exist */}
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
          {/* Text notes shortcut */}
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
      <div className="flex-1 flex flex-wrap gap-x-4 gap-y-0">
        <span className="w-14">Matches</span>
        <span className="w-16">Avg Score</span>
        <span className="w-16">Event EPA</span>
        <span className="w-16">Season EPA</span>
        <span className="w-10">Auto</span>
        <span className="w-12">Teleop</span>
        <span className="w-12">Endgame</span>
        {numericFields.map((f) => (
          <span key={f.id} className="truncate max-w-[96px]" title={`avg ${f.label}`}>⏀ {f.label}</span>
        ))}
        {checkboxFields.map((f) => (
          <span key={f.id} className="truncate max-w-[96px]" title={`% ${f.label}`}>
            % {f.label}
          </span>
        ))}
        {selectFields.map((f) => (
          <span key={f.id} className="truncate max-w-[96px]" title={f.label}>
            ↑ {f.label}
          </span>
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
  const allDone = all4099.length > 0 && all4099.every(isPlayed);
  const noneScheduled = all4099.length === 0 && matchData.length > 0;

  // ── No upcoming match states ──────────────────────────────────────────────
  if (!match || (!isToday && !isFuture)) {
    return (
      <div className="rounded-xl border border-border bg-card p-3 sm:p-4 flex items-center gap-3">
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
      <div className="rounded-xl border border-border bg-card p-3 sm:p-4 flex items-center gap-3">
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
    <div className={`rounded-xl border bg-card p-3 sm:p-4 flex flex-col sm:flex-row gap-3 sm:gap-6 items-start sm:items-center transition-colors ${
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
    (lsGetStale<TBAMatch[]>(`dash_matches_${eventKey ?? ""}`) ?? [])
  );
  // Track which eventKey the state was seeded for; re-seed when it changes
  const seededEventKeyRef = useRef<string>("");
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

        // Also fetch overall (season) EPA for each team in the background
        const teams = (sbData as Array<{ team: number }>).map((t) => t.team);
        Promise.all(
          teams.map((tn) =>
            fetchStatboticsTeamYear(tn, eventYear).then((d) => ({ tn, d }))
          )
        ).then((results) => {
          if (cancelled) return;
          const overall: Record<number, number> = {};
          for (const { tn, d } of results) {
            if (d && typeof d === "object" && "epa" in d) {
              const epaO = (d as Record<string, unknown>).epa as Record<string, unknown>;
              const v = totalEpa(epaO) ?? findInEpa(epaO, "total_points", "total");
              if (v !== null) overall[tn] = v;
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
    }

    loadExternal();
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
      .filter((m) => !isPlayed(m))
      .filter(
        (m) =>
          m.alliances.red.team_keys.includes(`frc${MY_TEAM}`) ||
          m.alliances.blue.team_keys.includes(`frc${MY_TEAM}`)
      )
      .sort((a, b) => (matchTime(a) ?? 9e12) - (matchTime(b) ?? 9e12));
    return unplayed[0] ?? null;
  }, [matchData]);

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
          {/* Persistent next-match banner — always visible when event is set */}
          <NextMatchBanner
            match={nextMatch}
            eventKey={eventKey}
            matchData={matchData}
            nowMs={nowMs}
            epaMap={epaMap}
            tbaRankings={tbaRankings}
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
            <div className="overflow-x-auto shrink-0">
              <div className="min-w-[480px]">
                <ColumnHeader fields={fields} visibleColumns={visibleColumns} />
              </div>
            </div>
            <ScrollArea className="flex-1">
              <div className="min-w-[480px]">
                {filtered.length === 0 ? (
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
