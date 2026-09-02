/**
 * Cache scoping — the critical audit finding.
 *
 * clearAllCache() removed every falconscout_* key, which took the offline
 * submission queue, the scout's QR backups, scanned-but-unuploaded data and the
 * viewer cache (breaking offline sign-in) along with the API cache.
 */
import { beforeEach, describe, expect, test } from "vitest";

// jsdom supplies a real localStorage. clearAllCache also clears IndexedDB, so
// stub just enough of that for the module to load.
(globalThis as unknown as { indexedDB: unknown }).indexedDB = {
  open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }),
};

const { clearAllCache, lsSet, lsGet, lsGetStale, TTL } = await import("./persistentCache");

// Everything a scout has produced but not yet synced.
const USER_DATA = {
  falconscout_offline_queue:       '[{"id":"a1"},{"id":"a2"}]',
  falconscout_kanban_queue:        '[{"id":"k1"}]',
  falconscout_my_submissions:      '[{"id":"a1"}]',
  falconscout_scanned_submissions: '[{"id":"z9"}]',
  falconscout_chunk_buffers:       '{"partial":{}}',
  falconscout_viewer_cache:        '{"_id":"u1"}',
  falconscout_ui:                  '{"state":{"isAdminMode":true}}',
};

beforeEach(() => {
  localStorage.clear();
  for (const [k, v] of Object.entries(USER_DATA)) localStorage.setItem(k, v);
  localStorage.setItem("falconscout_cache_tba_teams_2025chcmp", '{"data":[1],"ts":0,"ttl":9e9}');
  localStorage.setItem("falconscout_convex_current_event", '{"data":{},"ts":0}');
});

describe("clearAllCache", () => {
  test("keeps every piece of unsynced user data", () => {
    clearAllCache();
    for (const [key, value] of Object.entries(USER_DATA)) {
      expect(localStorage.getItem(key), `${key} must survive`).toBe(value);
    }
  });

  test("clears the API and Convex response caches", () => {
    clearAllCache();
    expect(localStorage.getItem("falconscout_cache_tba_teams_2025chcmp")).toBeNull();
    expect(localStorage.getItem("falconscout_convex_current_event")).toBeNull();
  });

  test("leaves the auth token alone, so clearing does not sign you out", () => {
    localStorage.setItem("__convexAuthJWT_abc", "jwt");
    clearAllCache();
    expect(localStorage.getItem("__convexAuthJWT_abc")).toBe("jwt");
  });

  test("a future falconscout_cache_ key is still cleared", () => {
    localStorage.setItem("falconscout_cache_something_new", "x");
    clearAllCache();
    expect(localStorage.getItem("falconscout_cache_something_new")).toBeNull();
  });
});

describe("localStorage TTL tier", () => {
  test("expired entries read as null but are still available as stale", () => {
    lsSet("k", { v: 1 }, TTL.SHORT);
    expect(lsGet("k")).toEqual({ v: 1 });

    // age it past its TTL
    const raw = JSON.parse(localStorage.getItem("falconscout_cache_k")!);
    raw.ts = Date.now() - TTL.SHORT - 1000;
    localStorage.setItem("falconscout_cache_k", JSON.stringify(raw));

    expect(lsGet("k")).toBeNull();
    // offline reads fall back to stale rather than showing a blank screen
    expect(lsGetStale("k")).toEqual({ v: 1 });
  });
});
