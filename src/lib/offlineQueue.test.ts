/**
 * Offline queue routing and idempotency.
 *
 * Two audit findings live here:
 *  - useOfflineSync sent the queue's internal `id` as the server's idempotency
 *    key instead of `offlineId`. They diverge exactly when it matters — an
 *    online submit that failed mid-flight is re-queued under the offlineId the
 *    server may already hold — so the server saw a fresh key, inserted a
 *    duplicate row, and paid the scout twice.
 *  - Offline checklists were pushed onto the form queue, which drains through
 *    api.forms.submitForm, so they were filed as scouting submissions and never
 *    reached checklistSubmissions at all. Checklists have since been merged
 *    back into the ordinary form flow deliberately, so that queue is now
 *    drain-only — the tests below pin the migration shape instead, since a
 *    scout can still be carrying pre-merge entries.
 */
import { describe, expect, test, beforeEach } from "vitest";
import {
  enqueueOfflineSubmission,
  getOfflineQueue,
  getChecklistQueue,
  dequeueOfflineChecklist,
  legacyChecklistToForm,
  getTotalPendingOps,
  type OfflineChecklist,
} from "./offlineQueue";

beforeEach(() => localStorage.clear());

describe("form submission queue", () => {
  test("preserves a caller-supplied offlineId as the server key", () => {
    // The UUID an online submit already sent before it failed mid-flight.
    const sent = "11111111-2222-3333-4444-555555555555";
    enqueueOfflineSubmission({
      templateId: "t", eventKey: "e", matchNumber: 1, teamNumber: 4099,
      data: "{}", offlineId: sent,
    });

    const [entry] = getOfflineQueue();
    // This is the field the sync loop must send.
    expect(entry.offlineId).toBe(sent);
    // The internal id is deliberately different — sending it was the bug.
    expect(entry.id).not.toBe(sent);
  });

  test("generates its own key when the caller has none", () => {
    enqueueOfflineSubmission({
      templateId: "t", eventKey: "e", matchNumber: 1, teamNumber: 4099, data: "{}",
    });
    const [entry] = getOfflineQueue();
    expect(entry.offlineId).toBe(entry.id);
  });
});

const CHECKLIST_QUEUE_KEY = "falconscout_checklist_queue";

/** Write a queue entry the way the pre-merge build did. */
function seedLegacyChecklist(entry: Partial<OfflineChecklist> = {}): OfflineChecklist {
  const full: OfflineChecklist = {
    id: "q1",
    offlineId: "off-1",
    timestamp: 1_700_000_000_000,
    templateId: "tpl_checklist",
    eventKey: "2025chcmp",
    matchNumber: 3,
    assignedScoutId: "u1",
    data: '{"batteryOk":true}',
    ...entry,
  };
  localStorage.setItem(CHECKLIST_QUEUE_KEY, JSON.stringify([full]));
  return full;
}

describe("legacy checklist queue", () => {
  test("a pre-merge entry still survives a reload", () => {
    seedLegacyChecklist();
    // The scout's work must never be dropped just because the app changed
    // shape under it — this is the queue Settings → Clear Cache must not touch.
    expect(getChecklistQueue()).toHaveLength(1);
    expect(getTotalPendingOps()).toBe(1);
  });

  test("it converts to a form submission that keeps the idempotency key", () => {
    const legacy = seedLegacyChecklist();
    const sub = legacyChecklistToForm(legacy);

    // Same server key, so re-filing it can never double-submit or double-pay.
    expect(sub.offlineId).toBe(legacy.offlineId);
    expect(sub.templateId).toBe(legacy.templateId);
    expect(sub.matchNumber).toBe(3);
    expect(sub.data).toBe(legacy.data);
    // teamNumber 0 is what keeps checklists out of the team rollups, and
    // checklists only ever come from the quals-only pit rotation.
    expect(sub.teamNumber).toBe(0);
    expect(sub.compLevel).toBe("qm");
  });

  test("draining the last entry clears the queue key entirely", () => {
    const legacy = seedLegacyChecklist();
    dequeueOfflineChecklist(legacy.id);
    expect(getChecklistQueue()).toHaveLength(0);
    expect(localStorage.getItem(CHECKLIST_QUEUE_KEY)).toBeNull();
    expect(getTotalPendingOps()).toBe(0);
  });

  test("pending count covers the form queue and the legacy queue", () => {
    enqueueOfflineSubmission({
      templateId: "t", eventKey: "e", matchNumber: 1, teamNumber: 4099, data: "{}",
    });
    const legacy = seedLegacyChecklist();
    // seedLegacyChecklist overwrites the checklist key only, so both are live.
    expect(getTotalPendingOps()).toBe(2);
    dequeueOfflineChecklist(legacy.id);
    expect(getTotalPendingOps()).toBe(1);
  });
});
