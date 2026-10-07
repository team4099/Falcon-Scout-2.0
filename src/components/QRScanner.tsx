import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { BrowserQRCodeReader } from "@zxing/browser";
import {
  ingestQRPayload,
  getScannedSubmissions,
  updateScannedStatus,
  deleteScannedSubmission,
  clearScannedSubmissions,
  evictStaleChunkBuffers,
  type ScannedSubmission,
} from "@/lib/scannedDataStore";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Clock,
  XCircle,
  Trash2,
  CameraOff,
  Upload,
  Layers,
  Aperture,
  X,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

// ── Scanned-data state + Convex upload ────────────────────────────────────────

/** Local list of scanned teammate submissions, with upload + auto-retry on reconnect. */
export function useScannedSubmissions() {
  const submitForm = useMutation(api.forms.submitForm);
  const [scanned, setScanned] = useState<ScannedSubmission[]>([]);
  const reload = useCallback(() => setScanned(getScannedSubmissions()), []);

  useEffect(() => {
    evictStaleChunkBuffers();
    reload();
  }, [reload]);

  const attemptUpload = useCallback(
    async (sub: ScannedSubmission) => {
      if (!navigator.onLine) return;

      // The QR envelope carries the template the submission was actually filled
      // out against. Guessing here (previously: whichever active template came
      // first) silently filed scanned data under the wrong form, so its field
      // ids never matched and the Data Viewer showed blank columns.
      if (!sub.templateId) {
        updateScannedStatus(sub.id, "failed");
        toast.error(
          `Match ${sub.matchNumber} has no form attached — rescan a freshly generated code.`
        );
        reload();
        return;
      }

      try {
        await submitForm({
          templateId: sub.templateId as Id<"formTemplates">,
          eventKey: sub.eventKey,
          matchNumber: sub.matchNumber,
          compLevel: sub.compLevel,
          teamNumber: sub.teamNumber,
          data: JSON.stringify(sub.data),
          offlineId: sub.id, // idempotency key — server deduplicates by this
        });
        updateScannedStatus(sub.id, "uploaded");
        toast.success(`Uploaded: Match ${sub.matchNumber} · Team ${sub.teamNumber} ✅`);
      } catch (err: unknown) {
        updateScannedStatus(sub.id, "failed");
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("not registered at this event")) {
          toast.error(`Team ${sub.teamNumber} is not at this event — submission rejected.`);
        } else {
          toast.error(`Upload failed for Match ${sub.matchNumber} — will retry when online.`);
        }
        console.error("[Scanner] upload failed:", err);
      }
      reload();
    },
    [submitForm, reload]
  );

  const retryPending = useCallback(() => {
    getScannedSubmissions()
      .filter((s) => s.uploadStatus !== "uploaded")
      .forEach((s) => attemptUpload(s));
  }, [attemptUpload]);

  // Retry pending/failed scans when we come online
  useEffect(() => {
    window.addEventListener("online", retryPending);
    return () => window.removeEventListener("online", retryPending);
  }, [retryPending]);

  const remove = useCallback((id: string) => {
    deleteScannedSubmission(id);
    reload();
  }, [reload]);

  const clearAll = useCallback((eventKey?: string) => {
    clearScannedSubmissions(eventKey);
    reload();
  }, [reload]);

  return { scanned, reload, attemptUpload, retryPending, remove, clearAll };
}

// ── Scanned record card ───────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ScannedSubmission["uploadStatus"] }) {
  if (status === "uploaded")
    return (
      <span className="flex items-center gap-1 text-[10px] font-semibold text-green-400">
        <CheckCircle2 className="h-3 w-3" /> Uploaded
      </span>
    );
  if (status === "failed")
    return (
      <span className="flex items-center gap-1 text-[10px] font-semibold text-destructive">
        <XCircle className="h-3 w-3" /> Failed
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-[10px] font-semibold text-yellow-400">
      <Clock className="h-3 w-3" /> Pending
    </span>
  );
}

export function ScannedCard({
  sub,
  onRetry,
  onDelete,
}: {
  sub: ScannedSubmission;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const time = new Date(sub.scannedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="bg-card border border-border rounded-xl p-3 flex items-center gap-3">
      <div
        className={`h-2.5 w-2.5 rounded-full shrink-0 ${
          sub.uploadStatus === "uploaded"
            ? "bg-green-400"
            : sub.uploadStatus === "failed"
            ? "bg-destructive"
            : "bg-yellow-400 animate-pulse"
        }`}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-bold text-sm">
            {sub.teamNumber ? `Team ${sub.teamNumber}` : "No team #"}
          </span>
          <span className="text-xs text-muted-foreground">
            Match {sub.matchNumber} · {sub.eventKey}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <StatusBadge status={sub.uploadStatus} />
          <span className="text-[10px] text-muted-foreground">{time}</span>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {sub.uploadStatus !== "uploaded" && (
          <button
            onClick={onRetry}
            className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Retry upload"
          >
            <Upload className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={onDelete}
          className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          title="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ── Full-screen camera overlay ────────────────────────────────────────────────

/**
 * Full-screen camera that fills the device. Starts the camera on mount and
 * stops it on unmount. Complete submissions are handed to `onComplete`
 * (already persisted locally by `ingestQRPayload`).
 */
export function QRScannerOverlay({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: (sub: ScannedSubmission) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readerRef = useRef<BrowserQRCodeReader | null>(null);
  const lastScannedRef = useRef<string>(""); // debounce duplicate rapid scans
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const [ready, setReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0); // bump to restart the camera
  const [chunksProgress, setChunksProgress] = useState<{
    received: number; needed: number;
  } | null>(null);

  // ── Handle a decoded QR string ────────────────────────────────────────────

  const handleScan = useCallback((raw: string) => {
    // Debounce: ignore if same payload scanned within 1.5s
    if (raw === lastScannedRef.current) return;
    lastScannedRef.current = raw;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      lastScannedRef.current = "";
    }, 1500);

    const result = ingestQRPayload(raw);

    if (result.status === "duplicate") {
      toast.info("Already scanned — skipped.", { duration: 1500 });
      return;
    }
    if (result.status === "ignored") return; // not a scouting code — stay quiet
    if (result.status === "outdated") {
      toast.error("This QR code is from an older app version.", {
        description:
          "Ask the scout to reopen My QR Codes and show the code again to regenerate it.",
        duration: 5000,
      });
      return;
    }
    if (result.status === "corrupt") {
      toast.error("That code didn't read cleanly — scan it again.", {
        description: "Nothing was saved, so no data was lost.",
        duration: 4000,
      });
      return;
    }
    if (result.status === "buffering") {
      setChunksProgress({ received: result.chunksReceived, needed: result.chunksNeeded });
      toast.info(
        `Code ${result.chunksReceived}/${result.chunksNeeded} scanned — keep going!`,
        { duration: 2000 }
      );
      return;
    }

    setChunksProgress(null);
    toast.success(
      `Scanned: Match ${result.submission.matchNumber} · Team ${result.submission.teamNumber}`,
      { duration: 2500 }
    );
    onCompleteRef.current(result.submission);
  }, []);

  // ── Camera lifecycle ──────────────────────────────────────────────────────

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let controls: { stop: () => void } | null = null;
    setCameraError(null);
    setReady(false);

    const reader = new BrowserQRCodeReader();
    readerRef.current = reader;
    reader
      .decodeFromConstraints(
        // Rear camera at a resolution high enough to read dense multi-chunk codes
        { video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } },
        video,
        (result) => {
          // A missing result is just "no QR found in this frame"
          if (result) handleScan(result.getText());
        }
      )
      .then((c) => {
        // StrictMode / fast close: the effect was torn down before the camera opened
        if (cancelled) c.stop();
        else { controls = c; setReady(true); }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCameraError(
          err instanceof Error ? err.message : "Camera access denied or unavailable."
        );
      });

    return () => {
      cancelled = true;
      controls?.stop();
      readerRef.current = null;
    };
  }, [attempt, handleScan]);

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
  }, []);

  // Escape closes; lock page scroll behind the overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // ── Manual capture: grab the current frame and decode it once ────────────

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const reader = readerRef.current;
    if (!video || !canvas || !reader || video.readyState < 2) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    try {
      handleScan(reader.decodeFromCanvas(canvas).getText());
    } catch {
      toast.error("No QR code found in that frame — line it up and try again.", {
        duration: 2000,
      });
    }
  }, [handleScan]);

  // Portal to <body> so the overlay covers the whole device regardless of the
  // app shell's layout/transform context.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan QR code"
      className="fixed inset-0 z-50 bg-black text-white overflow-hidden"
    >
      <video
        ref={videoRef}
        className={`absolute inset-0 w-full h-full object-cover transition-opacity ${ready ? "opacity-100" : "opacity-0"}`}
        autoPlay
        muted
        playsInline
      />
      <canvas ref={canvasRef} className="hidden" />

      {/* Aim box — as large as the screen allows while staying square */}
      {ready && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className="relative aspect-square rounded-3xl"
            style={{
              width: "min(85vw, 65dvh)",
              boxShadow: "0 0 0 100vmax rgba(0,0,0,0.45)",
            }}
          >
            <div className="absolute top-0 left-0 w-10 h-10" style={{ borderTop: "4px solid white", borderLeft: "4px solid white", borderRadius: "24px 0 0 0" }} />
            <div className="absolute top-0 right-0 w-10 h-10" style={{ borderTop: "4px solid white", borderRight: "4px solid white", borderRadius: "0 24px 0 0" }} />
            <div className="absolute bottom-0 left-0 w-10 h-10" style={{ borderBottom: "4px solid white", borderLeft: "4px solid white", borderRadius: "0 0 0 24px" }} />
            <div className="absolute bottom-0 right-0 w-10 h-10" style={{ borderBottom: "4px solid white", borderRight: "4px solid white", borderRadius: "0 0 24px 0" }} />
            <div className="absolute inset-4 overflow-hidden">
              <div className="h-0.5 bg-white/80 shadow-[0_0_6px_2px_rgba(255,255,255,0.5)] animate-[scan_2s_ease-in-out_infinite]" />
            </div>
          </div>
        </div>
      )}

      {/* Starting / error state */}
      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          {cameraError ? (
            <>
              <CameraOff className="h-12 w-12 text-destructive" />
              <p className="text-sm text-white/80 max-w-xs">{cameraError}</p>
              <Button onClick={() => setAttempt((n) => n + 1)} className="gap-2">
                <RefreshCw className="h-4 w-4" /> Try again
              </Button>
            </>
          ) : (
            <p className="text-sm text-white/70">Starting camera…</p>
          )}
        </div>
      )}

      {/* Top bar */}
      <div
        className="absolute top-0 inset-x-0 flex items-center justify-between gap-3 px-4 pb-3 bg-gradient-to-b from-black/70 to-transparent"
        style={{ paddingTop: "max(env(safe-area-inset-top), 12px)" }}
      >
        <div className="min-w-0">
          <p className="font-bold text-lg leading-tight">Scan QR Code</p>
          <p className="text-xs text-white/70 truncate">
            Point at a teammate's code from their My QR Codes tab
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close scanner"
          className="h-11 w-11 shrink-0 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
        >
          <X className="h-6 w-6" />
        </button>
      </div>

      {/* Bottom bar */}
      <div
        className="absolute bottom-0 inset-x-0 flex flex-col items-center gap-3 px-4 pt-6 bg-gradient-to-t from-black/70 to-transparent"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 20px)" }}
      >
        {chunksProgress && (
          <div className="w-full max-w-sm bg-black/70 backdrop-blur rounded-xl px-3 py-2 flex items-center gap-2">
            <Layers className="h-4 w-4 shrink-0" />
            <div className="flex-1">
              <div className="text-xs font-semibold">
                Multi-code: {chunksProgress.received}/{chunksProgress.needed} scanned
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-white/20 overflow-hidden">
                <div
                  className="h-full bg-white rounded-full transition-all"
                  style={{ width: `${(chunksProgress.received / chunksProgress.needed) * 100}%` }}
                />
              </div>
            </div>
          </div>
        )}
        <div className="flex gap-3">
          <Button
            onClick={captureFrame}
            disabled={!ready}
            size="lg"
            className="px-8 gap-2 h-12"
          >
            <Aperture className="h-5 w-5" /> Capture
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={onClose}
            className="h-12 gap-2 bg-black/40 border-white/30 text-white hover:bg-white/15 hover:text-white"
          >
            Done
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
