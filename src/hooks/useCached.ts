// useCached — wraps a Convex useQuery result with localStorage fallback.
//
// Usage:
//   const liveCards = useQuery(api.kanban.getBoardCards, { boardId });
//   const cards = useCached(liveCards, `kanban_cards_${boardId}`);
//
// When liveCards is defined (online + data loaded) it is returned as-is
// and saved to cache. When liveCards is undefined (offline or still loading)
// the last cached value is returned instead so the UI never goes blank.

import { useEffect, useRef } from "react";
import { convexCacheGet, convexCacheSet } from "@/lib/convexCache";

export function useCached<T>(live: T | undefined, cacheKey: string): T | undefined {
  const savedRef = useRef<T | undefined>(undefined);

  // Restore from cache on first render
  if (savedRef.current === undefined) {
    const cached = convexCacheGet<T>(cacheKey);
    if (cached !== null) savedRef.current = cached;
  }

  // Persist to cache whenever fresh data arrives
  useEffect(() => {
    if (live !== undefined) {
      convexCacheSet(cacheKey, live);
      savedRef.current = live;
    }
  }, [live, cacheKey]);

  return live !== undefined ? live : savedRef.current;
}
