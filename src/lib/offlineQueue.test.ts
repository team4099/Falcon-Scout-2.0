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
 *    reached checklistSubmissions at all.
 */
import { describe, expect, test, beforeEach } from "vitest";
import {
  enqueueOfflineSubmission,
  getOfflineQueue,
  enqueueOfflineChecklist,
  getChecklistQueue,
  getTotalPendingOps,
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

describe("checklist queue", () => {
  test("checklists go to their own queue, not the scouting queue", () => {
    enqueueOfflineChecklist({
      templateId: "t", eventKey: "e", matchNumber: 3,
      assignedScoutId: "u1", data: "{}",
    });

    expect(getOfflineQueue()).toHaveLength(0);   // never filed as scouting data
    const [entry] = getChecklistQueue();
    expect(entry.assignedScoutId).toBe("u1");    // the form queue had no such field
    expect(entry.matchNumber).toBe(3);
  });

  test("pending count covers all three queues", () => {
    enqueueOfflineSubmission({
      templateId: "t", eventKey: "e", matchNumber: 1, teamNumber: 4099, data: "{}",
    });
    enqueueOfflineChecklist({
      templateId: "t", eventKey: "e", matchNumber: 1,
      assignedScoutId: "u1", data: "{}",
    });
    expect(getTotalPendingOps()).toBe(2);
  });
});
