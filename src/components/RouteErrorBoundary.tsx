import { useEffect, useState } from "react";
import { useRouteError } from "react-router";
import { isStaleClientError } from "@/lib/staleClient";

/**
 * Catches route-level crashes so the app degrades to something a scout can act
 * on instead of react-router's raw stack trace.
 *
 * The case this exists for: a device running a cached build that is older than
 * the deployed backend. Convex deploys before Vercel does, and a PWA keeps
 * serving its precached bundle until a new service worker installs — so there
 * is always a window where the client calls a function the server no longer
 * has. Convex answers "Could not find public function", the query throws during
 * render, and the entire route white-screens. Mid-competition on a scout's
 * phone that is the whole app gone, over a stale cache.
 *
 * That case is recoverable and unambiguous, so it self-heals: drop the service
 * worker and its caches, then reload onto the current build.
 */

/**
 * Drop every cached asset and service worker, then reload.
 *
 * Deliberately does NOT touch localStorage or IndexedDB: the offline submission
 * queue, QR backups, scanned data and the cached session live there, and this
 * runs at exactly the moment a scout is most likely to be holding unsynced
 * work. Only the code cache is discarded. See NEVER_CLEAR in persistentCache.
 */
async function reloadOntoLatestBuild(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    // Unregistering is best-effort — a failure here must not block the reload.
  }
  try {
    if ("caches" in globalThis) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Same — fall through to the reload regardless.
  }
  // `location.reload()` can still be answered by the (now-unregistered) worker
  // in some browsers. A cache-busting query guarantees a trip to the network.
  const url = new URL(window.location.href);
  url.searchParams.set("_v", String(Date.now()));
  window.location.replace(url.toString());
}

// One automatic recovery per tab. Without this, a crash that survives the
// reload (a genuine bug that merely resembles a stale client) would reload
// forever. The second time through, the scout gets the button instead.
const AUTO_RECOVER_KEY = "falconscout_auto_recovered";

export default function RouteErrorBoundary() {
  const error = useRouteError();
  const stale = isStaleClientError(error);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    if (!stale) return;
    // Read-then-claim, so a second crash in this tab falls through to the
    // button instead of reloading forever. Declared without an initialiser:
    // every path below either assigns it or returns first.
    let alreadyTried: boolean;
    try {
      alreadyTried = sessionStorage.getItem(AUTO_RECOVER_KEY) === "1";
      sessionStorage.setItem(AUTO_RECOVER_KEY, "1");
    } catch {
      // Private mode / storage disabled — fall back to the manual button.
      return;
    }
    if (alreadyTried) return;
    // No setState here on purpose: this navigates away, so flipping `recovering`
    // would only queue a cascading render the reload discards. `recovering`
    // exists for the manual button, which does have to reflect its own click.
    void reloadOntoLatestBuild();
  }, [stale]);

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#0f0a1a",
        color: "#e8e4f0",
        fontFamily: "system-ui, -apple-system, sans-serif",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: "30rem" }}>
        <div style={{ fontSize: "2rem", marginBottom: 12 }}>{stale ? "🔄" : "⚠️"}</div>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 700, margin: "0 0 10px" }}>
          {stale ? "FalconScout needs to update" : "Something went wrong"}
        </h1>
        <p style={{ fontSize: "0.9rem", lineHeight: 1.5, opacity: 0.8, margin: "0 0 18px" }}>
          {stale
            ? recovering
              ? "Getting the latest version…"
              : "This device is running an older copy of the app than the server. Updating will fix it."
            : "This screen hit an error it couldn't recover from."}
        </p>

        <p style={{ fontSize: "0.8rem", lineHeight: 1.5, opacity: 0.55, margin: "0 0 18px" }}>
          Your unsynced scouting data is safe — updating only clears cached app
          code, never your submissions.
        </p>

        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => {
              setRecovering(true);
              void reloadOntoLatestBuild();
            }}
            disabled={recovering}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              border: "none",
              cursor: recovering ? "default" : "pointer",
              fontWeight: 700,
              fontSize: "0.9rem",
              background: "oklch(0.85 0.18 95)",
              color: "oklch(0.1 0 0)",
              opacity: recovering ? 0.6 : 1,
            }}
          >
            {recovering ? "Updating…" : "Update now"}
          </button>
          <button
            onClick={() => window.location.assign("/")}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.9rem",
              background: "transparent",
              color: "#e8e4f0",
              border: "1px solid rgba(255,255,255,0.18)",
            }}
          >
            Back to dashboard
          </button>
        </div>

        {message && (
          <pre
            style={{
              marginTop: 22,
              padding: 12,
              borderRadius: 8,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              fontSize: "0.7rem",
              lineHeight: 1.4,
              textAlign: "left",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              opacity: 0.6,
              maxHeight: "8rem",
              overflow: "auto",
            }}
          >
            {message}
          </pre>
        )}
      </div>
    </div>
  );
}
