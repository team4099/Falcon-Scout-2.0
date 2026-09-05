import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { FormField, FormData } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import QRCode from "react-qr-code";
import { fetchTBAEventMatches } from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import { saveMySubmission, toQRChunks, type LocalSubmission } from "@/lib/submissionStore";
import { enqueueOfflineSubmission } from "@/lib/offlineQueue";
import { lsGet, lsGetStale } from "@/lib/persistentCache";
import { useOfflineSync } from "@/hooks/useOfflineSync";
import {
  ClipboardCheck,
  CheckCircle2,
  Send,
  QrCode,
  Wifi,
  WifiOff,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Minus,
  Plus,
  Star,
  AlertCircle,
} from "lucide-react";

// ── Theme tokens — gold / black (matches rest of app) ─────────────────────────
const G     = "oklch(0.85 0.18 95)";         // primary gold
const G_DIM = "oklch(0.85 0.18 95 / 10%)";  // gold tint bg
const G_MED = "oklch(0.85 0.18 95 / 25%)";  // gold border / mid
const G_STR = "oklch(0.85 0.18 95 / 45%)";  // gold strong border
const G_TXT = "oklch(0.1 0 0)";             // text on gold (near-black)
const SURFACE   = "oklch(1 0 0 / 3%)";
const SURF_BORD = "oklch(1 0 0 / 8%)";
const MUTED = "var(--muted-foreground)";
const FG    = "var(--foreground)";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChecklistTemplate {
  _id: string;
  name: string;
  description?: string;
  fields: FormField[];
  isActive: boolean;
}

interface PitRotation {
  _id: string;
  eventKey: string;
  label?: string;
  startMatch?: number;
  endMatch?: number;
  isElims?: boolean;
  scoutIds: string[];
}

interface UserRecord {
  _id: string;
  name?: string;
  email?: string;
}

/** A single checklist assignment: who fills out which form for which match */
interface ChecklistAssignment {
  matchNumber: number;
  templateId: string;
  templateName: string;
  templateFields: FormField[];
  assignedScoutId: string;
  isMyAssignment: boolean;
  completedSubmissionId?: string;
  matchActualTime?: number;  // unix ms when the match actually ran (from TBA)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function displayName(u: UserRecord) {
  return u.name ?? u.email ?? "Scout";
}

function matchSortKey(m: TBAMatch) {
  const lvl: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
  return (lvl[m.comp_level] ?? 99) * 1_000_000 + m.set_number * 10_000 + m.match_number;
}

/**
 * Core assignment algorithm:
 * For each upcoming qual match M:
 *   - Find pit scouts covering match (M - 4) or earlier (their rotation spans M-4)
 *   - For each active checklist template C (index i), assign pitScouts[i % len]
 *   - Try to rotate so different scouts get different checklists
 */
function computeAssignments(
  upcomingMatches: number[],
  pitRotations: PitRotation[],
  checklistTemplates: ChecklistTemplate[],
  myUserId: string,
  completedSet: Set<string>,
  matchTimeMap: Map<number, number>, // matchNumber → actual_time in unix ms (0 = not yet played)
): ChecklistAssignment[] {
  const assignments: ChecklistAssignment[] = [];

  for (const matchNum of upcomingMatches) {
    const pitScoutIds: string[] = [];
    const seen = new Set<string>();
    for (const rot of pitRotations) {
      if (rot.isElims) continue;
      if (rot.startMatch == null || rot.endMatch == null) continue;
      // Must match MySchedulePage's rule exactly, or the two tabs disagree about
      // who owns a checklist. See the note there.
      if (matchNum >= rot.startMatch && matchNum <= rot.endMatch) {
        for (const sid of rot.scoutIds) {
          if (!seen.has(sid)) { seen.add(sid); pitScoutIds.push(sid); }
        }
      }
    }

    if (pitScoutIds.length === 0) continue;

    const rawActual = matchTimeMap.get(matchNum);
    const matchActualTime = rawActual ? rawActual * 1000 : undefined; // convert s → ms

    for (let i = 0; i < checklistTemplates.length; i++) {
      const template = checklistTemplates[i];
      const assignedScoutId = pitScoutIds[i % pitScoutIds.length];
      const isMyAssignment = assignedScoutId === myUserId;
      const doneKey = `${matchNum}-${template._id}`;

      assignments.push({
        matchNumber: matchNum,
        templateId: template._id,
        templateName: template.name,
        templateFields: template.fields as FormField[],
        assignedScoutId,
        isMyAssignment,
        completedSubmissionId: completedSet.has(doneKey) ? doneKey : undefined,
        matchActualTime,
      });
    }
  }

  return assignments;
}

// ── Counter widget ─────────────────────────────────────────────────────────────
function Counter({ value, onChange }: { value: number; onChange: (G: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="outline" size="icon" type="button"
        onClick={() => onChange(Math.max(0, value - 1))} className="h-9 w-9">
        <Minus className="h-4 w-4" />
      </Button>
      <span className="w-12 text-center text-xl font-bold font-mono tabular-nums">{value}</span>
      <Button variant="outline" size="icon" type="button"
        onClick={() => onChange(value + 1)}
        className="h-9 w-9 border-primary/50 hover:bg-primary hover:text-primary-foreground">
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}

// ── Star rating widget ─────────────────────────────────────────────────────────
function StarRating({ value, max, onChange }: { value: number; max: number; onChange: (G: number) => void }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const display = hovered ?? value;
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: max }).map((_, i) => {
        const n = i + 1;
        const filled = n <= display;
        return (
          <button key={n} type="button"
            onMouseEnter={() => setHovered(n)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onChange(value === n ? 0 : n)}
            className="focus:outline-none transition-transform hover:scale-110 active:scale-95">
            <Star className={`h-8 w-8 transition-colors ${filled ? "text-yellow-400 fill-yellow-400" : "text-muted-foreground/30"}`} />
          </button>
        );
      })}
      {value > 0 && <span className="ml-2 text-sm text-muted-foreground font-mono">{value}/{max}</span>}
    </div>
  );
}

// ── Field renderer ────────────────────────────────────────────────────────────
function FieldRenderer({ field, value, onChange }: {
  field: FormField;
  value: FormData[string];
  onChange: (G: FormData[string]) => void;
}) {
  switch (field.type) {
    case "rating": {
      const max = Number(field.options?.[0] ?? "5");
      return <StarRating value={(value as number) ?? 0} max={max} onChange={onChange} />;
    }
    case "text":
      return <Input value={(value as string) ?? ""} onChange={e => onChange(e.target.value)} placeholder={field.label} />;
    case "textarea":
      return <Textarea value={(value as string) ?? ""} onChange={e => onChange(e.target.value)} placeholder={field.label} rows={3} />;
    case "number":
      return <Input type="number" value={(value as number) ?? 0} onChange={e => onChange(Number(e.target.value))} />;
    case "counter":
      return <Counter value={(value as number) ?? 0} onChange={onChange} />;
    case "checkbox":
      return (
        <div className="flex items-center gap-2 pt-1">
          <Checkbox id={field.id} checked={!!(value as boolean)} onCheckedChange={c => onChange(!!c)} />
          <Label htmlFor={field.id} className="font-normal cursor-pointer">{field.label}</Label>
        </div>
      );
    case "select":
      return (
        <Select value={(value as string) ?? ""} onValueChange={G => onChange(G || "")}>
          <SelectTrigger><SelectValue placeholder="Select an option…" /></SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
          </SelectContent>
        </Select>
      );
    default:
      return <Input value={(value as string) ?? ""} onChange={e => onChange(e.target.value)} />;
  }
}

// ── QR Viewer Dialog ──────────────────────────────────────────────────────────
function QRViewerDialog({ sub, open, onClose }: { sub: LocalSubmission; open: boolean; onClose: () => void }) {
  const chunks = toQRChunks(sub);
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [sub.id]);
  const chunk = chunks[idx];

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm w-full p-0 overflow-hidden bg-background">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <QrCode className="h-4 w-4 text-primary shrink-0" />
            Match {sub.matchNumber} · {sub.templateName}
          </DialogTitle>
          {chunks.length > 1 && (
            <p className="text-xs text-muted-foreground">Code {idx + 1} of {chunks.length} — scan all in order</p>
          )}
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 px-4 pb-6">
          <div className="bg-white rounded-2xl p-4 shadow-lg w-full max-w-[280px] mx-auto">
            <QRCode value={chunk.payload} size={248}
              style={{ width: "100%", height: "auto", display: "block" }}
              viewBox="0 0 256 256" level="M" />
          </div>
          {chunks.length > 1 && (
            <div className="flex items-center gap-3 w-full justify-center">
              <Button variant="outline" size="icon" className="h-10 w-10"
                onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0}>
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <div className="flex gap-1.5">
                {chunks.map((_, i) => (
                  <button key={i} onClick={() => setIdx(i)}
                    className={`h-2 rounded-full transition-all ${i === idx ? "w-6 bg-primary" : "w-2 bg-muted-foreground/30"}`} />
                ))}
              </div>
              <Button variant="outline" size="icon" className="h-10 w-10"
                onClick={() => setIdx(i => Math.min(chunks.length - 1, i + 1))} disabled={idx === chunks.length - 1}>
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>
          )}
          {/* Data summary */}
          <div className="w-full rounded-xl border border-border bg-muted/30 divide-y divide-border text-xs overflow-hidden">
            <div className="px-3 py-1.5 font-semibold text-muted-foreground uppercase tracking-wider text-[10px]">Submitted data</div>
            {Object.entries(sub.data).slice(0, 10).map(([k, G]) => (
              <div key={k} className="flex items-start justify-between gap-2 px-3 py-1.5">
                <span className="text-muted-foreground truncate max-w-[140px]">{sub.fieldLabels?.[k] ?? k}</span>
                <span className="font-medium text-right break-all">{String(G ?? "—")}</span>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Checklist Form Dialog ─────────────────────────────────────────────────────
function ChecklistFormDialog({
  assignment, eventKey, assignedScoutId, open, onClose, onCompleted,
}: {
  assignment: ChecklistAssignment;
  eventKey: string;
  assignedScoutId: string;
  open: boolean;
  onClose: () => void;
  onCompleted: (sub: LocalSubmission) => void;
}) {
  const submitChecklist = useMutation(api.checklists.submitChecklist);
  const { refreshCounts } = useOfflineSync();

  const [formData, setFormData] = useState<FormData>({});
  const [submitting, setSubmitting] = useState(false);

  // Reset form on open
  useEffect(() => {
    if (open) setFormData({});
  }, [open, assignment.templateId]);

  function setValue(fieldId: string, value: FormData[string]) {
    setFormData(prev => ({ ...prev, [fieldId]: value }));
  }

  const sections = assignment.templateFields.reduce<Record<string, FormField[]>>((acc, f) => {
    const key = f.section ?? "General";
    acc[key] = [...(acc[key] ?? []), f];
    return acc;
  }, {});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Validate required fields
    const missing = assignment.templateFields.filter(f => f.required && !formData[f.id]);
    if (missing.length > 0) {
      toast.error(`Missing required fields: ${missing.map(f => f.label).join(", ")}`);
      return;
    }

    const offlineId = crypto.randomUUID();

    // Build local submission for QR
    const localSub: LocalSubmission = {
      id: offlineId,
      matchNumber: assignment.matchNumber,
      teamNumber: 0, // checklists are not team-specific
      templateId: assignment.templateId,
      templateName: assignment.templateName,
      eventKey,
      data: {
        _checklistMatch: assignment.matchNumber,
        _checklist: true,
        ...formData,
      } as Record<string, unknown>,
      fieldLabels: {
        _checklistMatch: "For Match",
        _checklist: "Type",
        ...Object.fromEntries(assignment.templateFields.map(f => [f.id, f.label])),
      },
      submittedAt: Date.now(),
    };
    saveMySubmission(localSub);

    setSubmitting(true);
    try {
      if (!navigator.onLine) {
        enqueueOfflineSubmission({
          templateId: assignment.templateId as string,
          eventKey,
          matchNumber: assignment.matchNumber,
          teamNumber: 0,
          data: JSON.stringify({ _checklistMatch: assignment.matchNumber, _checklist: true, ...formData }),
          offlineId,
        });
        refreshCounts();
        toast.success("Saved offline — will sync when reconnected.", { icon: "📶" });
      } else {
        await submitChecklist({
          templateId: assignment.templateId as Id<"formTemplates">,
          eventKey,
          matchNumber: assignment.matchNumber,
          assignedScoutId: assignedScoutId as Id<"users">,
          data: JSON.stringify({ _checklistMatch: assignment.matchNumber, _checklist: true, ...formData }),
          offlineId,
        });
        toast.success("Checklist submitted! ✅");
      }
      onCompleted(localSub);
      onClose();
    } catch {
      toast.error("Submission failed — saved offline instead.");
      enqueueOfflineSubmission({
        templateId: assignment.templateId as string,
        eventKey,
        matchNumber: assignment.matchNumber,
        teamNumber: 0,
        data: JSON.stringify({ _checklistMatch: assignment.matchNumber, _checklist: true, ...formData }),
        offlineId,
      });
      refreshCounts();
      onCompleted(localSub);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" style={{ color: G }} />
            <span>Match {assignment.matchNumber} · {assignment.templateName}</span>
          </DialogTitle>
          {assignment.templateName && (
            <p className="text-sm text-muted-foreground">Complete this checklist for the match happening 4 matches from now.</p>
          )}
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 pt-2">
          {Object.entries(sections).map(([section, sectionFields]) => (
            <div key={section} className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-2 border-b border-border" style={{ background: G_DIM }}>
                <h3 className="font-semibold text-sm" style={{ color: G }}>{section}</h3>
              </div>
              <div className="p-4 space-y-4">
                {sectionFields.map(field => (
                  <div key={field.id} className="space-y-1.5">
                    {field.type !== "checkbox" && (
                      <Label>
                        {field.label}
                        {field.required && <span className="ml-1" style={{ color: G }}>*</span>}
                      </Label>
                    )}
                    <FieldRenderer
                      field={field}
                      value={formData[field.id]}
                      onChange={G => setValue(field.id, G)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {assignment.templateFields.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">This checklist has no fields yet.</p>
          )}

          <Button type="submit" disabled={submitting}
            className="w-full h-12 text-base font-bold"
            style={{ background: G, color: G_TXT }}>
            <Send className="h-4 w-4 mr-2" />
            {submitting ? "Submitting…" : "Submit Checklist"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Assignment Card ────────────────────────────────────────────────────────────
function AssignmentCard({
  assignment, assigneeName, completedByName, isLate, isOnline: _isOnline, onOpen, onViewQR,
}: {
  assignment: ChecklistAssignment;
  assigneeName: string;
  completedByName?: string;
  isLate?: boolean;
  isOnline: boolean;
  onOpen: () => void;
  onViewQR: () => void;
}) {
  const isCompleted = !!assignment.completedSubmissionId;
  // Was it filled in by a different person than the one assigned?
  const filledInByOther = isCompleted && !!completedByName;

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 0,
      borderRadius: 14, border: `1.5px solid ${isCompleted ? G_MED : SURF_BORD}`,
      background: isCompleted ? G_DIM : SURFACE,
      overflow: "hidden",
      transition: "all 0.2s ease",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
        borderBottom: `1px solid ${isCompleted ? G_MED : SURF_BORD}`,
      }}>
        {/* Status icon */}
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: isCompleted ? G : G_DIM,
          border: `1.5px solid ${isCompleted ? G_STR : G_MED}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: isCompleted ? `0 2px 12px ${G} / 40%` : "none",
        }}>
          {isCompleted
            ? <CheckCircle2 size={18} style={{ color: G_TXT }} />
            : <ClipboardCheck size={18} style={{ color: G }} />
          }
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: FG, letterSpacing: "-0.01em" }}>
              {assignment.templateName}
            </div>
            {/* Late badge */}
            {isLate && (
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 800,
                background: "oklch(0.75 0.18 55 / 18%)",
                border: "1px solid oklch(0.75 0.18 55 / 45%)",
                color: "oklch(0.78 0.18 55)",
                textTransform: "uppercase", letterSpacing: "0.07em",
              }}>
                ⚠ Late
              </div>
            )}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            For Match {assignment.matchNumber}
            {" · "}
            <span style={{ color: assignment.isMyAssignment ? G : MUTED, fontWeight: assignment.isMyAssignment ? 700 : 400 }}>
              {assignment.isMyAssignment ? "Assigned to you" : `Assigned to ${assigneeName}`}
            </span>
          </div>
          {/* Filled-in-by badge — only shown in all-assignments view when someone else did it */}
          {filledInByOther && (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4,
              padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700,
              background: G_DIM,
              border: `1px solid ${G_MED}`,
              color: G,
            }}>
              <CheckCircle2 size={11} />
              Filled in by {completedByName}
            </div>
          )}
        </div>

        {/* Match badge */}
        <div style={{
          padding: "4px 12px", borderRadius: 8, flexShrink: 0,
          background: G_DIM, border: `1px solid ${G_MED}`,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: G, textTransform: "uppercase", letterSpacing: "0.06em", lineHeight: 1 }}>Match</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: G, lineHeight: 1.1, letterSpacing: "-0.02em", textAlign: "center" }}>{assignment.matchNumber}</div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, padding: "10px 14px" }}>
        {isCompleted ? (
          <>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 9,
              background: G_DIM, border: `1px solid ${G_MED}`, }}>
              <CheckCircle2 size={14} style={{ color: G, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: G }}>Completed</span>
            </div>
            <button onClick={onViewQR} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "7px 14px",
              borderRadius: 9, cursor: "pointer", fontSize: 13, fontWeight: 700,
              background: SURFACE, border: `1.5px solid ${SURF_BORD}`,
              color: MUTED, transition: "all 0.15s",
            }}>
              <QrCode size={14} /> QR Code
            </button>
          </>
        ) : assignment.isMyAssignment ? (
          // Primary CTA — your assignment
          <button onClick={onOpen} style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "10px 16px", borderRadius: 10, cursor: "pointer",
            fontSize: 14, fontWeight: 800, letterSpacing: "-0.01em",
            background: G, color: G_TXT, border: "none",
            boxShadow: `0 4px 16px ${G} / 35%`,
            transition: "all 0.15s",
          }}>
            <ClipboardCheck size={16} />
            Fill Out Checklist
          </button>
        ) : (
          // Secondary CTA — fill in for someone else
          <button onClick={onOpen} style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "10px 16px", borderRadius: 10, cursor: "pointer",
            fontSize: 13, fontWeight: 700, letterSpacing: "-0.01em",
            background: G_DIM, color: G,
            border: `1.5px dashed ${G_STR}`,
            transition: "all 0.15s",
          }}>
            <ClipboardCheck size={15} />
            Fill in for {assigneeName}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function ChecklistPage() {
  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const eventKey = currentEvent?.eventKey ?? "";

  const viewerLive = useQuery(api.users.viewer);
  const viewer = useCached(viewerLive, "viewer");
  const myUserId = (viewer as { _id?: string } | null)?._id ?? "";

  const allUsersLive = useQuery(api.users.listUsers);
  const allUsers = useCached(allUsersLive, "all_users") as UserRecord[] | undefined;

  const checklistTemplatesLive = useQuery(api.checklists.listActiveChecklistTemplates);
  const checklistTemplates = useCached(checklistTemplatesLive, "active_checklist_templates") as ChecklistTemplate[] | undefined;

  const pitRotationsLive = useQuery(
    api.schedules.listPitRotations,
    eventKey ? { eventKey } : "skip"
  );
  const pitRotations = useCached(pitRotationsLive, `pit_rotations_${eventKey || "none"}`) as PitRotation[] | undefined;

  const myChecklistSubsLive = useQuery(
    api.checklists.getMyChecklistSubmissions,
    eventKey ? { eventKey } : "skip"
  );

  // TBA matches
  const [tbaMatches, setTbaMatches] = useState<TBAMatch[]>(
    () => lsGet<TBAMatch[]>(`tba_matches_full_${eventKey}`) ?? lsGetStale<TBAMatch[]>(`tba_matches_full_${eventKey}`) ?? []
  );
  useEffect(() => {
    if (!eventKey) { setTbaMatches([]); return; }
    fetchTBAEventMatches(eventKey).then(data => {
      if (Array.isArray(data)) setTbaMatches([...data].sort((a, b) => matchSortKey(a) - matchSortKey(b)));
    });
  }, [eventKey]);

  const OUR_TEAM_KEY = "frc4099";

  const qualMatchNums = useMemo(() =>
    tbaMatches
      .filter(m =>
        m.comp_level === "qm" &&
        (
          m.alliances.red.team_keys.includes(OUR_TEAM_KEY) ||
          m.alliances.blue.team_keys.includes(OUR_TEAM_KEY)
        )
      )
      .map(m => m.match_number)
      .sort((a, b) => a - b),
    [tbaMatches]
  );

  // Build completed set + completion-time map from Convex data
  const completedSet = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const sub of myChecklistSubsLive ?? []) {
      s.add(`${sub.matchNumber}-${sub.templateId}`);
    }
    return s;
  }, [myChecklistSubsLive]);

  // matchNumber → completedAt (ms) for Convex-synced submissions
  const convexCompletionTimes = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const sub of myChecklistSubsLive ?? []) {
      if (sub.completedAt) m.set(`${sub.matchNumber}-${sub.templateId}`, sub.completedAt);
    }
    return m;
  }, [myChecklistSubsLive]);

  // matchNumber → actual_time (unix seconds) from TBA
  const matchTimeMap = useMemo<Map<number, number>>(() => {
    const m = new Map<number, number>();
    for (const match of tbaMatches) {
      if (match.comp_level === "qm" && match.actual_time) {
        m.set(match.match_number, match.actual_time);
      }
    }
    return m;
  }, [tbaMatches]);

  // Compute assignments
  const assignments = useMemo(() => {
    if (!checklistTemplates || !pitRotations || !myUserId) return [];
    return computeAssignments(qualMatchNums, pitRotations, checklistTemplates, myUserId, completedSet, matchTimeMap);
  }, [qualMatchNums, checklistTemplates, pitRotations, myUserId, completedSet, matchTimeMap]);

  // Only show assignments that are mine, or all (toggle)
  const [showAll, setShowAll] = useState(false);
  const displayed = showAll ? assignments : assignments.filter(a => a.isMyAssignment);

  const myCount = assignments.filter(a => a.isMyAssignment).length;
  const completedCount = assignments.filter(a => a.isMyAssignment && !!a.completedSubmissionId).length;

  // Dialog state
  const [activeAssignment, setActiveAssignment] = useState<ChecklistAssignment | null>(null);

  // Deep link from My Schedule: /checklist?match=39&template=<id> opens straight
  // into that checklist. Fires once, after assignments resolve — before that the
  // list is empty and there is nothing to match against.
  const [searchParams] = useSearchParams();
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || assignments.length === 0) return;
    const wantMatch = Number(searchParams.get("match"));
    const wantTemplate = searchParams.get("template");
    if (!wantMatch || !wantTemplate) return;
    const hit = assignments.find(
      (a) => a.matchNumber === wantMatch && String(a.templateId) === wantTemplate
    );
    deepLinkDone.current = true;
    if (hit) setActiveAssignment(hit);
  }, [assignments, searchParams]);
  const [viewingQR, setViewingQR] = useState<LocalSubmission | null>(null);
  // Track recently-submitted QR subs keyed by "matchNum-templateId" → { sub, completedByName }
  const [localSubs, setLocalSubs] = useState<Map<string, { sub: LocalSubmission; completedByName: string }>>(new Map());

  const isOnline = navigator.onLine;

  const userMap = useMemo(() =>
    Object.fromEntries((allUsers ?? []).map(u => [u._id, u])),
    [allUsers]
  );

  const myName = myUserId && userMap[myUserId] ? displayName(userMap[myUserId]) : "You";

  function handleCompleted(sub: LocalSubmission) {
    setLocalSubs(prev => {
      const next = new Map(prev);
      next.set(`${sub.matchNumber}-${sub.templateId}`, { sub, completedByName: myName });
      return next;
    });
  }

  if (!currentEvent) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: G_DIM, border: `1.5px solid ${G_MED}`,
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          <CalendarDays size={28} style={{ color: MUTED }} />
        </div>
        <div>
          <div className="text-base font-bold">No Event Selected</div>
          <div className="text-sm text-muted-foreground mt-1">Ask an admin to set the current event.</div>
        </div>
      </div>
    );
  }

  const loading = checklistTemplates === undefined || pitRotations === undefined;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-3 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-4 border-t-transparent" style={{ borderColor: G, borderTopColor: 'transparent' }} />
        <span className="text-sm">Loading checklists…</span>
      </div>
    );
  }

  if ((checklistTemplates?.length ?? 0) === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center px-4">
        <div style={{ width: 64, height: 64, borderRadius: 18, background: G_DIM, border: `1.5px solid ${G_MED}`,
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ClipboardCheck size={28} style={{ color: G }} />
        </div>
        <div>
          <div className="text-base font-bold">No Active Checklists</div>
          <div className="text-sm text-muted-foreground mt-1">
            Ask an admin to create and activate a Checklist form in the Form Builder.
          </div>
        </div>
      </div>
    );
  }

  if (assignments.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: G, display: "flex", alignItems: "center",
            justifyContent: "center", boxShadow: `0 4px 16px ${G} / 40%` }}>
            <ClipboardCheck size={19} color={G_TXT} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: FG, margin: 0, letterSpacing: "-0.02em" }}>Checklists</h1>
            <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>{currentEvent.eventName ?? currentEvent.eventKey}</p>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "40px 16px", textAlign: "center",
          borderRadius: 16, background: SURFACE, border: `1px solid ${SURF_BORD}` }}>
          <AlertCircle size={32} style={{ color: MUTED, opacity: 0.4 }} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: FG }}>No checklist assignments yet</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, maxWidth: 300 }}>
              Assignments are generated from pit rotations. Ensure pit rotations are set up in Scheduling.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: G, display: "flex", alignItems: "center",
          justifyContent: "center", boxShadow: `0 4px 16px ${G} / 40%` }}>
          <ClipboardCheck size={19} color={G_TXT} />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: FG, margin: 0, letterSpacing: "-0.02em" }}>Checklists</h1>
          <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>{currentEvent.eventName ?? currentEvent.eventKey}</p>
        </div>
        {/* Online/offline badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20,
          background: isOnline ? "oklch(0.5 0.2 150 / 12%)" : "oklch(0.8 0.18 95 / 12%)",
          border: `1px solid ${isOnline ? "oklch(0.5 0.2 150 / 25%)" : "oklch(0.8 0.18 95 / 25%)"}` }}>
          {isOnline
            ? <Wifi size={12} style={{ color: "oklch(0.55 0.2 150)" }} />
            : <WifiOff size={12} style={{ color: "oklch(0.8 0.18 95)" }} />
          }
          <span style={{ fontSize: 11, fontWeight: 700, color: isOnline ? "oklch(0.55 0.2 150)" : "oklch(0.8 0.18 95)" }}>
            {isOnline ? "Online" : "Offline"}
          </span>
        </div>
      </div>

      {/* ── Summary strip ───────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 2, padding: 4, borderRadius: 14, background: SURFACE, border: `1px solid ${SURF_BORD}` }}>
        {([
          { label: "Assigned", count: myCount, accent: true },
          { label: "Completed", count: completedCount, accent: false },
          { label: "Pending", count: myCount - completedCount, accent: false },
        ] as const).map(({ label, count, accent }) => (
          <div key={label} style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 10,
            background: accent && count > 0 ? G_DIM : "transparent", border: `1px solid ${accent && count > 0 ? G_MED : "transparent"}` }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: FG, lineHeight: 1 }}>{count}</div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: accent && count > 0 ? G : MUTED }}>{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Toggle: my assignments vs all ───────────────────────────────────── */}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => setShowAll(false)} style={{
          flex: 1, padding: "8px 0", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer",
          background: !showAll ? G : SURFACE, color: !showAll ? G_TXT : MUTED,
          border: `1.5px solid ${!showAll ? G_STR : SURF_BORD}`,
          transition: "all 0.15s",
        }}>
          My Assignments ({myCount})
        </button>
        <button onClick={() => setShowAll(true)} style={{
          flex: 1, padding: "8px 0", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer",
          background: showAll ? G : SURFACE, color: showAll ? G_TXT : MUTED,
          border: `1.5px solid ${showAll ? G_STR : SURF_BORD}`,
          transition: "all 0.15s",
        }}>
          All Assignments ({assignments.length})
        </button>
      </div>

      {/* ── Assignment list ──────────────────────────────────────────────────── */}
      <ScrollArea className="flex-1">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 24 }}>
          {displayed.length === 0 && (
            <div style={{ textAlign: "center", padding: "32px 0", color: MUTED, fontSize: 13 }}>
              No assignments to show.
            </div>
          )}
          {displayed.map(a => {
            const localSubKey = `${a.matchNumber}-${a.templateId}`;
            const localEntry = localSubs.get(localSubKey);
            const isCompleted = !!a.completedSubmissionId || !!localEntry;
            const displayAssignment: ChecklistAssignment = {
              ...a,
              completedSubmissionId: isCompleted ? (a.completedSubmissionId ?? localSubKey) : undefined,
            };
            const assigneeName = userMap[a.assignedScoutId] ? displayName(userMap[a.assignedScoutId]) : "Unknown";

            // Completion timestamp: prefer local (freshest), fall back to Convex
            const completionTime: number | undefined =
              localEntry?.sub.submittedAt ??
              convexCompletionTimes.get(localSubKey);

            // Late = submitted after the match actually ran
            const isLate = !!(isCompleted && completionTime && a.matchActualTime && completionTime > a.matchActualTime);

            // Determine completer name — only show if different from assignee
            let completedByName: string | undefined;
            if (isCompleted && localEntry) {
              const completedByMe = a.assignedScoutId !== myUserId;
              completedByName = completedByMe ? localEntry.completedByName : undefined;
            }

            return (
              <AssignmentCard
                key={`${a.matchNumber}-${a.templateId}`}
                assignment={displayAssignment}
                assigneeName={assigneeName}
                completedByName={completedByName}
                isLate={isLate}
                isOnline={isOnline}
                onOpen={() => setActiveAssignment(a)}
                onViewQR={() => { if (localEntry?.sub) setViewingQR(localEntry.sub); }}
              />
            );
          })}
        </div>
      </ScrollArea>

      {/* ── Checklist form dialog ────────────────────────────────────────────── */}
      {activeAssignment && (
        <ChecklistFormDialog
          assignment={activeAssignment}
          eventKey={eventKey}
          assignedScoutId={myUserId}
          open={!!activeAssignment}
          onClose={() => setActiveAssignment(null)}
          onCompleted={handleCompleted}
        />
      )}

      {/* ── QR viewer dialog ─────────────────────────────────────────────────── */}
      {viewingQR && (
        <QRViewerDialog
          sub={viewingQR}
          open={!!viewingQR}
          onClose={() => setViewingQR(null)}
        />
      )}
    </div>
  );
}
