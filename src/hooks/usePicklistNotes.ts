// Picklist card notes, shared by the Picklist and the Dashboard team panel.
// Who may write is enforced server-side (convex/kanban.ts requireBoardWrite):
// admins on the shared board, the owner on a personal one.

import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useCached } from "@/hooks/useCached";
import { enqueueKanbanOp } from "@/lib/offlineQueue";
import { useUIStore } from "@/store/uiStore";
import type { TeamDetailProps } from "@/pages/TeamDetailPanel";

/** Save a card's notes, queueing them while offline. */
export function useSaveCardNotes() {
  const updateCard = useMutation(api.kanban.updateCard);
  return useCallback(async (cardId: string, notes: string) => {
    if (navigator.onLine) {
      try {
        await updateCard({ cardId: cardId as Id<"kanbanCards">, notes });
        toast.success("Notes saved");
      } catch {
        toast.error("Failed to save notes");
      }
    } else {
      enqueueKanbanOp({ type: "updateCard", cardId, notes });
      toast.success("Notes saved, will sync when online");
    }
  }, [updateCard]);
}

/** The shared picklist's notes for one team (Dashboard team panel's Notes tab).
 *  Uses the Picklist's cache keys, so notes seen there also show offline here. */
export function useSharedPicklistNotes(eventKey: string, teamNumber: number | null): TeamDetailProps["notes"] {
  const boardLive = useQuery(api.kanban.getCentralBoard, eventKey ? { eventKey } : "skip");
  const board = useCached(boardLive, `kanban_board_central_${eventKey}`);
  const cardsLive = useQuery(api.kanban.getBoardCards, board ? { boardId: board._id } : "skip");
  const cards = useCached(cardsLive, `kanban_cards_${board?._id ?? "none"}`);
  const { isAdminMode } = useUIStore();
  const save = useSaveCardNotes();

  if (teamNumber === null) return undefined;
  const card = cards?.find((c) => c.teamNumber === teamNumber);
  if (!card) {
    return {
      value: "",
      canEdit: false,
      readOnlyHint: "This team isn't on the shared picklist yet, so it has no notes.",
      onSave: () => {},
    };
  }
  return {
    value: card.notes ?? "",
    canEdit: isAdminMode,
    readOnlyHint: "Only admins can edit notes on the shared picklist.",
    onSave: (text) => void save(card._id, text),
  };
}
