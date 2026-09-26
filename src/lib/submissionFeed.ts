/** Minimal shape filterFeed needs — a subset of a formSubmissions row. */
export interface FeedItem {
  templateId: string;
  matchNumber?: number;
  teamNumber?: number;
  scoutId?: string;
  syncedAt: number;
}

/**
 * Submissions feed filter: optional form, then a free-text query matching an
 * exact team/match number or a substring of scout/form name. Newest first.
 */
export function filterFeed<T extends FeedItem>(
  subs: T[],
  opts: {
    templateId: string | null;
    query: string;
    scoutName: (id?: string) => string;
    formName: (id: string) => string;
  },
): T[] {
  const q = opts.query.trim().toLowerCase();
  return subs
    .filter((s) => !opts.templateId || s.templateId === opts.templateId)
    .filter(
      (s) =>
        !q ||
        String(s.teamNumber ?? "") === q ||
        String(s.matchNumber ?? "") === q ||
        opts.scoutName(s.scoutId).toLowerCase().includes(q) ||
        opts.formName(s.templateId).toLowerCase().includes(q),
    )
    .sort((a, b) => b.syncedAt - a.syncedAt);
}
