// Caches Convex query results in localStorage for offline access.
// No TTL — we always prefer stale data over a blank screen when offline.

const PREFIX = "falconscout_convex_";
const LAST_SYNC_KEY = "falconscout_last_convex_sync";

export function convexCacheSet<T>(key: string, data: T): void {
  try {
    localStorage.setItem(
      `${PREFIX}${key}`,
      JSON.stringify({ data, ts: Date.now() })
    );
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } catch {
    // Ignore storage quota errors
  }
}

export function convexCacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}`);
    if (!raw) return null;
    const { data } = JSON.parse(raw) as { data: T; ts: number };
    return data;
  } catch {
    return null;
  }
}

export function convexCacheGetTs(key: string): number | null {
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}`);
    if (!raw) return null;
    const { ts } = JSON.parse(raw) as { data: unknown; ts: number };
    return ts;
  } catch {
    return null;
  }
}

/** Timestamp of the most recent successful Convex data write */
export function getLastConvexSync(): number | null {
  const raw = localStorage.getItem(LAST_SYNC_KEY);
  return raw ? Number(raw) : null;
}

/** Combined last-sync across Convex + external APIs */
export function getLastSync(): number | null {
  const convex = getLastConvexSync();
  const apiRaw = localStorage.getItem("falconscout_last_api_sync");
  const api = apiRaw ? Number(apiRaw) : null;
  if (convex === null && api === null) return null;
  if (convex === null) return api;
  if (api === null) return convex;
  return Math.max(convex, api);
}
