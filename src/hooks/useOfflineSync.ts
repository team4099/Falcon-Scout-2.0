// Hook that watches both offline queues and syncs to Convex when online.
// Also tracks lastSyncedAt so the UI can show how fresh the data is.

import { useEffect, useState, useCallback, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  getOfflineQueue,
  dequeueOfflineSubmission,
  getKanbanQueue,
  dequeueKanbanOp,
  getTotalPendingOps,
} from "@/lib/offlineQueue";
import { getLastSync } from "@/lib/convexCache";

const LAST_SYNCED_LS = "falconscout_last_synced";

function readLastSynced(): number | null {
  const raw = localStorage.getItem(LAST_SYNCED_LS);
  const explicit = raw ? Number(raw) : null;
  // Also consider the last time any external API (TBA/Statbotics) returned fresh data
  const apiRaw = localStorage.getItem("falconscout_last_api_sync");
  const api = apiRaw ? Number(apiRaw) : null;
  const candidates = [explicit, api, getLastSync()].filter((v): v is number => v !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

function writeLastSynced(ts: number): void {
  localStorage.setItem(LAST_SYNCED_LS, String(ts));
}

export function useOfflineSync() {
  const [totalPending, setTotalPending]   = useState<number>(getTotalPendingOps);
  const [lastSyncedAt, setLastSyncedAt]   = useState<number | null>(readLastSynced);
  const [isOnline, setIsOnline]           = useState<boolean>(navigator.onLine);
  const syncingRef = useRef(false);

  const submitForm  = useMutation(api.forms.submitForm);
  const moveCard    = useMutation(api.kanban.moveCard);
  const updateCard  = useMutation(api.kanban.updateCard);
  const removeCard  = useMutation(api.kanban.removeCard);

  const refreshCounts = useCallback(() => {
    setTotalPending(getTotalPendingOps());
  }, []);

  const syncPending = useCallback(async () => {
    if (!navigator.onLine || syncingRef.current) return;
    syncingRef.current = true;
    let anySynced = false;

    // ── Drain form submissions ───────────────────────────────────────────
    for (const sub of getOfflineQueue()) {
      try {
        await submitForm({
          templateId: sub.templateId as Id<"formTemplates">,
          eventKey:    sub.eventKey,
          matchNumber: sub.matchNumber,
          compLevel:   sub.compLevel,
          teamNumber:  sub.teamNumber,
          data:        sub.data,
          offlineId:   sub.id, // idempotency key — server skips insert if already stored
        });
        dequeueOfflineSubmission(sub.id);
        anySynced = true;
      } catch (err: unknown) {
        // Permanent rejection (e.g. team not at event) — dequeue so we don't
        // keep retrying a submission that will never succeed.
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("not registered at this event")) {
          dequeueOfflineSubmission(sub.id);
          anySynced = true;
          continue;
        }
        break; // stop on first transient failure; retry next cycle
      }
    }

    // ── Drain Kanban ops ─────────────────────────────────────────────────
    for (const op of getKanbanQueue()) {
      try {
        if (op.type === "moveCard") {
          await moveCard({
            cardId:   op.cardId as Id<"kanbanCards">,
            columnId: op.columnId,
            position: op.position,
          });
        } else if (op.type === "updateCard") {
          await updateCard({
            cardId: op.cardId as Id<"kanbanCards">,
            notes:  op.notes,
          });
        } else if (op.type === "removeCard") {
          await removeCard({ cardId: op.cardId as Id<"kanbanCards"> });
        }
        dequeueKanbanOp(op.id);
        anySynced = true;
      } catch {
        break;
      }
    }

    if (anySynced) {
      const now = Date.now();
      writeLastSynced(now);
      setLastSyncedAt(now);
    }
    refreshCounts();
    syncingRef.current = false;
  }, [submitForm, moveCard, updateCard, removeCard, refreshCounts]);

  // Called by convexCache when live data arrives
  const markSynced = useCallback(() => {
    const now = Date.now();
    writeLastSynced(now);
    setLastSyncedAt(now);
  }, []);

  useEffect(() => {
    refreshCounts();
    syncPending();

    const handleOnline = () => {
      setIsOnline(true);
      syncPending();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online",  handleOnline);
    window.addEventListener("offline", handleOffline);

    // Refresh display every 5 s so "just now" resolves quickly
    const ticker = setInterval(() => {
      setLastSyncedAt(readLastSynced());
      refreshCounts();
      if (navigator.onLine) syncPending();
    }, 5_000);

    return () => {
      window.removeEventListener("online",  handleOnline);
      window.removeEventListener("offline", handleOffline);
      clearInterval(ticker);
    };
  }, [syncPending, refreshCounts]);

  // Expose queueLength alias for backwards compat with App.tsx
  const queueLength = totalPending;

  return { queueLength, totalPending, lastSyncedAt, isOnline, markSynced, refreshCounts, syncPending };
}
