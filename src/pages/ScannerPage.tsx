import { useState, useEffect, useRef, useCallback } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ScanLine,
  CheckCircle2,
  Clock,
  XCircle,
  Trash2,
  Camera,
  CameraOff,
  RefreshCw,
  AlertTriangle,
  Upload,
  Layers,
} from "lucide-react";
import { toast } from "sonner";

// ── Status badge ──────────────────────────────────────────────────────────────

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

// ── Scanned record card ───────────────────────────────────────────────────────

function ScannedCard({
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
      {/* Status indicator dot */}
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
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Retry upload"
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={onDelete}
          className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Main scanner page ─────────────────────────────────────────────────────────

export default function ScannerPage() {
  const submitForm = useMutation(api.forms.submitForm);

  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastScannedRef = useRef<string>(""); // debounce duplicate rapid scans
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanned, setScanned] = useState<ScannedSubmission[]>([]);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [chunksProgress, setChunksProgress] = useState<{
    id: string; received: number; needed: number;
  } | null>(null);

  // Refresh the list from storage
  const reload = useCallback(() => setScanned(getScannedSubmissions()), []);

  useEffect(() => {
    evictStaleChunkBuffers();
    reload();
  }, [reload]);

  // ── Upload a scanned submission to Convex ─────────────────────────────────

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

  // ── Handle a decoded QR string ────────────────────────────────────────────

  const handleScan = useCallback(
    (raw: string) => {
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

      if (result.status === "ignored") {
        // Not a scouting code (or a checklist code) — stay quiet.
        return;
      }

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
        setChunksProgress({
          id: "partial",
          received: result.chunksReceived,
          needed: result.chunksNeeded,
        });
        toast.info(
          `Code ${result.chunksReceived}/${result.chunksNeeded} scanned — keep going!`,
          { duration: 2000 }
        );
        return;
      }

      // Complete submission
      setChunksProgress(null);
      reload();
      toast.success(
        `Scanned: Match ${result.submission.matchNumber} · Team ${result.submission.teamNumber}`,
        { duration: 2500 }
      );
      attemptUpload(result.submission);
    },
    [reload, attemptUpload]
  );

  // ── Start / stop camera ───────────────────────────────────────────────────

  const startScanner = useCallback(async () => {
    setCameraError(null);
    setScanning(true);

    // Small delay to let the video element mount
    await new Promise((r) => setTimeout(r, 150));

    if (!videoRef.current) return;

    try {
      const reader = new BrowserQRCodeReader();
      controlsRef.current = await reader.decodeFromVideoDevice(
        undefined,              // undefined = default (back) camera
        videoRef.current,
        (result, err) => {
          if (result) handleScan(result.getText());
          // err is just "no QR found in frame" — ignore
          void err;
        }
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Camera access denied or unavailable.";
      setCameraError(msg);
      setScanning(false);
    }
  }, [handleScan]);

  const stopScanner = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScanning(false);
    setChunksProgress(null);
  }, []);

  // Stop camera on unmount
  useEffect(() => () => { controlsRef.current?.stop(); }, []);

  // Retry upload for pending/failed scans when we come online
  useEffect(() => {
    const handler = () => {
      getScannedSubmissions()
        .filter((s) => s.uploadStatus !== "uploaded")
        .forEach((s) => attemptUpload(s));
    };
    window.addEventListener("online", handler);
    return () => window.removeEventListener("online", handler);
  }, [attemptUpload]);

  // ─────────────────────────────────────────────────────────────────────────

  const pendingCount = scanned.filter((s) => s.uploadStatus !== "uploaded").length;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">QR Scanner</h2>
          <p className="text-muted-foreground text-sm">
            {scanned.length === 0
              ? "Scan a teammate's QR codes to import their data"
              : `${scanned.length} scanned · ${pendingCount} pending upload`}
          </p>
        </div>
        {scanned.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => setClearConfirm(true)}
          >
            <Trash2 className="h-4 w-4 mr-1" /> Clear
          </Button>
        )}
      </div>

      {/* Camera viewfinder — square */}
      <div className="relative rounded-2xl overflow-hidden bg-black aspect-square w-full max-w-xs mx-auto shrink-0 shadow-xl outline-none">
        <video
          ref={videoRef}
          className={`w-full h-full object-cover outline-none ${scanning ? "opacity-100" : "opacity-0"}`}
          autoPlay
          muted
          playsInline
        />

        {/* Scanning overlay */}
        {scanning && (
          <div className="absolute inset-0 pointer-events-none">
            {/* Dark vignette outside the scan zone */}
            <div className="absolute inset-0 bg-black/40" style={{
              maskImage: "radial-gradient(ellipse 70% 70% at 50% 50%, transparent 55%, black 80%)",
              WebkitMaskImage: "radial-gradient(ellipse 70% 70% at 50% 50%, transparent 55%, black 80%)",
            }} />

            {/* Corner brackets — explicit inline styles to avoid phantom border lines */}
            <div className="absolute inset-10">
              {/* Top-left */}
              <div className="absolute top-0 left-0 w-7 h-7" style={{ borderTop: "3px solid white", borderLeft: "3px solid white", borderRadius: "6px 0 0 0" }} />
              {/* Top-right */}
              <div className="absolute top-0 right-0 w-7 h-7" style={{ borderTop: "3px solid white", borderRight: "3px solid white", borderRadius: "0 6px 0 0" }} />
              {/* Bottom-left */}
              <div className="absolute bottom-0 left-0 w-7 h-7" style={{ borderBottom: "3px solid white", borderLeft: "3px solid white", borderRadius: "0 0 0 6px" }} />
              {/* Bottom-right */}
              <div className="absolute bottom-0 right-0 w-7 h-7" style={{ borderBottom: "3px solid white", borderRight: "3px solid white", borderRadius: "0 0 6px 0" }} />
            </div>

            {/* Scan line — white */}
            <div className="absolute left-10 right-10 top-10 bottom-10 overflow-hidden">
              <div className="h-0.5 bg-white/80 shadow-[0_0_6px_2px_rgba(255,255,255,0.5)] animate-[scan_2s_ease-in-out_infinite]" />
            </div>
          </div>
        )}

        {/* Placeholder when not scanning */}
        {!scanning && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted/20">
            {cameraError ? (
              <>
                <CameraOff className="h-10 w-10 text-destructive" />
                <p className="text-xs text-destructive text-center px-4 max-w-xs">{cameraError}</p>
              </>
            ) : (
              <>
                <Camera className="h-10 w-10 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Camera off</p>
              </>
            )}
          </div>
        )}

        {/* Multi-chunk progress overlay */}
        {scanning && chunksProgress && (
          <div className="absolute bottom-3 left-3 right-3 bg-black/70 backdrop-blur rounded-xl px-3 py-2 flex items-center gap-2">
            <Layers className="h-4 w-4 text-white shrink-0" />
            <div className="flex-1">
              <div className="text-xs text-white font-semibold">
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
      </div>

      {/* Camera controls */}
      <div className="flex gap-2 justify-center shrink-0">
        {!scanning ? (
          <Button onClick={startScanner} className="px-8 gap-2">
            <ScanLine className="h-4 w-4" /> Start Scanning
          </Button>
        ) : (
          <Button variant="outline" onClick={stopScanner} className="px-8 gap-2">
            <CameraOff className="h-4 w-4" /> Stop
          </Button>
        )}
        {pendingCount > 0 && navigator.onLine && (
          <Button
            variant="secondary"
            onClick={() => {
              scanned
                .filter((s) => s.uploadStatus !== "uploaded")
                .forEach((s) => attemptUpload(s));
            }}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Retry {pendingCount}
          </Button>
        )}
      </div>

      {/* Scanned submissions list */}
      {scanned.length > 0 && (
        <div className="flex-1 min-h-0 flex flex-col gap-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider shrink-0">
            Scanned submissions
          </p>
          <ScrollArea className="flex-1">
            <div className="space-y-2 pb-4">
              {scanned.map((sub) => (
                <ScannedCard
                  key={sub.id}
                  sub={sub}
                  onRetry={() => attemptUpload(sub)}
                  onDelete={() => {
                    deleteScannedSubmission(sub.id);
                    reload();
                  }}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Empty state (no scans yet, camera not running) */}
      {scanned.length === 0 && !scanning && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-4">
          <div className="text-xs text-muted-foreground max-w-xs space-y-1">
            <p>Point the camera at a teammate's QR code from their <strong>My QR Codes</strong> tab.</p>
            <p>Multi-code submissions are automatically reassembled — just scan each code in order.</p>
          </div>
        </div>
      )}

      {/* Clear confirm */}
      <AlertDialog open={clearConfirm} onOpenChange={setClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Clear all scanned data?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Removes all {scanned.length} locally stored scanned submissions.
              Records already uploaded to Convex are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                clearScannedSubmissions();
                reload();
                setClearConfirm(false);
              }}
            >
              Clear all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
