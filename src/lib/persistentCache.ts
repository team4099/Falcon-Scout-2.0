/**
 * persistentCache.ts
 *
 * A two-tier cache for FalconScout:
 *   1. IndexedDB  — for large/binary data like base64 team avatars. No quota limit.
 *   2. localStorage — fast synchronous access for small JSON payloads.
 *
 * TTL tiers:
 *   - SHORT  (30 min)  — live event data: matches, rankings, EPA
 *   - MEDIUM (7 days)  — event-level data: team lists, event teams
 *   - LONG   (90 days) — stable per-team data: team info, avatars, season EPA
 */

export const TTL = {
  SHORT:  1000 * 60 * 30,          // 30 min
  MEDIUM: 1000 * 60 * 60 * 24 * 7, // 7 days
  LONG:   1000 * 60 * 60 * 24 * 90,// 90 days
} as const;

// ─────────────────────────────── IndexedDB tier ───────────────────────────────

const IDB_NAME    = "falconscout_cache";
const IDB_STORE   = "kv";
const IDB_VERSION = 1;

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => { _db = req.result; resolve(req.result); };
    req.onerror   = () => reject(req.error);
  });
}

interface CacheEntry<T> { data: T; ts: number; ttl: number; }

export async function idbSet<T>(key: string, data: T, ttl: number): Promise<void> {
  try {
    const db   = await openDb();
    const tx   = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const entry: CacheEntry<T> = { data, ts: Date.now(), ttl };
    store.put(entry, key);
  } catch { /* ignore */ }
}

export async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db    = await openDb();
    const tx    = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    return new Promise((resolve) => {
      const req = store.get(key);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry<T> | undefined;
        if (!entry) { resolve(null); return; }
        if (Date.now() - entry.ts > entry.ttl) { resolve(null); return; }
        resolve(entry.data);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function idbDelete(key: string): Promise<void> {
  try {
    const db    = await openDb();
    const tx    = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
  } catch { /* ignore */ }
}

/** Evict all entries whose TTL has expired. Call once on app start. */
export async function idbEvictExpired(): Promise<void> {
  try {
    const db    = await openDb();
    const tx    = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const req   = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const entry = cursor.value as CacheEntry<unknown>;
      if (Date.now() - entry.ts > entry.ttl) cursor.delete();
      cursor.continue();
    };
  } catch { /* ignore */ }
}

// ─────────────────────────────── localStorage tier ────────────────────────────

const LS_PREFIX = "falconscout_cache_";

export function lsSet<T>(key: string, data: T, ttl: number): void {
  try {
    localStorage.setItem(
      `${LS_PREFIX}${key}`,
      JSON.stringify({ data, ts: Date.now(), ttl })
    );
    localStorage.setItem("falconscout_last_api_sync", String(Date.now()));
  } catch {
    // Quota exceeded — silently ignore
  }
}

export function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${key}`);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (Date.now() - entry.ts > entry.ttl) return null;
    return entry.data;
  } catch { return null; }
}

export function lsGetStale<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${key}`);
    if (!raw) return null;
    return (JSON.parse(raw) as CacheEntry<T>).data;
  } catch { return null; }
}

/** Remove all expired localStorage cache entries. */
export function lsEvictExpired(): void {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith(LS_PREFIX)) continue;
    try {
      const entry = JSON.parse(localStorage.getItem(k)!) as CacheEntry<unknown>;
      if (Date.now() - entry.ts > entry.ttl) localStorage.removeItem(k);
    } catch {
      localStorage.removeItem(k);
    }
  }
}

export function clearAllCache(): void {
  // Clear localStorage
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(LS_PREFIX) || k.startsWith("falconscout_")) {
      localStorage.removeItem(k);
    }
  }
  // Clear IDB
  openDb().then((db) => {
    db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).clear();
  }).catch(() => {});
}
