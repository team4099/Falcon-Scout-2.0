import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useAdminMutation } from "@/hooks/useAdminMutation";
import { useUIStore } from "@/store/uiStore";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { KanbanColumn, KanbanCard } from "@/types";
import { byPosition, planMove } from "../../convex/kanbanOrder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Plus, X, Pencil, Users, RefreshCw, SlidersHorizontal, LayoutGrid, LayoutList, Check, GripVertical, ChevronDown, Lock } from "lucide-react";
import {
  fetchTBAEventTeams,
  fetchTBATeamInfo,
  fetchTBATeamAvatar,
} from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCached } from "@/hooks/useCached";
import { useCurrentEvent } from "@/hooks/useCurrentEvent";
import { enqueueKanbanOp } from "@/lib/offlineQueue";
import { useEventTeamData } from "@/hooks/useEventTeamData";
import type { EventTeamData } from "@/hooks/useEventTeamData";
import { EMPTY_TEAM_EPA } from "@/lib/epa";
import {
  BUILTIN_COLUMNS,
  PICKLIST_DEFAULT_COLUMNS,
  REPORTS_COLUMN_ID,
  columnShortLabel,
  statCell,
  visibleColumns,
  withDefaults,
} from "@/lib/rankingColumns";
import type { RankingColumn, TeamStats } from "@/lib/rankingColumns";
import TeamDetailPanel from "@/pages/TeamDetailPanel";

// ── Types ─────────────────────────────────────────────────────────────────────

type StatsFor = (teamNumber: number) => TeamStats;

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

// Deterministic accent color per team number
function teamAccentColor(num: number): string {
  const palette = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f97316",
    "#eab308", "#22c55e", "#06b6d4", "#3b82f6",
  ];
  return palette[num % palette.length];
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

// ── Configure Cards Dialog ────────────────────────────────────────────────────

/** Same options as the Dashboard rankings "Columns" menu; applies to both the
 *  board cards and the list view. */
function CardPrefsDialog({
  open,
  onClose,
  columns,
  prefs,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  columns: RankingColumn[];
  prefs: Record<string, boolean>;
  onSave: (prefs: Record<string, boolean>) => void;
}) {
  const resolve = (p: Record<string, boolean>) =>
    Object.fromEntries(columns.map((c) => [c.id, p[c.id] ?? c.defaultVisible]));
  const [draft, setDraft] = useState<Record<string, boolean>>(() => resolve(prefs));
  // Start each opening from the saved prefs.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(resolve(prefs));
  }

  const groups = Array.from(new Set(columns.map((c) => c.group)));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Configure Cards</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-1">
          Stats shown for each team in board and list view.
        </p>

        <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1 space-y-4">
          {groups.map((group) => (
            <div key={group}>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {group === "Stats" ? "Team stats" : group}
              </p>
              {columns.filter((c) => c.group === group).map((c) => (
                <label key={c.id} className="flex items-center gap-3 cursor-pointer py-1.5">
                  <Checkbox
                    checked={draft[c.id] ?? false}
                    onCheckedChange={(v) => setDraft((d) => ({ ...d, [c.id]: v === true }))}
                  />
                  <span className="text-sm">{c.label}</span>
                  {c.id === REPORTS_COLUMN_ID && (
                    <span className="text-xs text-muted-foreground">count</span>
                  )}
                </label>
              ))}
            </div>
          ))}
          {groups.length === 1 && (
            <p className="text-xs text-muted-foreground">
              To show scouting data, tick "Rankings column" on a field in Form Builder.
            </p>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={() => setDraft(resolve({}))}>Reset</Button>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => {
                onSave(draft);
                onClose();
              }}
            >
              Save
            </Button>
          </div>
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

// ── Team Card ─────────────────────────────────────────────────────────────────

/** Makes a card/row open the team profile on click, Enter or Space. */
function openHandlers(onOpen: () => void, label: string) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    onClick: onOpen,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
    },
  };
}

/** Header (avatar, number, name, rank) plus a label-over-value stat grid, so
 *  each stat reads on its own instead of running together on one line. */
function TeamCard({
  card,
  eventYear,
  stats,
  columns,
  isDragging,
  readOnly,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  card: KanbanCard;
  eventYear: number;
  stats: TeamStats;
  columns: RankingColumn[];
  isDragging: boolean;
  readOnly: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent, cardId: string) => void;
  onDragEnd: () => void;
}) {
  const { nickname, avatar } = useTeamInfo(card.teamNumber, eventYear);
  // Rank sits in the header; every other stat goes in the grid.
  const showRank = columns.some((c) => c.id === "rank");
  const statCols = columns.filter((c) => c.id !== "rank");

  return (
    <div
      draggable={!readOnly}
      onDragStart={(e) => onDragStart(e, card._id)}
      onDragEnd={onDragEnd}
      {...openHandlers(onOpen, `Open team ${card.teamNumber} profile`)}
      className={`bg-card border border-border rounded-lg px-3 py-2.5 select-none transition-[border-color,opacity,transform] duration-150 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
      } ${isDragging ? "opacity-40 scale-[0.98]" : ""}`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <TeamAvatar teamNumber={card.teamNumber} avatar={avatar} size={32} />
        <div className="min-w-0 flex-1">
          <p className="font-bold text-sm leading-tight tabular-nums">{card.teamNumber}</p>
          <p className="text-xs text-muted-foreground truncate leading-tight mt-0.5">{nickname ?? " "}</p>
        </div>
        {showRank && stats.rank !== null && (
          <span className="shrink-0 self-start font-mono text-xs text-muted-foreground">#{stats.rank}</span>
        )}
      </div>

      {statCols.length > 0 && (
        <dl
          className="mt-2.5 grid gap-x-2 gap-y-2"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(3.75rem, 1fr))" }}
        >
          {statCols.map((c) => {
            const s = statCell(c.id, stats);
            return (
              <div key={c.id} className="min-w-0">
                <dt className="text-[10px] leading-tight text-muted-foreground truncate">{columnShortLabel(c)}</dt>
                <dd
                  className={`font-mono text-sm font-semibold tabular-nums truncate ${
                    s.empty ? "text-muted-foreground/50" : s.accent ? "text-primary" : ""
                  }`}
                  title={s.display}
                >
                  {s.display}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

// ── Kanban Column ─────────────────────────────────────────────────────────────

function KanbanCol({
  column,
  cards,
  renderCard,
  readOnly,
  isDragTarget,
  isColDragging,
  isColDropTarget,
  onDragOver,
  onDragLeave,
  onDrop,
  onRemoveColumn,
  onRenameColumn,
  onColDragStart,
  onColDragOver,
  onColDrop,
  onColDragEnd,
}: {
  column: KanbanColumn;
  cards: KanbanCard[];
  renderCard: (card: KanbanCard) => React.ReactNode;
  readOnly: boolean;
  isDragTarget: boolean;
  isColDragging: boolean;
  isColDropTarget: boolean;
  onDragOver: (colId: string) => void;
  onDragLeave: () => void;
  onDrop: (colId: string) => void;
  onRemoveColumn: (colId: string) => void;
  onRenameColumn: (colId: string, title: string) => void;
  onColDragStart: (e: React.DragEvent, colId: string) => void;
  onColDragOver: (e: React.DragEvent, colId: string) => void;
  onColDrop: (e: React.DragEvent, colId: string) => void;
  onColDragEnd: () => void;
}) {
  const sorted = [...cards].sort(byPosition);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(column.title);

  function startEditingTitle() {
    if (readOnly) return;
    setTitleDraft(column.title);
    setIsEditingTitle(true);
  }

  function commitTitle() {
    const trimmed = titleDraft.trim();
    setIsEditingTitle(false);
    if (trimmed && trimmed !== column.title) {
      onRenameColumn(column.id, trimmed);
    }
  }

  return (
    <div
      className={`flex flex-col shrink-0 rounded-xl overflow-hidden border transition-all ${
        isColDragging
          ? "opacity-40 scale-95"
          : isColDropTarget
          ? "ring-2 ring-primary/60 border-primary"
          : isDragTarget
          ? "border-primary bg-primary/5 ring-2 ring-primary/30"
          : "border-border bg-muted/30"
      }`}
      style={{
        width: "clamp(260px, 85vw, 300px)",
        scrollSnapAlign: "start",
        borderTopColor: column.color ?? undefined,
        borderTopWidth: column.color ? 3 : undefined,
      }}
      onDragOver={(e) => {
        // If a column is being dragged, route to column drop handler; otherwise card drop
        if (e.dataTransfer.types.includes("application/kanban-col")) {
          onColDragOver(e, column.id);
        } else {
          e.preventDefault();
          onDragOver(column.id);
        }
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes("application/kanban-col")) {
          onColDrop(e, column.id);
        } else {
          e.preventDefault();
          onDrop(column.id);
        }
      }}
    >
      {/* Column header — draggable to reorder */}
      <div
        draggable={!readOnly}
        onDragStart={(e) => onColDragStart(e, column.id)}
        onDragEnd={onColDragEnd}
        className={`flex items-center justify-between px-3 py-2 border-b border-border bg-card ${
          readOnly ? "cursor-default" : "cursor-grab active:cursor-grabbing"
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {!readOnly && <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />}
          {isEditingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") setIsEditingTitle(false);
              }}
              onClick={(e) => e.stopPropagation()}
              draggable={false}
              onDragStart={(e) => e.stopPropagation()}
              className="font-semibold text-sm bg-background border border-primary/50 rounded px-1 py-0.5 min-w-0 flex-1"
            />
          ) : (
            <span
              className={`font-semibold text-sm truncate ${readOnly ? "" : "cursor-text"}`}
              onDoubleClick={startEditingTitle}
            >
              {column.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-muted-foreground shrink-0">
          <span className="text-xs font-mono">{sorted.length}</span>
          {!readOnly && !isEditingTitle && (
            <button
              onClick={startEditingTitle}
              className="p-0.5 rounded hover:bg-primary/10 hover:text-primary"
              title="Rename column"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {!readOnly && (
            <button
              onClick={() => onRemoveColumn(column.id)}
              className="p-0.5 rounded hover:bg-destructive/10 hover:text-destructive"
              title="Delete column"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Cards */}
      <ScrollArea className="flex-1" style={{ maxHeight: "max(260px, calc(100vh - 340px))" }}>
        <div className="px-2 py-1">
          {sorted.map(renderCard)}
          {sorted.length === 0 && (
            <div className={`my-1 rounded-lg border-2 border-dashed py-6 text-center text-xs text-muted-foreground transition-colors ${
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

/** Left block width, shared by the column header and every row so the stat
 *  columns line up. */
const LIST_TEAM_COL = "w-44 sm:w-60";

function listGrid(columns: RankingColumn[]): string {
  return columns.map(() => "minmax(4.5rem, 1fr)").join(" ");
}

function ListTeamRow({
  card,
  eventYear,
  stats,
  columns,
  isPicked,
  isDragging,
  readOnly,
  onTogglePick,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  card: KanbanCard;
  eventYear: number;
  stats: TeamStats;
  columns: RankingColumn[];
  isPicked: boolean;
  isDragging: boolean;
  readOnly: boolean;
  onTogglePick: () => void;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { nickname, avatar } = useTeamInfo(card.teamNumber, eventYear);

  return (
    <div
      draggable={!readOnly}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      {...openHandlers(onOpen, `Open team ${card.teamNumber} profile`)}
      className={`group flex items-center gap-3 px-3 py-2 border-b border-border transition-colors select-none focus-visible:outline-none focus-visible:bg-muted/50 ${
        isDragging
          ? "opacity-40 bg-primary/5"
          : isPicked
          ? "opacity-35 bg-muted/20"
          : "hover:bg-muted/40"
      } ${readOnly ? "cursor-pointer" : isDragging ? "cursor-grabbing" : "cursor-grab"}`}
    >
      <div className={`flex items-center gap-3 shrink-0 ${LIST_TEAM_COL}`}>
        {/* Drag handle slot is kept when read-only so columns stay aligned */}
        <GripVertical
          className={`h-4 w-4 shrink-0 transition-colors ${
            readOnly ? "invisible" : "text-muted-foreground/30 group-hover:text-muted-foreground/60"
          }`}
        />

        {/* Pick toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); onTogglePick(); }}
          className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
            isPicked
              ? "bg-muted-foreground/40 border-muted-foreground/40"
              : "border-border hover:border-primary hover:bg-primary/10"
          }`}
          title={isPicked ? "Unmark picked" : "Mark as picked"}
          aria-label={isPicked ? `Unmark team ${card.teamNumber} picked` : `Mark team ${card.teamNumber} picked`}
        >
          {isPicked && <Check className="h-3 w-3 text-muted-foreground" />}
        </button>

        <TeamAvatar teamNumber={card.teamNumber} avatar={avatar} size={28} />

        <div className="min-w-0">
          <p className={`font-bold text-sm leading-tight tabular-nums ${isPicked ? "line-through text-muted-foreground" : ""}`}>
            {card.teamNumber}
          </p>
          <p className="text-xs text-muted-foreground truncate leading-tight">{nickname ?? " "}</p>
        </div>
      </div>

      {columns.length > 0 && (
        <div className="grid flex-1 gap-x-3 items-center" style={{ gridTemplateColumns: listGrid(columns) }}>
          {columns.map((c) => {
            const s = statCell(c.id, stats);
            return (
              <span
                key={c.id}
                title={s.display}
                className={`font-mono text-sm font-semibold tabular-nums truncate ${
                  s.empty ? "text-muted-foreground/50" : s.accent ? "text-primary" : ""
                }`}
              >
                {s.display}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── List View ─────────────────────────────────────────────────────────────────

function ListView({
  columns,
  cards,
  eventYear,
  statColumns,
  statsFor,
  pickedTeams,
  readOnly,
  onTogglePick,
  onClearPicked,
  onMoveCard,
  onOpenTeam,
}: {
  columns: KanbanColumn[];
  cards: KanbanCard[];
  eventYear: number;
  /** Stats chosen in Configure Cards, in display order. */
  statColumns: RankingColumn[];
  statsFor: StatsFor;
  pickedTeams: Set<number>;
  readOnly: boolean;
  onTogglePick: (teamNumber: number) => void;
  onClearPicked: () => void;
  onMoveCard: (cardId: string, columnId: string, position: number) => void;
  onOpenTeam: (teamNumber: number) => void;
}) {
  // ── Internal display order (survives re-renders, resets on server update) ──
  const defaultSort = (arr: KanbanCard[]) =>
    [...arr].sort((a, b) => {
      const ai = columns.findIndex((c) => c.id === a.columnId);
      const bi = columns.findIndex((c) => c.id === b.columnId);
      if (ai !== bi) return ai - bi;
      return byPosition(a, b);
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
    if (readOnly) { e.preventDefault(); return; }
    setListDragId(cardId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", cardId);
  }

  function handleDragEnd() {
    setListDragId(null);
    setDropInfo(null);
    setHeaderDrop(null);
  }

  /** Updates the visual indicator as the cursor moves over a row.
   *  Uses drag *direction* (up vs down in the list) instead of a Y-midpoint
   *  split so that dragging over an adjacent item always shows a swap. */
  function handleRowDragOver(e: React.DragEvent, cardId: string) {
    e.preventDefault();
    if (!listDragId || listDragId === cardId) return;
    const dragIdx   = orderedCards.findIndex((c) => c._id === listDragId);
    const targetIdx = orderedCards.findIndex((c) => c._id === cardId);
    // Dragging UP → indicator above target; dragging DOWN → indicator below target
    const before = dragIdx > targetIdx;
    setDropInfo((prev) =>
      prev?.cardId === cardId && prev?.before === before ? prev : { cardId, before }
    );
    setHeaderDrop(null);
  }

  /** Performs the actual reorder using drag direction, not cursor Y-position.
   *  This prevents the dead-zone where dragging an adjacent card did nothing. */
  function handleRowDrop(e: React.DragEvent, targetCardId: string) {
    e.preventDefault();
    if (!listDragId || listDragId === targetCardId) { handleDragEnd(); return; }

    const dragCard   = orderedCards.find((c) => c._id === listDragId);
    const targetCard = orderedCards.find((c) => c._id === targetCardId);
    if (!dragCard || !targetCard) { handleDragEnd(); return; }

    const dragIdx   = orderedCards.findIndex((c) => c._id === listDragId);
    const targetIdx = orderedCards.findIndex((c) => c._id === targetCardId);
    const draggingDown = dragIdx < targetIdx;

    const withoutDrag   = orderedCards.filter((c) => c._id !== listDragId);
    const newTargetIdx  = withoutDrag.findIndex((c) => c._id === targetCardId);
    // Dragging DOWN → insert after target; dragging UP → insert before target
    const insertIdx     = draggingDown ? newTargetIdx + 1 : newTargetIdx;

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

      {/* List — grouped by column / tier; scrolls sideways on a phone when
          many stats are shown, so the columns never squash. */}
      <div className="flex-1 min-h-0 overflow-auto border border-t-0 border-border rounded-b-xl bg-card">
        <div style={{ minWidth: 264 + statColumns.length * 84 }}>
        {/* Column labels, aligned with every row's stat grid */}
        <div className="sticky top-0 z-20 flex items-center gap-3 h-8 px-3 border-b border-border bg-card text-[11px] text-muted-foreground">
          <span className={`shrink-0 pl-[3.75rem] ${LIST_TEAM_COL}`}>Team</span>
          {statColumns.length > 0 && (
            <div className="grid flex-1 gap-x-3" style={{ gridTemplateColumns: listGrid(statColumns) }}>
              {statColumns.map((c) => (
                <span key={c.id} className="truncate" title={c.label}>{columnShortLabel(c)}</span>
              ))}
            </div>
          )}
        </div>
        {groups.map(({ column, cards: colCards }) => (
          <div key={column.id}>
            {/* Section header — also a drop zone (insert at top of section) */}
            <div
              onDragOver={(e) => handleHeaderDragOver(e, column.id)}
              onDragLeave={() => setHeaderDrop(null)}
              onDrop={(e) => handleHeaderDrop(e, column.id)}
              className={`sticky top-8 z-10 flex items-center gap-2 px-4 py-1.5 border-b border-border backdrop-blur transition-colors ${
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
                    stats={statsFor(card.teamNumber)}
                    columns={statColumns}
                    isPicked={pickedTeams.has(card.teamNumber)}
                    isDragging={listDragId === card._id}
                    readOnly={readOnly}
                    onTogglePick={() => onTogglePick(card.teamNumber)}
                    onOpen={() => onOpenTeam(card.teamNumber)}
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
        </div>
      </div>
    </div>
  );
}

// ── Board View ────────────────────────────────────────────────────────────────

function BoardView({
  boardId,
  eventKey,
  eventYear,
  boardType,
  data,
}: {
  boardId: Id<"kanbanBoards">;
  eventKey: string;
  eventYear: number;
  boardType: "personal" | "central";
  /** Event stats + submissions, shared with the Dashboard. */
  data: EventTeamData;
}) {
  // ── Convex queries with offline cache fallback ───────────────────────────
  const boardLive = useQuery(
    boardType === "central" ? api.kanban.getCentralBoard : api.kanban.getPersonalBoard,
    { eventKey }
  );
  const board = useCached(boardLive, `kanban_board_${boardType}_${eventKey}`);

  const rawCardsLive = useQuery(api.kanban.getBoardCards, { boardId });
  const rawCardsCached = useCached(rawCardsLive, `kanban_cards_${boardId}`);

  const updateColumns    = useAdminMutation(api.kanban.updateBoardColumns);
  const moveCardMutation = useMutation(api.kanban.moveCard);
  const updateCardMutation = useMutation(api.kanban.updateCard);
  const seedTeamsMutation  = useAdminMutation(api.kanban.seedTeams);

  const [openTeam, setOpenTeam]         = useState<number | null>(null);
  const [newColName, setNewColName]     = useState("");
  const [seeding, setSeeding]           = useState(false);
  const [cardPrefsOpen, setCardPrefsOpen] = useState(false);
  // Card stats: the Dashboard's column options, with picklist defaults.
  const cardPrefs = useUIStore((s) => s.picklistColumns);
  const setCardPrefs = useUIStore((s) => s.setPicklistColumns);
  const allStatColumns = useMemo(
    () => withDefaults([...BUILTIN_COLUMNS, ...data.fieldColumns], PICKLIST_DEFAULT_COLUMNS),
    [data.fieldColumns]
  );
  const statColumns = useMemo(() => visibleColumns(allStatColumns, cardPrefs), [allStatColumns, cardPrefs]);
  const [viewMode, setViewMode]         = useState<"board" | "list">("board");
  const [pickedTeams, setPickedTeams]   = useState<Set<number>>(() => getPickedTeams(String(boardId)));
  const { isAdminMode } = useUIStore();
  // The shared board is admin-only to edit (enforced in convex/kanban.ts);
  // a personal board is always editable by its owner. This only hides the
  // controls — the server is the real gate.
  const canEdit = boardType === "personal" || isAdminMode;
  const [unsortedOpen, setUnsortedOpen] = useState(true);
  // Distinguishes "TBA had nothing for us" from "you aren't an admin, so the
  // board can't be populated" — the latter used to be swallowed, leaving a
  // scout staring at an empty picklist with no explanation. Only the failure
  // needs state; the non-admin case is derivable during render.
  const [seedFailed, setSeedFailed] = useState(false);
  const seededRef = useRef(false);

  // Optimistic offline state
  const [localMoves, setLocalMoves]         = useState<Record<string, { columnId: string; position: number }>>({});

  const draggingCardId   = useRef<string | null>(null);
  const [activeDragCardId, setActiveDragCardId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId]       = useState<string | null>(null);
  const [cardDropInfo, setCardDropInfo]         = useState<{ cardId: string; before: boolean } | null>(null);

  // Column drag-to-reorder state
  const [draggingColId, setDraggingColId]       = useState<string | null>(null);
  const [colDropTargetId, setColDropTargetId]   = useState<string | null>(null);

  // Confirmation state for destructive actions
  const [confirmRemoveColId, setConfirmRemoveColId]   = useState<string | null>(null);

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
      .map((c) => {
        const move = localMoves[c._id];
        return move ? { ...c, columnId: move.columnId, position: move.position } : c;
      });
  }, [rawCardsCached, localMoves]);

  // Clear optimistic overrides once Convex confirms the real state
  useEffect(() => {
    if (rawCardsLive === undefined) return;
    setLocalMoves({});
  }, [rawCardsLive]);

  // Flat ordering (by column, then position) used to figure out drag direction
  // and insertion index when reordering cards within a board column.
  const orderedForBoard = useMemo(
    () =>
      [...cards].sort((a, b) => {
        const ai = columns.findIndex((c) => c.id === a.columnId);
        const bi = columns.findIndex((c) => c.id === b.columnId);
        if (ai !== bi) return ai - bi;
        return byPosition(a, b);
      }),
    [cards, columns]
  );

  const statsFor: StatsFor = (team) => ({
    rank: (data.tbaRankings[team] as { rank?: number } | undefined)?.rank ?? null,
    avgScore: data.avgScoreByTeam[team] ?? null,
    epa: data.epaMap[team] ?? EMPTY_TEAM_EPA,
    reportCount: data.submissionsByTeam[team]?.length ?? 0,
    fieldCells: data.fieldCellsByTeam[team] ?? {},
  });

  // ── Auto-seed TBA teams ──────────────────────────────────────────────────
  useEffect(() => {
    if (!board || rawCardsCached === undefined || seededRef.current) return;
    if (!navigator.onLine) return; // skip seeding when offline
    // seedTeams is admin-only on the shared board. Calling it as a regular scout
    // always threw, and the empty catch below hid that — so the shared board only
    // ever filled if an admin happened to open this page first.
    if (!canEdit) return;
    seededRef.current = true;

    const unsortedCol = columns.find((c) => c.id === "unsorted") ?? columns[columns.length - 1];
    if (!unsortedCol) return;

    async function seed() {
      setSeeding(true);
      try {
        const tbaData = await fetchTBAEventTeams(eventKey);
        if (!Array.isArray(tbaData)) { setSeedFailed(true); return; }
        const teamNumbers = (tbaData as Array<{ team_number: number }>).map((t) => t.team_number);
        if (!teamNumbers.length) return;
        const added = await seedTeamsMutation({ boardId, eventKey, columnId: unsortedCol!.id, teamNumbers });
        if (added > 0) toast.success(`Added ${added} teams from TBA`);
      } catch (err) {
        // TBA might not have data yet — but surface anything else.
        console.error("[FalconScout] Picklist auto-seed failed:", err);
        setSeedFailed(true);
      } finally {
        setSeeding(false);
      }
    }
    seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board?._id, rawCardsCached !== undefined, canEdit]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleResync() {
    if (!board) return;
    const unsortedCol = columns.find((c) => c.id === "unsorted") ?? columns[columns.length - 1];
    if (!unsortedCol) return;
    setSeeding(true);
    try {
      const tbaData = await fetchTBAEventTeams(eventKey);
      if (!Array.isArray(tbaData)) { toast.error("Couldn't reach TBA — try again shortly."); return; }
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
    const title = newColName.trim();
    if (!title) {
      toast.error("Give the column a name first.");
      return;
    }
    const newCol: KanbanColumn = {
      id: crypto.randomUUID().slice(0, 8),
      title,
      color: "#EAB308",
    };
    // Insert before the unsorted column (always keep unsorted last)
    const unsortedIdx = columns.findIndex((c) => c.id === "unsorted");
    const insertBefore = unsortedIdx !== -1 ? unsortedIdx : columns.length;
    const next = [
      ...columns.slice(0, insertBefore),
      newCol,
      ...columns.slice(insertBefore),
    ];
    // updateColumns is admin-gated. Without this the mutation rejected silently
    // and the column simply never appeared — the "add column doesn't work" report.
    try {
      await updateColumns({ boardId, columns: next });
      setNewColName("");
    } catch (err) {
      toast.error(
        err instanceof Error && /admin/i.test(err.message)
          ? "Adding a column needs admin mode."
          : "Couldn't add the column. Try again."
      );
    }
  }

  async function handleRemoveColumn(colId: string) {
    if (colId === "unsorted") return; // Unsorted is permanent
    setConfirmRemoveColId(colId);
  }

  async function handleRenameColumn(colId: string, title: string) {
    const next = columns.map((c) => (c.id === colId ? { ...c, title } : c));
    try {
      await updateColumns({ boardId, columns: next });
    } catch (err) {
      toast.error(
        err instanceof Error && /admin/i.test(err.message)
          ? "Renaming a column needs admin mode."
          : "Couldn't rename the column. Try again."
      );
    }
  }

  async function doRemoveColumn(colId: string) {
    await updateColumns({ boardId, columns: columns.filter((c) => c.id !== colId) });
  }

  // ── Column drag-to-reorder handlers ─────────────────────────────────────

  function handleColDragStart(e: React.DragEvent, colId: string) {
    if (!canEdit) { e.preventDefault(); return; }
    setDraggingColId(colId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/kanban-col", colId);
    e.dataTransfer.setData("text/plain", colId);
  }

  function handleColDragOver(e: React.DragEvent, colId: string) {
    e.preventDefault();
    if (!draggingColId || draggingColId === colId) return;
    setColDropTargetId(colId);
  }

  async function handleColDrop(e: React.DragEvent, targetColId: string) {
    e.preventDefault();
    const srcId = draggingColId;
    setDraggingColId(null);
    setColDropTargetId(null);
    if (!srcId || srcId === targetColId) return;

    const srcIdx    = columns.findIndex((c) => c.id === srcId);
    const tgtIdx    = columns.findIndex((c) => c.id === targetColId);
    if (srcIdx === -1 || tgtIdx === -1) return;

    const srcCol = columns[srcIdx];

    // Direction-aware: dragging right → land at target's position (insert after);
    // dragging left → land at target's position (insert before).
    // Both cases produce "you land exactly where the target was" — mirroring
    // the list-card behaviour so hovering over any column swaps with it.
    const movingForward = srcIdx < tgtIdx;
    const withoutSrc    = columns.filter((c) => c.id !== srcId);
    const newTargetIdx  = withoutSrc.findIndex((c) => c.id === targetColId);
    const insertIdx     = movingForward ? newTargetIdx + 1 : newTargetIdx;

    const reordered = [
      ...withoutSrc.slice(0, insertIdx),
      srcCol,
      ...withoutSrc.slice(insertIdx),
    ];

    // Always keep unsorted last
    const unsorted = reordered.find((c) => c.id === "unsorted");
    const rest      = reordered.filter((c) => c.id !== "unsorted");
    const final     = unsorted ? [...rest, unsorted] : rest;

    await updateColumns({ boardId, columns: final });
  }

  function handleColDragEnd() {
    setDraggingColId(null);
    setColDropTargetId(null);
  }

  // ── Drag handlers ─────────────────────────────────────────────────────────

  function handleDragStart(e: React.DragEvent, cardId: string) {
    if (!canEdit) { e.preventDefault(); return; }
    draggingCardId.current = cardId;
    setActiveDragCardId(cardId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", cardId);
  }

  function handleDragEnd() {
    draggingCardId.current = null;
    setActiveDragCardId(null);
    setDragOverColId(null);
    setCardDropInfo(null);
  }

  // Over empty column space (cards stop propagation), so no card indicator.
  function handleDragOver(colId: string) { setDragOverColId(colId); setCardDropInfo(null); }
  function handleDragLeave() { setTimeout(() => setDragOverColId((p) => p), 50); }

  /** Optimistically apply a move (renumbering the affected columns exactly as
   *  the server's moveCard will), then persist it or queue it offline. */
  async function commitMove(cardId: string, columnId: string, position: number) {
    const changes = planMove(cards, cardId, columnId, position);
    if (changes.length === 0) return;
    setLocalMoves((prev) => {
      const next = { ...prev };
      for (const m of changes) next[m.card._id] = { columnId: m.columnId, position: m.position };
      return next;
    });

    if (navigator.onLine) {
      try {
        await moveCardMutation({ cardId: cardId as Id<"kanbanCards">, columnId, position });
      } catch {
        // Revert on failure
        setLocalMoves((prev) => {
          const next = { ...prev };
          for (const m of changes) delete next[m.card._id];
          return next;
        });
        toast.error("Failed to move card");
      }
    } else {
      enqueueKanbanOp({ type: "moveCard", cardId, columnId, position });
      toast.info("Move saved — will sync when online", { duration: 2000 });
    }
  }

  /** Dropped on a column's empty space (not on a card): send it to the end. */
  async function handleDrop(targetColId: string) {
    const cardId = draggingCardId.current;
    setDragOverColId(null);
    setActiveDragCardId(null);
    setCardDropInfo(null);
    draggingCardId.current = null;
    if (!cardId) return;
    const others = cards.filter((c) => c.columnId === targetColId && c._id !== cardId);
    await commitMove(cardId, targetColId, others.length);
  }

  /** Drag-over indicator for reordering within (or across) a board column —
   *  mirrors ListView's per-row indicator so both views feel consistent. */
  function handleCardDragOver(e: React.DragEvent, targetCardId: string) {
    e.preventDefault();
    e.stopPropagation(); // don't let the column's onDragOver also fire
    const dragId = draggingCardId.current;
    if (!dragId || dragId === targetCardId) return;
    const dragIdx   = orderedForBoard.findIndex((c) => c._id === dragId);
    const targetIdx = orderedForBoard.findIndex((c) => c._id === targetCardId);
    const before = dragIdx > targetIdx;
    setCardDropInfo((prev) =>
      prev?.cardId === targetCardId && prev?.before === before ? prev : { cardId: targetCardId, before }
    );
    setDragOverColId(null);
  }

  /** Drops a card onto another card to reorder it within a tier (or move it
   *  into a different tier at that exact spot), instead of always appending
   *  to the end of the target column. */
  async function handleCardDrop(e: React.DragEvent, targetCardId: string) {
    e.preventDefault();
    e.stopPropagation();
    const cardId = draggingCardId.current;
    setDragOverColId(null);
    setActiveDragCardId(null);
    setCardDropInfo(null);
    draggingCardId.current = null;
    if (!cardId || cardId === targetCardId) return;

    const dragCard   = cards.find((c) => c._id === cardId);
    const targetCard = cards.find((c) => c._id === targetCardId);
    if (!dragCard || !targetCard) return;

    const dragIdx   = orderedForBoard.findIndex((c) => c._id === cardId);
    const targetIdx = orderedForBoard.findIndex((c) => c._id === targetCardId);
    const draggingDown = dragIdx < targetIdx;

    const withoutDrag  = orderedForBoard.filter((c) => c._id !== cardId);
    const newTargetIdx = withoutDrag.findIndex((c) => c._id === targetCardId);
    const insertIdx    = draggingDown ? newTargetIdx + 1 : newTargetIdx;

    const newOrder = [
      ...withoutDrag.slice(0, insertIdx),
      { ...dragCard, columnId: targetCard.columnId },
      ...withoutDrag.slice(insertIdx),
    ];

    const newColCards = newOrder.filter((c) => c.columnId === targetCard.columnId);
    const position = Math.max(0, newColCards.findIndex((c) => c._id === cardId));
    await commitMove(cardId, targetCard.columnId, position);
  }

  /** Notes live on the board's card: admin-only on the shared board,
   *  owner-only on a personal one (convex/kanban.ts requireBoardWrite). */
  async function handleSaveNotes(cardId: string, notes: string) {
    if (navigator.onLine) {
      try {
        await updateCardMutation({ cardId: cardId as Id<"kanbanCards">, notes });
        toast.success("Notes saved");
      } catch {
        toast.error("Failed to save notes");
      }
    } else {
      enqueueKanbanOp({ type: "updateCard", cardId, notes });
      toast.success("Notes saved, will sync when online");
    }
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

  // Unsorted lives in its own panel above the board; tiers are the columns.
  const unsortedCol   = columns.find((c) => c.id === "unsorted");
  const tierColumns   = columns.filter((c) => c.id !== "unsorted");
  const unsortedCards = cards
    .filter((c) => c.columnId === "unsorted")
    .sort(byPosition);

  function renderCard(card: KanbanCard) {
    const showAbove = cardDropInfo?.cardId === card._id && cardDropInfo.before  && activeDragCardId !== card._id;
    const showBelow = cardDropInfo?.cardId === card._id && !cardDropInfo.before && activeDragCardId !== card._id;
    return (
      <div
        key={card._id}
        className="relative py-1"
        onDragOver={(e) => handleCardDragOver(e, card._id)}
        onDrop={(e) => handleCardDrop(e, card._id)}
      >
        {showAbove && <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary z-20 pointer-events-none" />}
        <TeamCard
          card={card}
          eventYear={eventYear}
          stats={statsFor(card.teamNumber)}
          columns={statColumns}
          isDragging={activeDragCardId === card._id}
          readOnly={!canEdit}
          onOpen={() => setOpenTeam(card.teamNumber)}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />
        {showBelow && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary z-20 pointer-events-none" />}
      </div>
    );
  }

  const openCard = openTeam !== null ? cards.find((c) => c.teamNumber === openTeam) ?? null : null;

  // Show cached board skeleton while loading; never fully block on Convex
  if (!board && rawCardsCached === undefined) {
    return <div className="text-muted-foreground text-sm">Loading board…</div>;
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Add column — available on mobile too; it used to be hidden below sm,
            which read as the feature being broken on a phone. */}
        {canEdit ? (
        <div className="flex items-center gap-2">
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
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5" />
            <span>View only — admins edit the shared picklist</span>
          </div>
        )}

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
          {canEdit && (
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
          )}
        </div>
      </div>

      {/* Picklist could not be auto-populated (non-admin, or TBA had nothing) */}
      {(!canEdit || seedFailed) && cards.length === 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs">
          <span className="shrink-0">⚠</span>
          <span>
            {canEdit
              ? "This board is empty — couldn't load the event's teams from TBA. Press \"Sync Teams\" to retry."
              : "This board is empty and couldn't be filled automatically. Adding the event's teams requires admin — turn on Admin Mode in Settings, then press \"Sync Teams\"."}
          </span>
        </div>
      )}

      {/* EPA status banner */}
      {data.sbError && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs">
          <span>Statbotics EPA data is unavailable right now, so EPA stats show a dash.</span>
          <button
            className="ml-auto shrink-0 underline hover:text-amber-500 transition-colors"
            onClick={data.reloadExternal}
          >
            Retry
          </button>
        </div>
      )}

      {data.sbNoData && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs">
          <span>
            Statbotics has no event EPA for this event on any host that answered
            {data.sbNoData.downHost ? ` (${data.sbNoData.downHost} is unreachable)` : ""}, so event EPA stats show a dash.
          </span>
          <button
            className="ml-auto shrink-0 underline hover:text-amber-500 transition-colors"
            onClick={data.reloadExternal}
          >
            Retry
          </button>
        </div>
      )}

      {/* Board or List view */}
      {viewMode === "board" ? (
        <div className="flex flex-col gap-3 flex-1 min-h-0">
          {/* Unsorted — a wrapping, scrollable pool above the tiers */}
          {unsortedCol && (
            <div
              className={`rounded-xl border transition-all ${
                dragOverColId === unsortedCol.id
                  ? "border-primary bg-primary/5 ring-2 ring-primary/30"
                  : "border-border bg-muted/30"
              }`}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("application/kanban-col")) return;
                e.preventDefault();
                handleDragOver(unsortedCol.id);
              }}
              onDragLeave={handleDragLeave}
              onDrop={(e) => {
                if (e.dataTransfer.types.includes("application/kanban-col")) return;
                e.preventDefault();
                handleDrop(unsortedCol.id);
              }}
            >
              <button
                onClick={() => setUnsortedOpen((o) => !o)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left ${unsortedOpen ? "border-b border-border" : ""}`}
              >
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${unsortedOpen ? "" : "-rotate-90"}`} />
                <span className="font-semibold text-sm">{unsortedCol.title}</span>
                <span className="text-xs font-mono text-muted-foreground">{unsortedCards.length}</span>
                {canEdit && unsortedCards.length > 0 && (
                  <span className="ml-auto text-xs text-muted-foreground hidden sm:inline">
                    Drag teams into a tier below
                  </span>
                )}
              </button>
              {unsortedOpen && (
                <div
                  className="max-h-[min(236px,32vh)] overflow-y-auto px-2 py-1 grid gap-x-2"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
                >
                  {unsortedCards.map(renderCard)}
                  {unsortedCards.length === 0 && (
                    <div className="col-span-full py-3 text-center text-xs text-muted-foreground">
                      {activeDragCardId ? "Drop here to unsort" : "Every team is sorted into a tier."}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tiers — always scroll horizontally; columns have min-width for portrait mobile */}
          <div className="flex gap-3 overflow-x-auto pb-4 flex-1" style={{ scrollSnapType: "x mandatory" }}>
            {tierColumns.map((col) => (
              <KanbanCol
                key={col.id}
                column={col}
                cards={cards.filter((c) => c.columnId === col.id)}
                renderCard={renderCard}
                readOnly={!canEdit}
                isDragTarget={dragOverColId === col.id}
                isColDragging={draggingColId === col.id}
                isColDropTarget={colDropTargetId === col.id}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onRemoveColumn={handleRemoveColumn}
                onRenameColumn={handleRenameColumn}
                onColDragStart={handleColDragStart}
                onColDragOver={handleColDragOver}
                onColDrop={handleColDrop}
                onColDragEnd={handleColDragEnd}
              />
            ))}

            {tierColumns.length === 0 && (
              <div className="flex items-center justify-center h-48 w-full border-2 border-dashed border-border rounded-xl text-muted-foreground text-sm">
                {canEdit ? "No tiers yet — add a column above." : "No tiers yet."}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* List view — flat ordered list with pick toggles */
        <ListView
          columns={columns}
          cards={cards}
          eventYear={eventYear}
          statColumns={statColumns}
          statsFor={statsFor}
          pickedTeams={pickedTeams}
          readOnly={!canEdit}
          onTogglePick={handleTogglePick}
          onClearPicked={handleClearPicked}
          onMoveCard={handleMoveInList}
          onOpenTeam={setOpenTeam}
        />
      )}

      {/* Team profile (same panel as the Dashboard) + picklist Notes tab */}
      {openCard && (
        <TeamDetailPanel
          key={openCard.teamNumber}
          teamNumber={openCard.teamNumber}
          eventKey={eventKey}
          eventYear={eventYear}
          submissions={data.submissionsByTeam[openCard.teamNumber] ?? []}
          fields={data.fields}
          epa={data.epaMap[openCard.teamNumber] ?? EMPTY_TEAM_EPA}
          avgScore={data.avgScoreByTeam[openCard.teamNumber] ?? null}
          tbaRank={data.tbaRankings[openCard.teamNumber] ?? null}
          pitSubmissions={data.pitSubmissionsByTeam[openCard.teamNumber] ?? []}
          pitFields={data.pitFields}
          templates={data.allTemplates}
          epaByTeam={data.epaMap}
          avgScoreByTeam={data.avgScoreByTeam}
          submissionsByTeam={data.submissionsByTeam}
          notes={{
            value: openCard.notes ?? "",
            canEdit,
            readOnlyHint: "Only admins can edit notes on the shared picklist.",
            onSave: (text) => handleSaveNotes(openCard._id, text),
          }}
          onClose={() => setOpenTeam(null)}
        />
      )}

      {/* Card prefs dialog */}
      <CardPrefsDialog
        open={cardPrefsOpen}
        onClose={() => setCardPrefsOpen(false)}
        columns={allStatColumns}
        prefs={cardPrefs}
        onSave={setCardPrefs}
      />

      {/* Confirm remove column */}
      {(() => {
        const col = confirmRemoveColId ? columns.find((c) => c.id === confirmRemoveColId) : null;
        const cardCount = confirmRemoveColId ? cards.filter((c) => c.columnId === confirmRemoveColId).length : 0;
        return (
          <AlertDialog
            open={!!confirmRemoveColId}
            onOpenChange={(o) => { if (!o) setConfirmRemoveColId(null); }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete column "{col?.title ?? ""}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  {cardCount > 0
                    ? <><strong className="text-foreground">{cardCount} team{cardCount !== 1 ? "s" : ""}</strong> will be moved to the Unsorted column. This cannot be undone.</>
                    : "This empty column will be permanently deleted."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                  onClick={() => {
                    const id = confirmRemoveColId!;
                    setConfirmRemoveColId(null);
                    doRemoveColumn(id);
                  }}
                >
                  Delete Column
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        );
      })()}
    </div>
  );
}

// ── Kanban Page ───────────────────────────────────────────────────────────────

export default function KanbanPage() {
  const currentEvent = useCurrentEvent();
  const createBoard = useMutation(api.kanban.createBoard);
  const { isAdminMode } = useUIStore();

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
  // Loaded once here so switching Shared/My Picklist doesn't refetch.
  const teamData = useEventTeamData(eventKey);

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
    if (!isAdminMode) return; // creating the shared board is admin-only
    setCreatingCentral(true);
    createBoard({
      name: "Central Board",
      type: "central",
      eventKey,
      columns: DEFAULT_COLUMNS,
    })
      .catch(() => toast.error("Couldn't set up the shared picklist."))
      .finally(() => setCreatingCentral(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventKey, centralBoard, isAdminMode]);

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
          <span>Shared picklist: everyone views, admins edit</span>
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
                data={teamData}
              />
            ) : isAdminMode ? (
              <p className="text-muted-foreground text-sm">Creating board…</p>
            ) : (
              <p className="text-muted-foreground text-sm">
                The shared picklist hasn't been set up for this event yet — an admin
                needs to open this page with Admin Mode on.
              </p>
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
                data={teamData}
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
