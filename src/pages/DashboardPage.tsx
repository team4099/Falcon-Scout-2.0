import { useState, useEffect, useMemo, useRef } from "react";
import { useUIStore } from "@/store/uiStore";
import { useQuery } from "convex/react";
import { useAdminMutation } from "@/hooks/useAdminMutation";
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
  getCacheError,
  statboticsEventTeamsCacheKey,
} from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import { EMPTY_TEAM_EPA, parseEpaComponents, totalEpa } from "@/lib/epa";
import type { TeamEpa } from "@/lib/epa";
import { ExternalLink, Search, FileText, TrendingUp, ClipboardList, Trash2, AlertTriangle, ChevronDown, ChevronUp, Clock, CalendarCheck, Trophy, CalendarDays, Rows3, Table2 } from "lucide-react";
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
  const deleteSubmission = useAdminMutation(api.forms.deleteSubmission);
  const allUsersLive = useQuery(api.users.listUsers);
  const allUsers = useCached(allUsersLive, "all_users");
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
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
                                ? <img src={u.image} alt={displayName} referrerPolicy="no-referrer" className="h-4 w-4 rounded-full object-cover" />
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
              This will permanently remove Match{" "}
              {sorted.find((s) => s._id === confirmId)?.matchNumber ?? "?"} for team{" "}
              {teamNumber}. This cannot be undone.
            </AlertDialogDescription>
            {(() => {
              const sub = sorted.find((s) => s._id === confirmId);
              if (!sub?.scoutId) return null;
              const u = userMap[sub.scoutId];
              if (!u) return null;
              const displayName = u.name ?? u.email ?? "Unknown scout";
              return (
                <div className="flex items-center gap-2 pt-2 mt-1 border-t border-border/50 text-sm">
                  <span className="text-xs text-muted-foreground">Scouted by:</span>
                  {u.image
                    ? <img src={u.image} alt={displayName} referrerPolicy="no-referrer" className="h-5 w-5 rounded-full object-cover" />
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

function TeamRow({
  teamNumber,
  eventYear,
  submissions,
  epa,
  avgScore,
  tbaRank,
  fields,
  onOpenDetail,
  forceTable = false,
}: {
  teamNumber: number;
  eventYear: number;
  submissions: Submission[];
  epa: TeamEpa;
  avgScore: number | null;
  tbaRank: Record<string, unknown> | null;
  fields: FormField[];
  onOpenDetail: () => void;
  /** When true, always render the column-table row layout, even below the
   *  sm breakpoint — used for the mobile "table view" toggle. */
  forceTable?: boolean;
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

  // Text fields drive the "view notes" shortcut; the table itself has a fixed
  // set of columns and never renders per-field aggregates.
  const textFields = fields.filter((f) => f.type === "text" || f.type === "textarea");
  const hasTextData = textFields.some((f) =>
    parsed.some((d) => d[f.id] && String(d[f.id]).trim() !== "")
  );

  // Build the ordered stat chips data (shared between mobile + desktop)
  const allStats: { label: string; value: string; color: "default" | "primary" | "success" | "muted" }[] = [
    { label: "Rank", value: rank !== null ? `#${rank}` : "—", color: rank !== null ? "default" : "muted" },
    { label: "Avg Score", value: avgScore !== null ? Number(avgScore.toFixed(0)).toString() : "—", color: avgScore !== null ? "default" : "muted" },
    { label: "Event EPA", value: epa.event !== null ? String(epa.event) : "—", color: epa.event !== null ? "primary" : "muted" },
    { label: "Season EPA", value: epa.overall !== null ? String(epa.overall) : "—", color: epa.overall !== null ? "primary" : "muted" },
    { label: "Auto", value: epa.auto !== null ? String(epa.auto) : "—", color: epa.auto !== null ? "default" : "muted" },
    { label: "Teleop", value: epa.teleop !== null ? String(epa.teleop) : "—", color: epa.teleop !== null ? "default" : "muted" },
    { label: "Endgame", value: epa.endgame !== null ? String(epa.endgame) : "—", color: epa.endgame !== null ? "default" : "muted" },
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
      {/* ── Mobile card layout (hidden on sm+, and hidden below sm when forceTable is on) ── */}
      <div
        className={`${forceTable ? "hidden" : "block"} sm:hidden border-b border-border px-3 py-3 hover:bg-muted/20 active:bg-muted/30 transition-colors cursor-pointer`}
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

        {/* Stats columns — fixed grid so every cell always occupies the same slot */}
        <div className="flex-1 grid gap-x-4 gap-y-1 min-w-0 items-start"
          style={{
            gridTemplateColumns: [
              "minmax(56px, 1fr)",   // Matches
              "minmax(72px, 1fr)",   // Avg Score
              "minmax(72px, 1fr)",   // Event EPA
              "minmax(84px, 1fr)",   // Season EPA — widest header label ("Season EPA")
              "minmax(48px, 1fr)",   // Auto
              "minmax(56px, 1fr)",   // Teleop
              "minmax(64px, 1fr)",   // Endgame
            ].join(" "),
          }}
        >
          {allStats.map((s) => (
            <StatChip key={s.label} label={s.label} value={s.value} color={s.color} />
          ))}
        </div>

        {/* Actions — fixed width matching the header's Links column so every
            row occupies the same total width, regardless of how many action
            icons it has, keeping columns aligned across all rows. */}
        <div className="w-24 shrink-0 flex items-center justify-end">
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

function ColumnHeader({
  sortKey, sortDir, onSort,
}: {
  sortKey: string | null;
  sortDir: "asc" | "desc";
  onSort: (key: string) => void;
}) {
  // A header cell that sorts. The caret only renders on the active column, so
  // the header stays quiet until you actually sort by something.
  const Th = ({ id, label, title, className = "" }: {
    id: string; label: string; title?: string; className?: string;
  }) => {
    const active = sortKey === id;
    return (
      <button
        type="button"
        onClick={() => onSort(id)}
        title={title ?? `Sort by ${label}`}
        aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
        className={`flex items-center gap-0.5 text-left uppercase tracking-wider font-semibold transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm ${
          active ? "text-foreground" : ""
        } ${className}`}
      >
        <span className="truncate">{label}</span>
        {active && <span aria-hidden className="shrink-0">{sortDir === "asc" ? "▲" : "▼"}</span>}
      </button>
    );
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-muted/40 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sticky top-0">
      <div className="w-36 shrink-0 sticky left-0 z-10 -ml-4 pl-4 bg-card">
        <Th id="team" label="Team" />
      </div>
      <div className="flex-1 grid gap-x-4"
        style={{
          gridTemplateColumns: [
            "minmax(56px, 1fr)",   // Rank
            "minmax(72px, 1fr)",   // Avg Score
            "minmax(72px, 1fr)",   // Event EPA
            "minmax(84px, 1fr)",   // Season EPA — widest header label ("Season EPA")
            "minmax(48px, 1fr)",   // Auto
            "minmax(56px, 1fr)",   // Teleop
            "minmax(64px, 1fr)",   // Endgame
          ].join(" "),
        }}
      >
        <Th id="rank"       label="Rank" title="Sort by event ranking" />
        <Th id="avgScore"   label="Avg Score" />
        <Th id="epaEvent"   label="Event EPA" />
        <Th id="epaOverall" label="Season EPA" />
        <Th id="epaAuto"    label="Auto" />
        <Th id="epaTeleop"  label="Teleop" />
        <Th id="epaEndgame" label="Endgame" />
      </div>
      <div className="w-24 text-right">Links</div>
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

/** How many statbotics season-EPA requests to have in flight at once. Their
 *  API docs ask consumers not to hammer the servers. */
const SB_FETCH_CONCURRENCY = 6;

export default function DashboardPage() {
  const syncRoster = useMutation(api.forms.syncEventTeamRoster);
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
    // Try dashboard-specific key first, fall back to the key written by
    // fetchTBAEventMatches — which is `tba_matches_full_`, not `tba_matches_`.
    // The old fallback named a key nothing writes, so it never fired.
    (lsGetStale<TBAMatch[]>(`dash_matches_${eventKey ?? ""}`) ??
     lsGetStale<TBAMatch[]>(`tba_matches_full_${eventKey ?? ""}`) ?? [])
  );
  // Track which eventKey the state was seeded for; re-seed when it changes
  const seededEventKeyRef = useRef<string>("");
  // True while loadExternal() is in-flight (no cached TBA data yet)
  const [loadingExternal, setLoadingExternal] = useState(true);
  // Non-null when the statbotics EPA fetch failed upstream, so the empty
  // EPA columns can explain themselves instead of looking like an app bug.
  const [sbError, setSbError] = useState<{ status: number } | null>(null);
  // Lazy initializer: Date.now() must not run during render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [search, setSearch] = useState("");
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);
  const eventYear = eventKey ? Number(eventKey.slice(0, 4)) : new Date().getFullYear();

  // The rankings table has a fixed column set (Team / Rank / Avg Score / Event
  // EPA / Season EPA / Auto / Teleop / Endgame / Links) — no per-form columns,
  // so there is nothing to show or hide.
  // Active sort column, or null for the natural (team-number) order.
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Mobile only: lets scouts flip from the stacked card list to the same
  // scrollable column table desktop sees, so they can sort by rank/EPA/etc.
  const [mobileTableView, setMobileTableView] = useState(false);

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

  // EPA parsing helpers live in @/lib/epa (unit-tested against real
  // statbotics v3 payload shapes in src/lib/epa.test.ts).

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

      // Statbotics per-team event EPA.
      // An empty array is a real answer ("statbotics has no rows for this
      // event"); a null/absent one means the request failed. Surface the
      // upstream error either way so empty EPA columns are explainable
      // instead of looking like a bug in this app.
      const sbErr = getCacheError(statboticsEventTeamsCacheKey(eventKey));
      setSbError(!Array.isArray(sbData) || sbData.length === 0 ? sbErr : null);

      if (Array.isArray(sbData) && sbData.length > 0) {
        const map: Record<number, Record<string, unknown>> = {};
        for (const t of sbData as Array<{ team: number } & Record<string, unknown>>) {
          map[t.team] = t;
        }
        setSbTeams(map);
        // Persist transformed map so it can be seeded next render
        lsSet(`dash_sbTeams_${eventKey}`, map, TTL.SHORT);
      }

      if (Array.isArray(tbaTeamData)) {
        const nums = (tbaTeamData as Array<{ team_number: number }>).map((t) => t.team_number);
        setTbaTeams(nums);
        lsSet(`dash_tbaTeams_${eventKey}`, nums, TTL.MEDIUM);
        // Sync the roster to Convex so the backend can validate team numbers
        syncRoster({ eventKey, teamNumbers: nums }).catch(() => {});
        // Prime avatar memory cache for all event teams in the background
        for (const num of nums) primeAvatar(num, eventYear);

        // Fetch overall (season) EPA for every team on the roster. Keyed off
        // the TBA roster rather than Statbotics' own event_teams rows: those
        // rows don't exist until Statbotics has processed this event (e.g. it
        // hasn't started yet), but season EPA is available per-team the whole
        // time, so gating it on event-level data left it blank for no reason.
        //
        // Statbotics' /team_years batch endpoint holds thousands of rows for
        // a given year but caps `limit` at 1000, silently dropping most teams
        // from a single page — fetch per-team instead, bounded by the event
        // roster (~40-80 teams), which is always accurate.
        //
        // Run these a few at a time: statbotics asks API users not to hammer
        // their servers, and a 80-wide parallel burst is exactly that.
        void (async () => {
          const overall: Record<number, number> = {};
          for (let i = 0; i < nums.length; i += SB_FETCH_CONCURRENCY) {
            if (cancelled) return;
            const batch = nums.slice(i, i + SB_FETCH_CONCURRENCY);
            const results = await Promise.all(
              batch.map((team) =>
                fetchStatboticsTeamYear(team, eventYear).catch(() => null)
              )
            );
            for (const d of results) {
              if (!d || typeof d !== "object") continue;
              const v = totalEpa((d as { epa?: unknown }).epa);
              if (v !== null) overall[(d as { team: number }).team] = v;
            }
          }
          if (cancelled) return;
          setSbOverall(overall);
          lsSet(`dash_sbOverall_${eventKey}`, overall, TTL.SHORT);
        })();
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

  // Build a per-team EPA map for the schedule / banner components.
  //
  // Keyed off the union of sbTeams and sbOverall, not just sbTeams: for an
  // event Statbotics hasn't processed yet (upcoming event, no matches played),
  // sbTeams is empty but sbOverall — each team's season EPA, fetched
  // independently of event-level rows — is already populated. Iterating
  // sbTeams alone silently dropped every team's season EPA in that case, even
  // though it was fetched successfully and sitting in state.
  const epaMap = useMemo(() => {
    const map: Record<number, TeamEpa> = {};
    const teamNums = new Set([
      ...Object.keys(sbTeams).map(Number),
      ...Object.keys(sbOverall).map(Number),
    ]);
    for (const num of teamNums) {
      const sb = sbTeams[num];
      const epaObj = sb && "epa" in sb ? sb.epa : null;
      map[num] = {
        ...parseEpaComponents(epaObj),
        overall: sbOverall[num] ?? null,
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

  // Build team list — exclude teamNumber === 0 (checklist submissions)
  const scoutedTeams = new Set(
    (allSubmissions ?? [])
      .map((s: { teamNumber: number }) => s.teamNumber)
      .filter((n: number) => n > 0)
  );
  const allTeams = Array.from(new Set([...tbaTeams, ...scoutedTeams])).sort(
    (a, b) => (a as number) - (b as number)
  );

  const submissionsByTeam = (allSubmissions ?? []).reduce<
    Record<number, Submission[]>
  >((acc, s: Submission) => {
    // Exclude checklist submissions (teamNumber === 0) and pit submissions
    if (s.teamNumber === 0) return acc;
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

  // Sorting — one resolver per fixed column.
  const sorted = useMemo(() => {
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
      return null;
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
  }, [filtered, sortKey, sortDir, tbaRankings, avgScoreByTeam, epaMap]);

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
                <div className="min-w-[840px]">
                <ColumnHeader sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
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
                  sorted.map((teamNumber) => {
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
                        onOpenDetail={() => setSelectedTeam(teamNumber as number)}
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
                ) : filtered.length === 0 ? (
                  <p className="text-center py-12 text-muted-foreground text-sm px-4">
                    {search ? "No teams match your search." : "No teams found for this event."}
                  </p>
                ) : (
                  sorted.map((teamNumber) => {
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
            onClose={() => setSelectedTeam(null)}
          />
        );
      })()}
    </div>
  );
}
