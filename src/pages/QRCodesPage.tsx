import { useState, useEffect, useCallback } from "react";
import { matchKey, matchLabel, matchSortValue } from "@/lib/utils";
import QRCode from "react-qr-code";
import {
  getMySubmissions,
  deleteMySubmission,
  clearMySubmissions,
  toQRChunks,
  type LocalSubmission,
} from "@/lib/submissionStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  QrCode,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  AlertTriangle,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function groupByMatch(subs: LocalSubmission[]): Map<string, LocalSubmission[]> {
  // Keyed by comp level + number so a qualification and an elimination match
  // with the same number don't land in the same group.
  const map = new Map<string, LocalSubmission[]>();
  for (const s of subs) {
    const k = matchKey(s.matchNumber, s.compLevel);
    const arr = map.get(k) ?? [];
    arr.push(s);
    map.set(k, arr);
  }
  return map;
}

// ── QR Viewer Dialog ──────────────────────────────────────────────────────────

function QRViewer({
  sub,
  open,
  onClose,
}: {
  sub: LocalSubmission;
  open: boolean;
  onClose: () => void;
}) {
  const chunks = toQRChunks(sub);
  const [idx, setIdx] = useState(0);

  // Reset to first chunk when submission changes
  useEffect(() => setIdx(0), [sub.id]);

  const chunk = chunks[idx];
  const hasPrev = idx > 0;
  const hasNext = idx < chunks.length - 1;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm w-full p-0 overflow-hidden bg-background">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <QrCode className="h-4 w-4 text-primary shrink-0" />
            Match {matchLabel(sub.matchNumber, sub.compLevel)} · Team {sub.teamNumber || "—"}
          </DialogTitle>
          {chunks.length > 1 && (
            <p className="text-xs text-muted-foreground">
              Code {idx + 1} of {chunks.length} — scan all codes in order
            </p>
          )}
        </DialogHeader>

        {/* QR code — white background required for scanners */}
        <div className="flex flex-col items-center gap-4 px-4 pb-6">
          <div className="bg-white rounded-2xl p-4 shadow-lg w-full max-w-[280px] mx-auto">
            <QRCode
              value={chunk.payload}
              size={248}
              style={{ width: "100%", height: "auto", display: "block" }}
              viewBox="0 0 256 256"
              level="M"
            />
          </div>

          {/* Chunk navigation */}
          {chunks.length > 1 && (
            <div className="flex items-center gap-3 w-full justify-center">
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10"
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
                disabled={!hasPrev}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>

              <div className="flex gap-1.5">
                {chunks.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setIdx(i)}
                    className={`h-2 rounded-full transition-all ${
                      i === idx
                        ? "w-6 bg-primary"
                        : "w-2 bg-muted-foreground/30"
                    }`}
                  />
                ))}
              </div>

              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10"
                onClick={() => setIdx((i) => Math.min(chunks.length - 1, i + 1))}
                disabled={!hasNext}
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>
          )}

          {/* Field summary */}
          <div className="w-full rounded-xl border border-border bg-muted/30 divide-y divide-border text-xs overflow-hidden">
            <div className="px-3 py-1.5 font-semibold text-muted-foreground uppercase tracking-wider text-[10px]">
              Submitted data
            </div>
            {/* Always show match info first */}
            {sub.data._matchPrefix !== undefined && (
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-primary/5">
                <span className="text-muted-foreground">Match Prefix</span>
                <span className="font-bold text-primary uppercase">{String(sub.data._matchPrefix)}</span>
              </div>
            )}
            {sub.data._matchNumber !== undefined && (
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-primary/5">
                <span className="text-muted-foreground">Match Number</span>
                <span className="font-bold text-primary">{String(sub.data._matchNumber)}</span>
              </div>
            )}
            {Object.entries(sub.data)
              .filter(([k]) => k !== "_matchPrefix" && k !== "_matchNumber")
              .slice(0, 12)
              .map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-2 px-3 py-1.5">
                  <span className="text-muted-foreground truncate max-w-[140px]">
                    {sub.fieldLabels?.[k] ?? k}
                  </span>
                  <span className="font-medium text-right break-all">{String(v ?? "—")}</span>
                </div>
              ))}
            {Object.keys(sub.data).filter(k => k !== "_matchPrefix" && k !== "_matchNumber").length > 12 && (
              <div className="px-3 py-1.5 text-muted-foreground italic">
                +{Object.keys(sub.data).filter(k => k !== "_matchPrefix" && k !== "_matchNumber").length - 12} more fields
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Submission Card ───────────────────────────────────────────────────────────

function SubmissionCard({
  sub,
  onView,
  onDelete,
}: {
  sub: LocalSubmission;
  onView: () => void;
  onDelete: () => void;
}) {
  const chunks = toQRChunks(sub);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden active:scale-[0.98] transition-transform">
      {/* Tap area → open QR viewer */}
      <button
        className="w-full text-left p-4 flex items-center gap-4 hover:bg-muted/30 transition-colors"
        onClick={onView}
      >
        {/* Mini QR preview */}
        <div className="bg-white rounded-lg p-1.5 shrink-0 shadow-sm">
          <QRCode
            value={chunks[0].payload}
            size={52}
            style={{ display: "block" }}
            level="L"
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-bold text-base">
              {sub.teamNumber ? `Team ${sub.teamNumber}` : "No team #"}
            </span>
            {chunks.length > 1 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/20 text-primary font-semibold">
                {chunks.length} codes
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {sub.templateName} · {formatTime(sub.submittedAt)}
          </p>
          <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5 truncate">
            {sub.eventKey}
          </p>
        </div>

        <QrCode className="h-5 w-5 text-muted-foreground shrink-0" />
      </button>

      {/* Delete */}
      <div className="border-t border-border px-4 py-1.5 flex justify-end">
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-xs text-destructive hover:text-destructive flex items-center gap-1 py-1 px-2 rounded hover:bg-destructive/10 transition-colors"
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function QRCodesPage() {
  const [subs, setSubs] = useState<LocalSubmission[]>([]);
  const [viewing, setViewing] = useState<LocalSubmission | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);

  const reload = useCallback(() => setSubs(getMySubmissions()), []);

  useEffect(() => {
    reload();
    // Refresh when the page becomes visible (scout may have just submitted)
    const handler = () => reload();
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [reload]);

  function handleDelete(id: string) {
    deleteMySubmission(id);
    reload();
    if (viewing?.id === id) setViewing(null);
  }

  function handleClearAll() {
    clearMySubmissions();
    reload();
    setViewing(null);
    setClearConfirm(false);
  }

  const byMatch = groupByMatch(subs);
  // Newest match first; quals and elims are separate groups, elims listed above
  // quals since they come later in the event.
  const matchKeys = Array.from(byMatch.keys()).sort((a, b) => {
    const va = byMatch.get(a)![0];
    const vb = byMatch.get(b)![0];
    return (
      matchSortValue(vb.matchNumber, vb.compLevel) -
      matchSortValue(va.matchNumber, va.compLevel)
    );
  });

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">My QR Codes</h2>
          <p className="text-muted-foreground text-sm">
            {subs.length === 0
              ? "No submissions yet"
              : `${subs.length} submission${subs.length !== 1 ? "s" : ""} · tap to scan`}
          </p>
        </div>
        {subs.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => setClearConfirm(true)}
          >
            <Trash2 className="h-4 w-4 mr-1" /> Clear all
          </Button>
        )}
      </div>

      {/* Empty state */}
      {subs.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-4">
          <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center">
            <QrCode className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <p className="font-semibold">No scouting submissions yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Submit a match via Scout Match and your QR codes will appear here — even offline.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 rounded-xl px-4 py-3 mt-2">
            <ClipboardList className="h-4 w-4 shrink-0" />
            Go to <strong className="mx-0.5">Scout Match</strong> to start scouting
          </div>
        </div>
      )}

      {/* Submissions grouped by match */}
      <ScrollArea className="flex-1 -mx-1 px-1">
        <div className="space-y-6 pb-4">
          {matchKeys.map((key) => {
            const matchSubs = byMatch.get(key)!;
            const head = matchSubs[0];
            return (
              <div key={key}>
                {/* Match header */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-bold text-primary uppercase tracking-wider">
                    Match {matchLabel(head.matchNumber, head.compLevel)}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs text-muted-foreground">
                    {matchSubs.length} scout{matchSubs.length !== 1 ? "s" : ""}
                  </span>
                </div>

                {/* Cards grid — 1 col on mobile, 2 on tablet+ */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {matchSubs.map((sub) => (
                    <SubmissionCard
                      key={sub.id}
                      sub={sub}
                      onView={() => setViewing(sub)}
                      onDelete={() => handleDelete(sub.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* QR Viewer */}
      {viewing && (
        <QRViewer
          sub={viewing}
          open={true}
          onClose={() => setViewing(null)}
        />
      )}

      {/* Clear all confirm */}
      <AlertDialog open={clearConfirm} onOpenChange={setClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Clear all submissions?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes all {subs.length} locally stored scouting submissions and their QR codes.
              Submissions already synced to Convex are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleClearAll}
            >
              Clear all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
