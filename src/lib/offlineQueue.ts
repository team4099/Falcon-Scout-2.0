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

// ── Legacy checklist queue (drain-only) ───────────────────────────────────────
//
// Checklists used to be their own thing: their own page, their own table
// (checklistSubmissions) and this queue, because draining them through
// api.forms.submitForm filed them as scouting rows. They ARE scouting rows now
// — a checklist is just a formType, submitted through ScoutMatchPage like every
// other form — so nothing enqueues here any more.
//
// The read/drain side stays because a scout could have finished a checklist
// offline on the old build and still be carrying it in localStorage. Dropping
// these functions would silently destroy that work. `legacyChecklistToForm`
// converts one into the form payload the current server expects;
// useOfflineSync drains them on the next sync and the queue empties for good.

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

export function dequeueOfflineChecklist(id: string): void {
  const queue = getChecklistQueue().filter((s) => s.id !== id);
  if (queue.length === 0) {
    localStorage.removeItem(CHECKLIST_QUEUE_KEY);
    return;
  }
  localStorage.setItem(CHECKLIST_QUEUE_KEY, JSON.stringify(queue));
}

export function clearChecklistQueue(): void {
  localStorage.removeItem(CHECKLIST_QUEUE_KEY);
}

/**
 * Map a legacy queued checklist onto the current submitForm payload.
 *
 * teamNumber 0 — a checklist has no teamNumber field, and 0 is what the
 * Dashboard and Data Viewer already treat as "not a team submission", so these
 * rows stay out of the team rollups. compLevel "qm" because checklists only
 * ever came from the quals-only pit rotation. assignedScoutId is dropped: the
 * server records the caller as scoutId, and only the assigned scout's own
 * device holds their queue.
 */
export function legacyChecklistToForm(cl: OfflineChecklist): OfflineSubmission {
  return {
    id: cl.id,
    offlineId: cl.offlineId,
    timestamp: cl.timestamp,
    templateId: cl.templateId,
    eventKey: cl.eventKey,
    matchNumber: cl.matchNumber,
    compLevel: "qm",
    teamNumber: 0,
    data: cl.data,
  };
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

// ── Pit duty check-in queue ───────────────────────────────────────────────────
//
// Unlike the other queues this one holds *desired state*, not an op log: at
// most one entry per rotation, latest tap wins. A scout who reports and then
// immediately un-reports while offline should send one final state when the
// uplink returns, not two contradictory writes.

export interface PitDutyOp {
  id: string;
  ts: number;
  eventKey: string;
  rotationId: string;
  /** true = report for duty, false = undo a check-in. */
  reported: boolean;
}

const PIT_DUTY_QUEUE_KEY = "falconscout_pit_duty_queue";

export function getPitDutyQueue(): PitDutyOp[] {
  try {
    const raw = localStorage.getItem(PIT_DUTY_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as PitDutyOp[]) : [];
  } catch {
    return [];
  }
}

/** Queue a check-in state for a rotation, replacing any pending entry for it. */
export function enqueuePitDutyOp(op: { eventKey: string; rotationId: string; reported: boolean }): string {
  const entry: PitDutyOp = { ...op, id: crypto.randomUUID(), ts: Date.now() };
  const queue = getPitDutyQueue().filter((q) => q.rotationId !== op.rotationId);
  queue.push(entry);
  localStorage.setItem(PIT_DUTY_QUEUE_KEY, JSON.stringify(queue));
  return entry.id;
}

export function dequeuePitDutyOp(id: string): void {
  const queue = getPitDutyQueue().filter((op) => op.id !== id);
  localStorage.setItem(PIT_DUTY_QUEUE_KEY, JSON.stringify(queue));
}

export function clearPitDutyQueue(): void {
  localStorage.removeItem(PIT_DUTY_QUEUE_KEY);
}

export function getTotalPendingOps(): number {
  return getOfflineQueue().length + getChecklistQueue().length
    + getKanbanQueue().length + getPitDutyQueue().length;
}
