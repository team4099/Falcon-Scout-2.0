// useCached — wraps a Convex query result with localStorage fallback.
//
// Usage:
//   const liveCards = useQuery(api.kanban.getBoardCards, { boardId });
//   const cards = useCached(liveCards, `kanban_cards_${boardId}`);
//
// When liveCards is defined (online + data loaded) it is returned as-is
// and saved to cache. When liveCards is undefined (offline or still loading)
// the last cached value is returned instead so the UI never goes blank.

import { useEffect, useMemo } from "react";
import { convexCacheGet, convexCacheSet } from "@/lib/convexCache";

export function useCached<T>(live: T | undefined, cacheKey: string): T | undefined {
  // The fallback is re-read whenever the key changes, not captured once.
  //
  // This used to be a ref seeded on the first render only. Most call sites key
  // on something that moves — `submissions_${eventKey}`, `betting_pool_${id}` —
  // so the ref kept the PREVIOUS key's value and handed it back while `live`
  // was undefined: a flash of the old event's data online, and permanently
  // offline, where the query never resolves at all.
  const fallback = useMemo(() => convexCacheGet<T>(cacheKey) ?? undefined, [cacheKey]);

  // Persist to cache whenever fresh data arrives
  useEffect(() => {
    if (live !== undefined) convexCacheSet(cacheKey, live);
  }, [live, cacheKey]);

  return live !== undefined ? live : fallback;
}
