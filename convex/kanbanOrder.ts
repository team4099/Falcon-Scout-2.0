// Pure picklist-ordering helpers shared by convex/kanban.ts and KanbanPage, so
// the optimistic order a scout sees and the order the server stores agree.

export type Orderable = { _id: string; columnId: string; position: number; _creationTime?: number };

/** Sort by position; creation time breaks ties left over from older data. */
export function byPosition(a: Orderable, b: Orderable) {
  return a.position - b.position || (a._creationTime ?? 0) - (b._creationTime ?? 0);
}

/**
 * Put `cardId` at index `position` of `columnId`, renumbering the destination
 * (and, on a cross-column move, the source) column to 0..n-1. Patching only the
 * moved card used to leave duplicate positions, so a reorder could "not stick".
 * Returns just the cards whose column or position actually changes.
 */
export function planMove<T extends Orderable>(
  cards: T[],
  cardId: string,
  columnId: string,
  position: number
): Array<{ card: T; columnId: string; position: number }> {
  const moving = cards.find((c) => c._id === cardId);
  if (!moving) return [];
  const changes: Array<{ card: T; columnId: string; position: number }> = [];
  const renumber = (list: T[], col: string) =>
    list.forEach((card, i) => {
      if (card.columnId !== col || card.position !== i) changes.push({ card, columnId: col, position: i });
    });
  const others = (col: string) => cards.filter((c) => c.columnId === col && c._id !== cardId).sort(byPosition);

  const dest = others(columnId);
  dest.splice(Math.max(0, Math.min(Math.floor(position), dest.length)), 0, moving);
  renumber(dest, columnId);
  if (moving.columnId !== columnId) renumber(others(moving.columnId), moving.columnId);
  return changes;
}
