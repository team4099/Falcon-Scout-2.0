/**
 * Offline queue routing and idempotency.
 *
 * Two audit findings live here:
 *  - useOfflineSync sent the queue's internal `id` as the server's idempotency
 *    key instead of `offlineId`. They diverge exactly when it matters — an
 *    online submit that failed mid-flight is re-queued under the offlineId the
 *    server may already hold — so the server saw a fresh key, inserted a
 *    duplicate row, and paid the scout twice.
 */
import { describe, expect, test, beforeEach } from "vitest";
import {
  enqueueOfflineSubmission,
  getOfflineQueue,
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

describe("pending count", () => {
  test("counts queued form submissions", () => {
    enqueueOfflineSubmission({
      templateId: "t", eventKey: "e", matchNumber: 1, teamNumber: 4099, data: "{}",
    });
    expect(getTotalPendingOps()).toBe(1);
  });
});
