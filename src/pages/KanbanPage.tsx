import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { KanbanColumn, KanbanCard } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Plus, X, Pencil, Users, RefreshCw, SlidersHorizontal, LayoutGrid, LayoutList, Check, GripVertical } from "lucide-react";
import {
  fetchStatboticsEventTeams,
  fetchTBAEventRankings,
  fetchTBAEventTeams,
  fetchTBATeamInfo,
  fetchTBATeamAvatar,
} from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCached } from "@/hooks/useCached";
import { enqueueKanbanOp } from "@/lib/offlineQueue";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FormField {
  id: string;
  type: "text" | "number" | "checkbox" | "select" | "counter" | "textarea";
  label: string;
  required: boolean;
  options?: string[];
  section?: string;
}

interface Submission {
  teamNumber: number;
  matchNumber: number;
  data: string;
}

// ── Card display preferences ──────────────────────────────────────────────────

const CARD_PREFS_KEY = "falconscout_card_display_fields";

function getCardPrefs(): string[] {
  try {
    const raw = localStorage.getItem(CARD_PREFS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : ["epa"];
  } catch {
    return ["epa"];
  }
}

function saveCardPrefs(prefs: string[]): void {
  localStorage.setItem(CARD_PREFS_KEY, JSON.stringify(prefs));
}

// ── Picked-teams helpers (per board, persisted to localStorage) ───────────────

const PICKED_KEY_PREFIX = "falconscout_picked_";

function getPickedTeams(boardId: string): Set<number> {
  try {
    const raw = localStorage.getItem(`${PICKED_KEY_PREFIX}${boardId}`);
    return raw ? new Set(JSON.parse(raw) as number[]) : new Set();
  } catch {
    return new Set();
  }
}

function savePickedTeams(boardId: string, picked: Set<number>): void {
  localStorage.setItem(`${PICKED_KEY_PREFIX}${boardId}`, JSON.stringify([...picked]));
}

// ── Stat helpers ──────────────────────────────────────────────────────────────

function parseData(submissions: Submission[]): Record<string, unknown>[] {
  return submissions.map((s) => {
    try { return JSON.parse(s.data) as Record<string, unknown>; }
    catch { return {}; }
  });
}

function computeFormStat(
  parsed: Record<string, unknown>[],
  field: FormField
): string | null {
  if (field.type === "number" || field.type === "counter") {
    const vals = parsed
      .map((d) => d[field.id])
      .filter((v) => typeof v === "number") as number[];
    if (!vals.length) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Number.isInteger(avg) ? String(avg) : avg.toFixed(1);
  }
  if (field.type === "checkbox") {
    const vals = parsed.map((d) => d[field.id]).filter((v) => v !== undefined);
    if (!vals.length) return null;
    return `${Math.round((vals.filter(Boolean).length / vals.length) * 100)}%`;
  }
  if (field.type === "select") {
    const counts: Record<string, number> = {};
    for (const d of parsed) {
      const v = String(d[field.id] ?? "");
      if (v) counts[v] = (counts[v] ?? 0) + 1;
    }
    const entries = Object.entries(counts);
    if (!entries.length) return null;
    return entries.sort((a, b) => b[1] - a[1])[0][0];
  }
  return null;
}

// Deterministic accent color per team number
function teamAccentColor(num: number): string {
  const palette = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f97316",
    "#eab308", "#22c55e", "#06b6d4", "#3b82f6",
  ];
  return palette[num % palette.length];
}

// ── EPA helpers (Statbotics v3 — structure varies by season) ──────────────────────

/** Read mean from a {mean, sd} leaf or bare number. */
function readMean(v: unknown): number | null {
  if (typeof v === "number") return Number(v.toFixed(1));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.mean === "number") return Number((o.mean as number).toFixed(1));
  }
  return null;
}

/** Recursively search an EPA object for any of the named keys.
 *  Works for flat (epa.auto_points) and nested (epa.breakdown.auto_points) structures. */
function findInEpa(obj: unknown, ...keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const key of keys) {
    if (key in o) {
      const m = readMean(o[key]);
      if (m !== null) return m;
    }
  }
  for (const val of Object.values(o)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const found = findInEpa(val, ...keys);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Total event EPA: prefer total_points key, then a direct mean on the epa object. */
function extractEpa(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return findInEpa(obj, "total_points", "total") ?? readMean(obj);
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useTeamInfo(teamNumber: number, year: number) {
  const [nickname, setNickname] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [info, av] = await Promise.all([
        fetchTBATeamInfo(teamNumber),
        fetchTBATeamAvatar(teamNumber, year),
      ]);
      if (cancelled) return;
      setNickname(info?.nickname ?? null);
      setAvatar(av); // null means no avatar found
    }
    load();
    return () => { cancelled = true; };
  }, [teamNumber, year]);

  return { nickname, avatar };
}

function useTeamRanking(teamNumber: number, eventKey: string) {
  const [rank, setRank] = useState<number | null>(null);
  const [record, setRecord] = useState<{ w: number; l: number; t: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const tbaRankData = await fetchTBAEventRankings(eventKey);
      if (cancelled) return;

      if (tbaRankData && typeof tbaRankData === "object" && "rankings" in tbaRankData) {
        const rankings = (
          tbaRankData as {
            rankings: Array<{
              team_key: string;
              rank: number;
              record: { wins: number; losses: number; ties: number };
            }>;
          }
        ).rankings;
        const r = rankings.find((x) => x.team_key === `frc${teamNumber}`);
        if (r) {
          setRank(r.rank);
          setRecord({ w: r.record.wins, l: r.record.losses, t: r.record.ties });
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [teamNumber, eventKey]);

  return { rank, record };
}

// ── Configure Cards Dialog ────────────────────────────────────────────────────

function CardPrefsDialog({
  open,
  onClose,
  fields,
  cardPrefs,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  fields: FormField[];
  cardPrefs: string[];
  onSave: (prefs: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>(cardPrefs);

  useEffect(() => { setDraft(cardPrefs); }, [cardPrefs, open]);

  function toggle(id: string) {
    setDraft((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // Only numeric/counter/checkbox fields make sense as card stats
  const displayableFields = fields.filter(
    (f) => f.type === "number" || f.type === "counter" || f.type === "checkbox"
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Configure Card Display</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-1">
          Choose which stats appear on each picklist card.
        </p>

        <div className="space-y-3">
          {/* Built-in stats */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              External Data
            </p>
            <div className="space-y-0.5">
              <label className="flex items-center gap-3 cursor-pointer py-1.5">
                <Checkbox checked={draft.includes("epa")} onCheckedChange={() => toggle("epa")} />
                <div>
                  <span className="text-sm font-medium">EPA — Event</span>
                  <span className="ml-2 text-xs text-muted-foreground">Total at this event</span>
                </div>
              </label>
              <label className="flex items-center gap-3 cursor-pointer py-1.5">
                <Checkbox checked={draft.includes("epa_auto")} onCheckedChange={() => toggle("epa_auto")} />
                <div>
                  <span className="text-sm font-medium">EPA — Auto</span>
                  <span className="ml-2 text-xs text-muted-foreground">Autonomous period</span>
                </div>
              </label>
              <label className="flex items-center gap-3 cursor-pointer py-1.5">
                <Checkbox checked={draft.includes("epa_teleop")} onCheckedChange={() => toggle("epa_teleop")} />
                <div>
                  <span className="text-sm font-medium">EPA — Teleop</span>
                  <span className="ml-2 text-xs text-muted-foreground">Teleop period</span>
                </div>
              </label>
              <label className="flex items-center gap-3 cursor-pointer py-1.5">
                <Checkbox checked={draft.includes("epa_endgame")} onCheckedChange={() => toggle("epa_endgame")} />
                <div>
                  <span className="text-sm font-medium">EPA — Endgame</span>
                  <span className="ml-2 text-xs text-muted-foreground">Endgame / climb</span>
                </div>
              </label>
              <label className="flex items-center gap-3 cursor-pointer py-1.5">
                <Checkbox checked={draft.includes("epa_overall")} onCheckedChange={() => toggle("epa_overall")} />
                <div>
                  <span className="text-sm font-medium">EPA — Season</span>
                  <span className="ml-2 text-xs text-muted-foreground">Overall {new Date().getFullYear()} rating</span>
                </div>
              </label>
            </div>
          </div>

          {displayableFields.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Form Fields
                </p>
                <div className="space-y-0.5">
                  {displayableFields.map((f) => (
                    <label key={f.id} className="flex items-center gap-3 cursor-pointer py-1.5">
                      <Checkbox
                        checked={draft.includes(f.id)}
                        onCheckedChange={() => toggle(f.id)}
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium">{f.label}</span>
                        <span className="ml-2 text-xs text-muted-foreground capitalize">
                          {f.type === "number" || f.type === "counter"
                            ? "avg"
                            : f.type === "checkbox"
                              ? "% on"
                              : "top"}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          {displayableFields.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No active form template found. Set one in Form Builder.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              onSave(draft);
              onClose();
              toast.success("Card display saved");
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Team Avatar ───────────────────────────────────────────────────────────────

function TeamAvatar({
  teamNumber,
  avatar,
  size = 36,
}: {
  teamNumber: number;
  avatar: string | null | "loading";
  size?: number;
}) {
  const color = teamAccentColor(teamNumber);

  if (avatar && avatar !== "loading") {
    return (
      <img
        src={avatar}
        alt={`Team ${teamNumber}`}
        width={size}
        height={size}
        className="rounded-md object-contain bg-white"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className="rounded-md flex items-center justify-center text-white font-bold shrink-0"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: size * 0.28,
      }}
    >
      {teamNumber}
    </div>
  );
}

// ── Stat Chip ─────────────────────────────────────────────────────────────────

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[9px] text-muted-foreground truncate leading-tight">{label}</span>
      <span className="text-xs font-bold font-mono leading-tight">{value}</span>
    </div>
  );
}

// ── Team Card ─────────────────────────────────────────────────────────────────

function TeamCard({
  card,
  eventKey,
  eventYear,
  epa,
  submissions,
  fields,
  cardPrefs,
  isDragging,
  onEdit,
  onRemove,
  onDragStart,
  onDragEnd,
}: {
  card: KanbanCard;
  eventKey: string;
  eventYear: number;
  epa: { event: number | null; auto: number | null; teleop: number | null; endgame: number | null } | null;
  submissions: Submission[];
  fields: FormField[];
  cardPrefs: string[];
  isDragging: boolean;
  onEdit: (card: KanbanCard) => void;
  onRemove: (cardId: string) => void;
  onDragStart: (e: React.DragEvent, cardId: string) => void;
  onDragEnd: () => void;
}) {
  const { nickname, avatar } = useTeamInfo(card.teamNumber, eventYear);
  const { rank, record } = useTeamRanking(card.teamNumber, eventKey);

  const parsed = parseData(submissions);

  const visibleStats: Array<{ key: string; label: string; value: string }> = [];

  // EPA chips — always show when configured (show "—" if no data yet)
  if (cardPrefs.includes("epa")) {
    visibleStats.push({
      key: "epa",
      label: "Event EPA",
      value: epa?.event !== null && epa?.event !== undefined ? Number(epa.event.toFixed(1)).toString() : "—",
    });
  }
  if (cardPrefs.includes("epa_auto")) {
    visibleStats.push({
      key: "epa_auto",
      label: "Auto EPA",
      value: epa?.auto !== null && epa?.auto !== undefined ? Number(epa.auto.toFixed(1)).toString() : "—",
    });
  }
  if (cardPrefs.includes("epa_teleop")) {
    visibleStats.push({
      key: "epa_teleop",
      label: "Teleop EPA",
      value: epa?.teleop !== null && epa?.teleop !== undefined ? Number(epa.teleop.toFixed(1)).toString() : "—",
    });
  }
  if (cardPrefs.includes("epa_endgame")) {
    visibleStats.push({
      key: "epa_endgame",
      label: "Endgame EPA",
      value: epa?.endgame !== null && epa?.endgame !== undefined ? Number(epa.endgame.toFixed(1)).toString() : "—",
    });
  }
  if (cardPrefs.includes("epa_overall")) {
    // Season EPA: fall back to event EPA since team_year data may not be available yet.
    const seasonVal = epa?.event ?? null;
    visibleStats.push({
      key: "epa_overall",
      label: "Season EPA",
      value: seasonVal !== null ? Number(seasonVal.toFixed(1)).toString() : "—",
    });
  }

  for (const f of fields) {
    if (!cardPrefs.includes(f.id)) continue;
    const val = computeFormStat(parsed, f);
    if (val !== null) visibleStats.push({ key: f.id, label: f.label, value: val });
  }

  const color = teamAccentColor(card.teamNumber);

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, card._id)}
      onDragEnd={onDragEnd}
      className={`group bg-card border border-border rounded-lg overflow-hidden cursor-grab active:cursor-grabbing transition-all select-none ${
        isDragging
          ? "opacity-40 scale-95"
          : "hover:border-primary/50 hover:shadow-md hover:shadow-primary/5"
      }`}
    >
      {/* Color accent bar */}
      <div className="h-0.5" style={{ background: color }} />

      <div className="p-3 space-y-2">
        {/* Header: avatar + number + name + actions */}
        <div className="flex items-start gap-2">
          <TeamAvatar teamNumber={card.teamNumber} avatar={avatar} size={36} />

          <div className="flex-1 min-w-0">
            <p className="font-bold text-base leading-tight">{card.teamNumber}</p>
            {nickname ? (
              <p className="text-xs text-muted-foreground truncate leading-tight">{nickname}</p>
            ) : (
              <p className="text-xs text-muted-foreground/50 truncate leading-tight">Loading…</p>
            )}
          </div>

          {/* Actions — visible on hover */}
          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(card); }}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Edit notes"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(card._id); }}
              className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
              title="Remove"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Rank + record */}
        {(rank !== null || record !== null) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {rank !== null && (
              <span
                className="px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold"
                style={{ background: `${color}20`, color }}
              >
                #{rank}
              </span>
            )}
            {record !== null && (
              <span className="font-mono text-[11px]">
                {record.w}-{record.l}-{record.t}
              </span>
            )}
          </div>
        )}

        {/* Configurable stats */}
        {visibleStats.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5 border-t border-border">
            {visibleStats.map((s) => (
              <StatChip key={s.key} label={s.label} value={s.value} />
            ))}
          </div>
        )}

        {/* Notes preview */}
        {card.notes && (
          <p className="text-xs text-muted-foreground italic line-clamp-2 border-t border-border pt-1.5">
            {card.notes}
          </p>
        )}

        {/* Match count */}
        {submissions.length > 0 && (
          <p className="text-[10px] text-muted-foreground/60">
            {submissions.length} match{submissions.length !== 1 ? "es" : ""} scouted
          </p>
        )}
      </div>
    </div>
  );
}

// ── Kanban Column ─────────────────────────────────────────────────────────────

function KanbanCol({
  column,
  cards,
  eventKey,
  eventYear,
  epaByTeam,
  submissionsByTeam,
  fields,
  cardPrefs,
  draggingCardId,
  isDragTarget,
  onDragOver,
  onDragLeave,
  onDrop,
  onEditCard,
  onRemoveCard,
  onRemoveColumn,
  onDragStart,
  onDragEnd,
}: {
  column: KanbanColumn;
  cards: KanbanCard[];
  eventKey: string;
  eventYear: number;
  epaByTeam: Record<number, { event: number | null; auto: number | null; teleop: number | null; endgame: number | null }>;
  submissionsByTeam: Record<number, Submission[]>;
  fields: FormField[];
  cardPrefs: string[];
  draggingCardId: string | null;
  isDragTarget: boolean;
  onDragOver: (colId: string) => void;
  onDragLeave: () => void;
  onDrop: (colId: string) => void;
  onEditCard: (card: KanbanCard) => void;
  onRemoveCard: (cardId: string) => void;
  onRemoveColumn: (colId: string) => void;
  onDragStart: (e: React.DragEvent, cardId: string) => void;
  onDragEnd: () => void;
}) {
  const sorted = [...cards].sort((a, b) => a.teamNumber - b.teamNumber);

  return (
    <div
      className={`flex flex-col shrink-0 rounded-xl overflow-hidden border transition-all ${
        isDragTarget
          ? "border-primary bg-primary/5 ring-2 ring-primary/30"
          : "border-border bg-muted/30"
      }`}
      style={{
        /* 85vw on portrait mobile so next column peeks; 18rem (w-72) on wider screens */
        width: "clamp(260px, 85vw, 288px)",
        scrollSnapAlign: "start",
        borderTopColor: column.color ?? undefined,
        borderTopWidth: column.color ? 3 : undefined,
      }}
      onDragOver={(e) => { e.preventDefault(); onDragOver(column.id); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop(column.id); }}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card">
        <span className="font-semibold text-sm">{column.title}</span>
        <div className="flex items-center gap-1 text-muted-foreground">
          <span className="text-xs font-mono">{sorted.length}</span>
          <button
            onClick={() => onRemoveColumn(column.id)}
            className="p-0.5 rounded hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Cards */}
      <ScrollArea className="flex-1" style={{ maxHeight: "calc(100vh - 220px)" }}>
        <div className="p-2 space-y-2">
          {sorted.map((card) => (
            <TeamCard
              key={card._id}
              card={card}
              eventKey={eventKey}
              eventYear={eventYear}
              epa={epaByTeam[card.teamNumber] ?? null}
              submissions={submissionsByTeam[card.teamNumber] ?? []}
              fields={fields}
              cardPrefs={cardPrefs}
              isDragging={draggingCardId === card._id}
              onEdit={onEditCard}
              onRemove={onRemoveCard}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
          {sorted.length === 0 && (
            <div className={`rounded-lg border-2 border-dashed py-8 text-center text-xs text-muted-foreground transition-colors ${
              isDragTarget ? "border-primary/40 text-primary/60" : "border-border"
            }`}>
              {isDragTarget ? "Drop here" : "Empty"}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── List Team Row ─────────────────────────────────────────────────────────────

function ListTeamRow({
  card,
  eventYear,
  epa,
  columnColor,
  isPicked,
  isDragging,
  onTogglePick,
  onEdit,
  onRemove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  card: KanbanCard;
  eventYear: number;
  epa: { event: number | null; auto: number | null; teleop: number | null; endgame: number | null } | null;
  columnColor?: string;
  isPicked: boolean;
  isDragging: boolean;
  onTogglePick: () => void;
  onEdit: (card: KanbanCard) => void;
  onRemove: (cardId: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { nickname, avatar } = useTeamInfo(card.teamNumber, eventYear);
  const color = teamAccentColor(card.teamNumber);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`group flex items-center gap-3 px-3 py-2.5 border-b border-border transition-all select-none ${
        isDragging
          ? "opacity-40 bg-primary/5"
          : isPicked
          ? "opacity-35 bg-muted/20"
          : "hover:bg-muted/40"
      } ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
    >
      {/* Drag handle */}
      <GripVertical className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 shrink-0 transition-colors" />

      {/* Pick toggle */}
      <button
        onClick={(e) => { e.stopPropagation(); onTogglePick(); }}
        className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
          isPicked
            ? "bg-muted-foreground/40 border-muted-foreground/40"
            : "border-border hover:border-primary hover:bg-primary/10"
        }`}
        title={isPicked ? "Unmark picked" : "Mark as picked"}
      >
        {isPicked && <Check className="h-3 w-3 text-muted-foreground" />}
      </button>

      {/* Avatar */}
      <TeamAvatar teamNumber={card.teamNumber} avatar={avatar} size={28} />

      {/* Team number + nickname */}
      <div className="min-w-[5.5rem] shrink-0">
        <p className={`font-bold text-sm leading-tight ${
          isPicked ? "line-through text-muted-foreground" : ""
        }`}>
          {card.teamNumber}
        </p>
        {nickname ? (
          <p className="text-xs text-muted-foreground truncate leading-tight max-w-[7rem]">{nickname}</p>
        ) : (
          <p className="text-xs text-muted-foreground/40 leading-tight">Loading…</p>
        )}
      </div>

      {/* EPA */}
      {epa?.event !== null && epa?.event !== undefined && (
        <div className="hidden md:flex flex-col shrink-0 min-w-[3rem]">
          <span className="text-[9px] text-muted-foreground">EPA</span>
          <span
            className="text-xs font-bold font-mono"
            style={{ color: columnColor ?? color }}
          >
            {epa.event.toFixed(1)}
          </span>
        </div>
      )}

      {/* Notes */}
      {card.notes ? (
        <p className="flex-1 text-xs text-muted-foreground italic truncate hidden lg:block">
          {card.notes}
        </p>
      ) : (
        <div className="flex-1" />
      )}

      {/* Actions */}
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(card); }}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Edit notes"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(card._id); }}
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
          title="Remove"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── List View ─────────────────────────────────────────────────────────────────

function ListView({
  columns,
  cards,
  eventYear,
  epaByTeam,
  pickedTeams,
  onTogglePick,
  onClearPicked,
  onMoveCard,
  onEditCard,
  onRemoveCard,
}: {
  columns: KanbanColumn[];
  cards: KanbanCard[];
  eventYear: number;
  epaByTeam: Record<number, { event: number | null; auto: number | null; teleop: number | null; endgame: number | null }>;
  pickedTeams: Set<number>;
  onTogglePick: (teamNumber: number) => void;
  onClearPicked: () => void;
  onMoveCard: (cardId: string, columnId: string, position: number) => void;
  onEditCard: (card: KanbanCard) => void;
  onRemoveCard: (cardId: string) => void;
}) {
  // ── Internal display order (survives re-renders, resets on server update) ──
  const defaultSort = (arr: KanbanCard[]) =>
    [...arr].sort((a, b) => {
      const ai = columns.findIndex((c) => c.id === a.columnId);
      const bi = columns.findIndex((c) => c.id === b.columnId);
      if (ai !== bi) return ai - bi;
      return a.position - b.position;
    });

  const [orderedCards, setOrderedCards] = useState<KanbanCard[]>(() => defaultSort(cards));
  const prevCardsRef = useRef(cards);

  // Re-sync when server cards change (Convex confirmed the mutation)
  useEffect(() => {
    if (prevCardsRef.current !== cards) {
      prevCardsRef.current = cards;
      setOrderedCards(defaultSort(cards));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  // ── Drag state ────────────────────────────────────────────────────────────
  const [listDragId, setListDragId] = useState<string | null>(null);
  // dropInfo drives the visible blue-line indicator; actual position is
  // recalculated fresh from e.clientY at drop time, so stale state never
  // causes the wrong insertion.
  const [dropInfo, setDropInfo]     = useState<{ cardId: string; before: boolean } | null>(null);
  const [headerDrop, setHeaderDrop] = useState<string | null>(null);

  // ── DnD handlers ─────────────────────────────────────────────────────────

  function handleDragStart(e: React.DragEvent, cardId: string) {
    setListDragId(cardId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", cardId);
  }

  function handleDragEnd() {
    setListDragId(null);
    setDropInfo(null);
    setHeaderDrop(null);
  }

  /** Updates the visual indicator as the cursor moves over a row. */
  function handleRowDragOver(e: React.DragEvent, cardId: string) {
    e.preventDefault();
    if (!listDragId || listDragId === cardId) return;
    const rect   = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropInfo((prev) =>
      prev?.cardId === cardId && prev?.before === before ? prev : { cardId, before }
    );
    setHeaderDrop(null);
  }

  /** Performs the drop. before/after is recalculated from live e.clientY so
   *  stale dropInfo state can never cause the wrong insertion. */
  function handleRowDrop(e: React.DragEvent, targetCardId: string) {
    e.preventDefault();
    if (!listDragId || listDragId === targetCardId) { handleDragEnd(); return; }

    const dragCard   = orderedCards.find((c) => c._id === listDragId);
    const targetCard = orderedCards.find((c) => c._id === targetCardId);
    if (!dragCard || !targetCard) { handleDragEnd(); return; }

    // Fresh calculation — never read from stale dropInfo.before
    const rect   = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;

    const withoutDrag = orderedCards.filter((c) => c._id !== listDragId);
    const targetIdx   = withoutDrag.findIndex((c) => c._id === targetCardId);
    const insertIdx   = before ? targetIdx : targetIdx + 1;

    const newOrder = [
      ...withoutDrag.slice(0, insertIdx),
      { ...dragCard, columnId: targetCard.columnId },
      ...withoutDrag.slice(insertIdx),
    ];
    setOrderedCards(newOrder);

    const newColCards = newOrder.filter((c) => c.columnId === targetCard.columnId);
    const position    = newColCards.findIndex((c) => c._id === listDragId);
    onMoveCard(listDragId, targetCard.columnId, Math.max(0, position));
    handleDragEnd();
  }

  function handleHeaderDragOver(e: React.DragEvent, columnId: string) {
    e.preventDefault();
    setDropInfo(null);
    setHeaderDrop(columnId);
  }

  function handleHeaderDrop(e: React.DragEvent, columnId: string) {
    e.preventDefault();
    if (!listDragId) { handleDragEnd(); return; }
    const dragCard = orderedCards.find((c) => c._id === listDragId);
    if (!dragCard) { handleDragEnd(); return; }

    const withoutDrag  = orderedCards.filter((c) => c._id !== listDragId);
    const firstInCol   = withoutDrag.findIndex((c) => c.columnId === columnId);
    const insertIdx    = firstInCol === -1
      ? withoutDrag.findIndex((c) => {
          const ci = columns.findIndex((col) => col.id === c.columnId);
          return ci >= columns.findIndex((col) => col.id === columnId);
        })
      : firstInCol;
    const effectiveIdx = insertIdx === -1 ? withoutDrag.length : insertIdx;

    const newOrder = [
      ...withoutDrag.slice(0, effectiveIdx),
      { ...dragCard, columnId },
      ...withoutDrag.slice(effectiveIdx),
    ];
    setOrderedCards(newOrder);
    onMoveCard(listDragId, columnId, 0);
    handleDragEnd();
  }

  // ── Derived stats ─────────────────────────────────────────────────────────
  const pickedCount = orderedCards.filter((c) => pickedTeams.has(c.teamNumber)).length;
  const remaining   = orderedCards.length - pickedCount;

  // Group by column (preserving column order)
  const groups = columns.map((col) => ({
    column: col,
    cards: orderedCards.filter((c) => c.columnId === col.id),
  }));



  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Stats bar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 bg-muted/30 border border-border rounded-t-xl text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{orderedCards.length}</span> teams
        <span className="opacity-30">·</span>
        <span className="font-semibold text-amber-500">{pickedCount}</span> picked
        <span className="opacity-30">·</span>
        <span className="font-semibold text-emerald-500">{remaining}</span> available
        {pickedCount > 0 && (
          <button
            className="ml-auto text-xs underline hover:text-foreground transition-colors"
            onClick={onClearPicked}
          >
            Clear all picked
          </button>
        )}
      </div>

      {/* List — grouped by column / tier */}
      <ScrollArea
        className="flex-1 min-h-0 border border-t-0 border-border rounded-b-xl bg-card"
      >
        {groups.map(({ column, cards: colCards }) => (
          <div key={column.id}>
            {/* Section header — also a drop zone (insert at top of section) */}
            <div
              onDragOver={(e) => handleHeaderDragOver(e, column.id)}
              onDragLeave={() => setHeaderDrop(null)}
              onDrop={(e) => handleHeaderDrop(e, column.id)}
              className={`sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 border-b border-border backdrop-blur transition-colors ${
                headerDrop === column.id && listDragId
                  ? "bg-primary/15 border-primary/40"
                  : "bg-muted/70"
              }`}
            >
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: column.color ?? "#6b7280" }}
              />
              <span className="text-xs font-semibold truncate flex-1">{column.title}</span>
              <span className="text-xs text-muted-foreground font-mono">{colCards.length}</span>
              {headerDrop === column.id && listDragId && (
                <span className="text-[10px] text-primary font-medium">Drop to top ↑</span>
              )}
            </div>

            {/* Rows with per-row drop targets */}
            {colCards.map((card) => {
              const showAbove = dropInfo?.cardId === card._id && dropInfo.before  && listDragId !== card._id;
              const showBelow = dropInfo?.cardId === card._id && !dropInfo.before && listDragId !== card._id;
              return (
                <div key={card._id} className="relative">
                  {showAbove && (
                    <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary z-20 pointer-events-none" />
                  )}
                  <ListTeamRow
                    card={card}
                    eventYear={eventYear}
                    epa={epaByTeam[card.teamNumber] ?? null}
                    columnColor={column.color}
                    isPicked={pickedTeams.has(card.teamNumber)}
                    isDragging={listDragId === card._id}
                    onTogglePick={() => onTogglePick(card.teamNumber)}
                    onEdit={onEditCard}
                    onRemove={onRemoveCard}
                    onDragStart={(e) => handleDragStart(e, card._id)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleRowDragOver(e, card._id)}
                    onDrop={(e) => handleRowDrop(e, card._id)}
                  />
                  {showBelow && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary z-20 pointer-events-none" />
                  )}
                </div>
              );
            })}

            {/* Empty column drop zone */}
            {colCards.length === 0 && (
              <div
                onDragOver={(e) => handleHeaderDragOver(e, column.id)}
                onDragLeave={() => setHeaderDrop(null)}
                onDrop={(e) => handleHeaderDrop(e, column.id)}
                className={`px-4 py-5 text-center text-xs border-b border-border transition-colors ${
                  headerDrop === column.id && listDragId
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground"
                }`}
              >
                {listDragId ? `Drop here → ${column.title}` : "Empty"}
              </div>
            )}
          </div>
        ))}

        {orderedCards.length === 0 && (
          <div className="py-16 text-center text-muted-foreground text-sm">
            No teams on this board yet.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ── Board View ────────────────────────────────────────────────────────────────

function BoardView({
  boardId,
  eventKey,
  eventYear,
  boardType,
}: {
  boardId: Id<"kanbanBoards">;
  eventKey: string;
  eventYear: number;
  boardType: "personal" | "central";
}) {
  // ── Convex queries with offline cache fallback ───────────────────────────
  const boardLive = useQuery(
    boardType === "central" ? api.kanban.getCentralBoard : api.kanban.getPersonalBoard,
    { eventKey }
  );
  const board = useCached(boardLive, `kanban_board_${boardType}_${eventKey}`);

  const rawCardsLive = useQuery(api.kanban.getBoardCards, { boardId });
  const rawCardsCached = useCached(rawCardsLive, `kanban_cards_${boardId}`);

  const allSubmissionsLive = useQuery(
    api.forms.listSubmissions,
    eventKey ? { eventKey } : "skip"
  );
  const allSubmissions = useCached(allSubmissionsLive, `submissions_${eventKey}`);

  const activeTemplateLive = useQuery(api.forms.getActiveTemplate);
  const activeTemplate = useCached(activeTemplateLive, `active_template`);

  const updateColumns    = useMutation(api.kanban.updateBoardColumns);
  const moveCardMutation = useMutation(api.kanban.moveCard);
  const updateCardMutation = useMutation(api.kanban.updateCard);
  const removeCardMutation = useMutation(api.kanban.removeCard);
  const seedTeamsMutation  = useMutation(api.kanban.seedTeams);

  const [editingCard, setEditingCard]   = useState<KanbanCard | null>(null);
  const [editNotes, setEditNotes]       = useState("");
  const [newColName, setNewColName]     = useState("");
  const [seeding, setSeeding]           = useState(false);
  const [cardPrefsOpen, setCardPrefsOpen] = useState(false);
  const [cardPrefs, setCardPrefs]       = useState<string[]>(getCardPrefs);
  const [epaByTeam, setEpaByTeam] = useState<Record<number, { event: number | null; auto: number | null; teleop: number | null; endgame: number | null }>>({});
  const [viewMode, setViewMode]         = useState<"board" | "list">("board");
  const [pickedTeams, setPickedTeams]   = useState<Set<number>>(() => getPickedTeams(String(boardId)));
  const seededRef = useRef(false);

  // Optimistic offline state
  const [localMoves, setLocalMoves]         = useState<Record<string, { columnId: string; position: number }>>({});
  const [removedCardIds, setRemovedCardIds] = useState<Set<string>>(new Set());

  const draggingCardId   = useRef<string | null>(null);
  const [activeDragCardId, setActiveDragCardId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId]       = useState<string | null>(null);

  const columns: KanbanColumn[] = board?.columns ?? [];

  // Merge raw Convex cards with optimistic local overrides
  const cards: KanbanCard[] = useMemo(() => {
    const base = (rawCardsCached ?? []).map(
      (c: {
        _id: string;
        boardId: Id<"kanbanBoards">;
        columnId: string;
        teamNumber: number;
        eventKey: string;
        notes?: string;
        position: number;
      }) => ({ ...c, boardId: c.boardId as string })
    );
    return base
      .filter((c) => !removedCardIds.has(c._id))
      .map((c) => {
        const move = localMoves[c._id];
        return move ? { ...c, columnId: move.columnId, position: move.position } : c;
      });
  }, [rawCardsCached, localMoves, removedCardIds]);

  // Clear optimistic overrides once Convex confirms the real state
  useEffect(() => {
    if (rawCardsLive === undefined) return;
    setLocalMoves({});
    setRemovedCardIds(new Set());
  }, [rawCardsLive]);

  const fields: FormField[] = (activeTemplate?.fields as FormField[]) ?? [];

  // Group submissions by team
  const submissionsByTeam = (allSubmissions ?? []).reduce<Record<number, Submission[]>>(
    (acc, s: Submission) => {
      acc[s.teamNumber] = [...(acc[s.teamNumber] ?? []), s];
      return acc;
    },
    {}
  );

  // ── Fetch Statbotics EPA breakdown for all event teams ─────────────────
  useEffect(() => {
    if (!eventKey) return;
    async function loadEpa() {
      const data = await fetchStatboticsEventTeams(eventKey);
      if (!Array.isArray(data) || data.length === 0) return;
      const map: Record<number, { event: number | null; auto: number | null; teleop: number | null; endgame: number | null }> = {};
      for (const t of data as Array<{ team: number; epa: unknown }>) {
        const epaRaw = t.epa;
        map[t.team] = {
          event:   extractEpa(epaRaw),
          auto:    findInEpa(epaRaw, "auto_points", "auto"),
          teleop:  findInEpa(epaRaw, "teleop_points", "teleop"),
          endgame: findInEpa(epaRaw, "endgame_points", "endgame"),
        };
      }
      setEpaByTeam(map);
    }
    loadEpa();
  }, [eventKey]);

  // ── Auto-seed TBA teams ──────────────────────────────────────────────────
  useEffect(() => {
    if (!board || rawCardsCached === undefined || seededRef.current) return;
    if (!navigator.onLine) return; // skip seeding when offline
    seededRef.current = true;

    const unsortedCol = columns.find((c) => c.id === "unsorted") ?? columns[columns.length - 1];
    if (!unsortedCol) return;

    async function seed() {
      setSeeding(true);
      try {
        const tbaData = await fetchTBAEventTeams(eventKey);
        if (!Array.isArray(tbaData)) return;
        const teamNumbers = (tbaData as Array<{ team_number: number }>).map((t) => t.team_number);
        if (!teamNumbers.length) return;
        const added = await seedTeamsMutation({ boardId, eventKey, columnId: unsortedCol!.id, teamNumbers });
        if (added > 0) toast.success(`Added ${added} teams from TBA`);
      } catch {
        // TBA might not have data yet
      } finally {
        setSeeding(false);
      }
    }
    seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board?._id, rawCardsCached !== undefined]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleResync() {
    if (!board) return;
    const unsortedCol = columns.find((c) => c.id === "unsorted") ?? columns[columns.length - 1];
    if (!unsortedCol) return;
    setSeeding(true);
    try {
      const tbaData = await fetchTBAEventTeams(eventKey);
      if (!Array.isArray(tbaData)) return;
      const teamNumbers = (tbaData as Array<{ team_number: number }>).map((t) => t.team_number);
      const added = await seedTeamsMutation({ boardId, eventKey, columnId: unsortedCol.id, teamNumbers });
      toast.success(added > 0 ? `Added ${added} new teams` : "All teams already on board");
    } catch {
      toast.error("Failed to fetch from TBA");
    } finally {
      setSeeding(false);
    }
  }

  async function handleAddColumn() {
    if (!newColName.trim()) return;
    const newCol: KanbanColumn = {
      id: crypto.randomUUID().slice(0, 8),
      title: newColName.trim(),
      color: "#EAB308",
    };
    await updateColumns({ boardId, columns: [...columns, newCol] });
    setNewColName("");
  }

  async function handleRemoveColumn(colId: string) {
    await updateColumns({ boardId, columns: columns.filter((c) => c.id !== colId) });
  }

  // ── Drag handlers ─────────────────────────────────────────────────────────

  function handleDragStart(e: React.DragEvent, cardId: string) {
    draggingCardId.current = cardId;
    setActiveDragCardId(cardId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", cardId);
  }

  function handleDragEnd() {
    draggingCardId.current = null;
    setActiveDragCardId(null);
    setDragOverColId(null);
  }

  function handleDragOver(colId: string) { setDragOverColId(colId); }
  function handleDragLeave() { setTimeout(() => setDragOverColId((p) => p), 50); }

  async function handleDrop(targetColId: string) {
    const cardId = draggingCardId.current;
    setDragOverColId(null);
    setActiveDragCardId(null);
    draggingCardId.current = null;
    if (!cardId) return;

    const card = cards.find((c) => c._id === cardId);
    if (!card || card.columnId === targetColId) return;

    const position = cards.filter((c) => c.columnId === targetColId).length;

    // Optimistic: move card in local state immediately
    setLocalMoves((prev) => ({ ...prev, [cardId]: { columnId: targetColId, position } }));

    if (navigator.onLine) {
      try {
        await moveCardMutation({ cardId: cardId as Id<"kanbanCards">, columnId: targetColId, position });
      } catch {
        // Revert on failure
        setLocalMoves((prev) => { const p = { ...prev }; delete p[cardId]; return p; });
        toast.error("Failed to move card");
      }
    } else {
      enqueueKanbanOp({ type: "moveCard", cardId, columnId: targetColId, position });
      toast.info("Move saved — will sync when online", { duration: 2000 });
    }
  }

  async function handleSaveCardEdit() {
    if (!editingCard) return;
    const { _id: cardId } = editingCard;
    const notes = editNotes;
    setEditingCard(null); // close immediately (optimistic)

    if (navigator.onLine) {
      try {
        await updateCardMutation({ cardId: cardId as Id<"kanbanCards">, notes });
        toast.success("Notes saved");
      } catch {
        toast.error("Failed to save notes");
      }
    } else {
      enqueueKanbanOp({ type: "updateCard", cardId, notes });
      toast.success("Notes saved — will sync when online");
    }
  }

  async function handleRemoveCard(cardId: string) {
    // Optimistic remove
    setRemovedCardIds((prev) => new Set([...prev, cardId]));

    if (navigator.onLine) {
      try {
        await removeCardMutation({ cardId: cardId as Id<"kanbanCards"> });
      } catch {
        setRemovedCardIds((prev) => { const s = new Set(prev); s.delete(cardId); return s; });
        toast.error("Failed to remove card");
      }
    } else {
      enqueueKanbanOp({ type: "removeCard", cardId });
    }
  }

  function handleSavePrefs(prefs: string[]) {
    saveCardPrefs(prefs);
    setCardPrefs(prefs);
  }

  function handleTogglePick(teamNumber: number) {
    setPickedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamNumber)) next.delete(teamNumber); else next.add(teamNumber);
      savePickedTeams(String(boardId), next);
      return next;
    });
  }

  function handleClearPicked() {
    const next = new Set<number>();
    savePickedTeams(String(boardId), next);
    setPickedTeams(next);
  }

  async function handleMoveInList(cardId: string, targetColumnId: string, position: number) {
    // NOTE: Do NOT call setLocalMoves here. ListView manages its own optimistic
    // display via internal orderedCards state. Calling setLocalMoves would trigger
    // a new `cards` reference → ListView's useEffect would reset orderedCards,
    // snapping items back to their original position.
    if (navigator.onLine) {
      try {
        await moveCardMutation({ cardId: cardId as Id<"kanbanCards">, columnId: targetColumnId, position });
      } catch {
        toast.error("Failed to move card");
      }
    } else {
      enqueueKanbanOp({ type: "moveCard", cardId, columnId: targetColumnId, position });
      toast.info("Move saved — will sync when online", { duration: 2000 });
    }
  }

  // Show cached board skeleton while loading; never fully block on Convex
  if (!board && rawCardsCached === undefined) {
    return <div className="text-muted-foreground text-sm">Loading board…</div>;
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Add column — hidden on mobile to save space */}
        <div className="hidden sm:flex items-center gap-2">
          <Input
            className="w-36 h-8 text-sm"
            placeholder="Column name…"
            value={newColName}
            onChange={(e) => setNewColName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddColumn()}
          />
          <Button size="sm" variant="outline" onClick={handleAddColumn} className="h-8">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Column
          </Button>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {/* View mode toggle */}
          <div className="flex items-center rounded-lg border border-border bg-muted/30 p-0.5 gap-0.5">
            <button
              onClick={() => setViewMode("board")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                viewMode === "board"
                  ? "bg-background shadow text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Board view"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Board</span>
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                viewMode === "list"
                  ? "bg-background shadow text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="List view"
            >
              <LayoutList className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">List</span>
            </button>
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setCardPrefsOpen(true)}
            className="h-8"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span className="hidden sm:inline ml-1">Configure Cards</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleResync}
            disabled={seeding}
            className="h-8"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${seeding ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline ml-1">Sync Teams</span>
          </Button>
        </div>
      </div>

      {/* Board or List view */}
      {viewMode === "board" ? (
        /* Board — always scrolls horizontally; columns have min-width for portrait mobile */
        <div className="flex gap-3 overflow-x-auto pb-4 flex-1" style={{ scrollSnapType: "x mandatory" }}>
          {columns.map((col) => (
            <KanbanCol
              key={col.id}
              column={col}
              cards={cards.filter((c) => c.columnId === col.id)}
              eventKey={eventKey}
              eventYear={eventYear}
              epaByTeam={epaByTeam}
              submissionsByTeam={submissionsByTeam}
              fields={fields}
              cardPrefs={cardPrefs}
              draggingCardId={activeDragCardId}
              isDragTarget={dragOverColId === col.id}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onEditCard={(card) => {
                setEditingCard(card);
                setEditNotes(card.notes ?? "");
              }}
              onRemoveCard={handleRemoveCard}
              onRemoveColumn={handleRemoveColumn}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            />
          ))}

          {columns.length === 0 && (
            <div className="flex items-center justify-center h-48 w-full border-2 border-dashed border-border rounded-xl text-muted-foreground text-sm">
              No columns yet — add one above.
            </div>
          )}
        </div>
      ) : (
        /* List view — flat ordered list with pick toggles */
        <ListView
          columns={columns}
          cards={cards}
          eventYear={eventYear}
          epaByTeam={epaByTeam}
          pickedTeams={pickedTeams}
          onTogglePick={handleTogglePick}
          onClearPicked={handleClearPicked}
          onMoveCard={handleMoveInList}
          onEditCard={(card) => {
            setEditingCard(card);
            setEditNotes(card.notes ?? "");
          }}
          onRemoveCard={handleRemoveCard}
        />
      )}

      {/* Edit notes dialog */}
      <Dialog open={!!editingCard} onOpenChange={(o) => !o && setEditingCard(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Team {editingCard?.teamNumber}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={4}
                placeholder="Add notes about this team…"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setEditingCard(null)}>Cancel</Button>
              <Button onClick={handleSaveCardEdit}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Card prefs dialog */}
      <CardPrefsDialog
        open={cardPrefsOpen}
        onClose={() => setCardPrefsOpen(false)}
        fields={fields}
        cardPrefs={cardPrefs}
        onSave={handleSavePrefs}
      />
    </div>
  );
}

// ── Kanban Page ───────────────────────────────────────────────────────────────

export default function KanbanPage() {
  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const createBoard = useMutation(api.kanban.createBoard);

  const eventKey = currentEvent?.eventKey ?? "";

  const centralBoardLive = useQuery(
    api.kanban.getCentralBoard,
    eventKey ? { eventKey } : "skip"
  );
  const centralBoard = useCached(centralBoardLive, `kanban_board_central_${eventKey}`);

  const personalBoardLive = useQuery(
    api.kanban.getPersonalBoard,
    eventKey ? { eventKey } : "skip"
  );
  const personalBoard = useCached(personalBoardLive, `kanban_board_personal_${eventKey}`);

  const eventYear = eventKey ? parseInt(eventKey.slice(0, 4)) || new Date().getFullYear() : new Date().getFullYear();

  const DEFAULT_COLUMNS = [
    { id: "tier1",    title: "Tier 1 – Alliance Pick", color: "#22c55e" },
    { id: "tier2",    title: "Tier 2 – Strong",        color: "#EAB308" },
    { id: "tier3",    title: "Tier 3 – Average",       color: "#f97316" },
    { id: "unsorted", title: "Unsorted",               color: "#6b7280" },
  ];

  // Auto-create central board when event is set and board doesn't exist yet
  const [creatingCentral, setCreatingCentral] = useState(false);
  useEffect(() => {
    // undefined = still loading, null = loaded + not found → create it
    if (!eventKey || centralBoard !== null || creatingCentral) return;
    if (centralBoard === undefined) return; // still loading
    setCreatingCentral(true);
    createBoard({
      name: "Central Board",
      type: "central",
      eventKey,
      columns: DEFAULT_COLUMNS,
    }).finally(() => setCreatingCentral(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventKey, centralBoard]);

  async function ensurePersonalBoard() {
    if (!eventKey) { toast.error("Set an event in settings first."); return; }
    if (personalBoard) return;
    await createBoard({ name: "My Board", type: "personal", eventKey, columns: DEFAULT_COLUMNS });
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-3 sm:mb-5 gap-1">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Picklist</h2>
          <p className="text-muted-foreground text-sm">
            {currentEvent?.eventName ?? "No event selected"} · Team ranking workspace
          </p>
        </div>
        <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
          <Users className="h-4 w-4" />
          <span>Shared picklist is visible to all scouts</span>
        </div>
      </div>

      {!eventKey ? (
        <div className="flex flex-col items-center justify-center h-64 gap-2 text-center">
          <p className="text-muted-foreground">No event selected.</p>
          <p className="text-sm text-muted-foreground">
            Set your event in <strong>Settings</strong> to use the picklist.
          </p>
        </div>
      ) : (
        <Tabs defaultValue="central" className="flex-1 flex flex-col">
          <TabsList className="mb-4 self-start">
            <TabsTrigger value="central">🌐 Shared Picklist</TabsTrigger>
            <TabsTrigger value="personal">👤 My Picklist</TabsTrigger>
          </TabsList>

          <TabsContent value="central" className="flex-1">
            {centralBoard === undefined || creatingCentral ? (
              <p className="text-muted-foreground text-sm">Setting up shared picklist…</p>
            ) : centralBoard ? (
              <BoardView
                boardId={centralBoard._id as Id<"kanbanBoards">}
                eventKey={eventKey}
                eventYear={eventYear}
                boardType="central"
              />
            ) : (
              <p className="text-muted-foreground text-sm">Creating board…</p>
            )}
          </TabsContent>

          <TabsContent value="personal" className="flex-1">
            {personalBoard === undefined ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : personalBoard ? (
              <BoardView
                boardId={personalBoard._id as Id<"kanbanBoards">}
                eventKey={eventKey}
                eventYear={eventYear}
                boardType="personal"
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <p className="text-muted-foreground text-sm">
                  You don't have a personal board for this event yet.
                </p>
                <Button onClick={ensurePersonalBoard}>
                  <Plus className="h-4 w-4 mr-1" /> Create My Board
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
