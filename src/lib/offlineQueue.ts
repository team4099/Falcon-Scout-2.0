// Offline queue for Convex mutations when network is unavailable
// Uses localStorage as a simple persistent queue (IndexedDB can be swapped in later)

// ── Form submission queue ──────────────────────────────────────────────────────

export interface OfflineSubmission {
  id: string;        // internal queue ID
  offlineId: string; // idempotency key sent to server (same as id by default)
  timestamp: number;
  templateId: string;
  eventKey: string;
  matchNumber: number;
  compLevel?: "qm" | "elim";
  teamNumber: number;
  data: string;
}

const QUEUE_KEY = "falconscout_offline_queue";

export function getOfflineQueue(): OfflineSubmission[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as OfflineSubmission[]) : [];
  } catch {
    return [];
  }
}

/** Enqueue a form submission for later sync.
 *  Pass `offlineId` to reuse a UUID that was already sent to the server
 *  (e.g. when a live submit fails mid-flight). */
export function enqueueOfflineSubmission(
  submission: Omit<OfflineSubmission, "id" | "timestamp"> & { offlineId?: string }
): string {
  const queue = getOfflineQueue();
  const id = crypto.randomUUID();
  const entry: OfflineSubmission = {
    ...submission,
    id,
    offlineId: submission.offlineId ?? id, // reuse caller's key or generate one
    timestamp: Date.now(),
  };
  queue.push(entry);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  return entry.offlineId;
}

export function dequeueOfflineSubmission(id: string): void {
  const queue = getOfflineQueue().filter((s) => s.id !== id);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function clearOfflineQueue(): void {
  localStorage.removeItem(QUEUE_KEY);
}

// ── Kanban mutation queue ──────────────────────────────────────────────────────

export type KanbanOp =
  | { id: string; ts: number; type: "moveCard";   cardId: string; columnId: string; position: number }
  | { id: string; ts: number; type: "updateCard"; cardId: string; notes: string }
  | { id: string; ts: number; type: "removeCard"; cardId: string };

type KanbanOpInput =
  | { type: "moveCard";   cardId: string; columnId: string; position: number }
  | { type: "updateCard"; cardId: string; notes: string }
  | { type: "removeCard"; cardId: string };

const KANBAN_QUEUE_KEY = "falconscout_kanban_queue";

export function getKanbanQueue(): KanbanOp[] {
  try {
    const raw = localStorage.getItem(KANBAN_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as KanbanOp[]) : [];
  } catch {
    return [];
  }
}

export function enqueueKanbanOp(op: KanbanOpInput): string {
  const queue = getKanbanQueue();
  const entry = { ...op, id: crypto.randomUUID(), ts: Date.now() } as KanbanOp;
  queue.push(entry);
  localStorage.setItem(KANBAN_QUEUE_KEY, JSON.stringify(queue));
  return entry.id;
}

export function dequeueKanbanOp(id: string): void {
  const queue = getKanbanQueue().filter((op) => op.id !== id);
  localStorage.setItem(KANBAN_QUEUE_KEY, JSON.stringify(queue));
}

export function clearKanbanQueue(): void {
  localStorage.removeItem(KANBAN_QUEUE_KEY);
}

export function getTotalPendingOps(): number {
  return getOfflineQueue().length + getKanbanQueue().length;
}
