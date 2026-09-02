// useBackendReachable — is the Convex backend actually reachable right now?
//
// navigator.onLine only reports whether the device has *a* network. At a
// competition that is routinely true while nothing works: venue wifi with no
// uplink, a captive portal, saturated LTE. Driving the sync indicator from it
// meant the sidebar cheerfully read "Online · Synced now" for an entire session
// in which not one query ever resolved.
//
// Convex's client knows the truth, so ask it. `isWebSocketConnected` flips as
// the socket opens and drops; combining it with navigator.onLine gives a
// three-state answer the UI can be honest about.

import { useEffect, useState } from "react";
import { useConvex } from "convex/react";

export type BackendStatus = "online" | "connecting" | "offline";

export function useBackendReachable(): {
  status: BackendStatus;
  /** Device reports a network connection (navigator.onLine). */
  deviceOnline: boolean;
  /** Convex's WebSocket is open — queries and mutations will actually work. */
  backendConnected: boolean;
} {
  const convex = useConvex();

  const [deviceOnline, setDeviceOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [backendConnected, setBackendConnected] = useState(false);

  useEffect(() => {
    const goOnline = () => setDeviceOnline(true);
    const goOffline = () => setDeviceOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => {
    // subscribeToConnectionState is marked unstable upstream, so tolerate it
    // being absent rather than crashing the whole shell on a version bump.
    const client = convex as unknown as {
      connectionState?: () => { isWebSocketConnected: boolean };
      subscribeToConnectionState?: (
        cb: (s: { isWebSocketConnected: boolean }) => void,
      ) => () => void;
    };

    try {
      const initial = client.connectionState?.();
      if (initial) setBackendConnected(initial.isWebSocketConnected);
      const unsub = client.subscribeToConnectionState?.((s) =>
        setBackendConnected(s.isWebSocketConnected),
      );
      return unsub;
    } catch {
      // Leave backendConnected false; the UI degrades to "connecting".
    }
  }, [convex]);

  const status: BackendStatus = !deviceOnline
    ? "offline"
    : backendConnected
      ? "online"
      : "connecting";

  return { status, deviceOnline, backendConnected };
}
