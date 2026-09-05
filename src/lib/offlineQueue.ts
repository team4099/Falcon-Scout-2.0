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
  // offlineId must be omitted from the base type as well: intersecting a
  // required property with an optional one leaves it required.
  submission: Omit<OfflineSubmission, "id" | "timestamp" | "offlineId"> & { offlineId?: string }
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

// ── Checklist submission queue ─────────────────────────────────────────────────
//
// Checklists need their own queue. They used to be pushed onto the form queue
// above, which useOfflineSync drains through api.forms.submitForm — so a
// checklist completed offline never reached checklistSubmissions at all. It was
// filed as a scouting submission with teamNumber 0, polluting the Data Viewer,
// losing assignedScoutId (the form queue has no such field), and paying out the
// scouting reward. These go to api.checklists.submitChecklist instead.

export interface OfflineChecklist {
  id: string;        // internal queue ID
  offlineId: string; // idempotency key sent to server
  timestamp: number;
  templateId: string;
  eventKey: string;
  matchNumber: number;
  assignedScoutId: string;
  data: string;
}

const CHECKLIST_QUEUE_KEY = "falconscout_checklist_queue";

export function getChecklistQueue(): OfflineChecklist[] {
  try {
    const raw = localStorage.getItem(CHECKLIST_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as OfflineChecklist[]) : [];
  } catch {
    return [];
  }
}

export function enqueueOfflineChecklist(
  submission: Omit<OfflineChecklist, "id" | "timestamp" | "offlineId"> & { offlineId?: string }
): string {
  const queue = getChecklistQueue();
  const id = crypto.randomUUID();
  const entry: OfflineChecklist = {
    ...submission,
    id,
    offlineId: submission.offlineId ?? id,
    timestamp: Date.now(),
  };
  queue.push(entry);
  localStorage.setItem(CHECKLIST_QUEUE_KEY, JSON.stringify(queue));
  return entry.offlineId;
}

export function dequeueOfflineChecklist(id: string): void {
  const queue = getChecklistQueue().filter((s) => s.id !== id);
  localStorage.setItem(CHECKLIST_QUEUE_KEY, JSON.stringify(queue));
}

export function clearChecklistQueue(): void {
  localStorage.removeItem(CHECKLIST_QUEUE_KEY);
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
  return getOfflineQueue().length + getChecklistQueue().length + getKanbanQueue().length;
}
