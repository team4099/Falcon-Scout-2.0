// Shared by Manage Scouts and the Submissions feed: submission/template types,
// the read-only submission viewer (admin delete in the footer — the mutation
// itself is gated by requireAdmin server-side), and the admin lock screen.
import { useState } from "react";
import { useAdminMutation } from "@/hooks/useAdminMutation";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { ClipboardList, Hash, X, Star, CheckCircle2, Trash2, AlertTriangle, ShieldAlert, Lock } from "lucide-react";

export interface Submission {
  _id: string;
  templateId: string;
  eventKey: string;
  matchNumber?: number;
  teamNumber?: number;
  scoutId?: string;
  data: string;
  syncedAt: number;
}

export interface FormField {
  id: string;
  type: string;
  label: string;
  required: boolean;
  options?: string[];
  section?: string;
}

export interface FormTemplate {
  _id: string;
  name: string;
  fields: FormField[];
  formType?: string;
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Submission Detail Modal ──────────────────────────────────────────────────

export function SubmissionDetailModal({
  submission,
  scoutName,
  templates,
  onClose,
  onDeleted,
}: {
  submission: Submission;
  scoutName: string;
  templates: FormTemplate[] | undefined;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const deleteSubmission = useAdminMutation(api.forms.deleteSubmission);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const template = (templates ?? []).find((t) => t._id === submission.templateId);

  let parsedData: Record<string, unknown> = {};
  try {
    parsedData = JSON.parse(submission.data);
  } catch {
    /* leave empty */
  }

  // Group fields by section
  const sections: Record<string, FormField[]> = {};
  const noSection: FormField[] = [];
  if (template) {
    for (const field of template.fields) {
      if (field.section) {
        if (!sections[field.section]) sections[field.section] = [];
        sections[field.section].push(field);
      } else {
        noSection.push(field);
      }
    }
  }

  function renderValue(field: FormField): React.ReactNode {
    const raw = parsedData[field.id];
    if (raw === undefined || raw === null || raw === "") {
      return <span style={{ color: "var(--muted-foreground)", fontStyle: "italic", fontSize: 12 }}>—</span>;
    }
    if (field.type === "checkbox") {
      return (
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "2px 9px", borderRadius: 20, fontSize: 12, fontWeight: 600,
          background: raw ? "oklch(0.55 0.2 145 / 15%)" : "oklch(1 0 0 / 5%)",
          border: `1px solid ${raw ? "oklch(0.55 0.2 145 / 35%)" : "oklch(1 0 0 / 10%)"}`,
          color: raw ? "oklch(0.6 0.2 145)" : "var(--muted-foreground)",
        }}>
          {raw ? <CheckCircle2 size={11} /> : <X size={11} />}
          {raw ? "Yes" : "No"}
        </span>
      );
    }
    if (field.type === "rating") {
      const num = Number(raw);
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              size={14}
              style={{
                color: i < num ? "oklch(0.85 0.18 95)" : "oklch(1 0 0 / 20%)",
                fill: i < num ? "oklch(0.85 0.18 95)" : "none",
              }}
            />
          ))}
          <span style={{ fontSize: 12, color: "var(--muted-foreground)", marginLeft: 4 }}>{num}/5</span>
        </div>
      );
    }
    if (field.type === "counter" || field.type === "number") {
      return (
        <span style={{
          fontWeight: 700, fontSize: 16,
          color: "oklch(0.85 0.18 95)",
          background: "oklch(0.85 0.18 95 / 10%)",
          padding: "2px 10px", borderRadius: 8,
        }}>
          {String(raw)}
        </span>
      );
    }
    if (field.type === "textarea") {
      return (
        <div style={{
          fontSize: 13, color: "var(--foreground)",
          background: "oklch(1 0 0 / 4%)", border: "1px solid oklch(1 0 0 / 8%)",
          borderRadius: 8, padding: "8px 10px", whiteSpace: "pre-wrap", lineHeight: 1.5,
        }}>
          {String(raw)}
        </div>
      );
    }
    return (
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>
        {String(raw)}
      </span>
    );
  }

  function renderFields(fields: FormField[]) {
    return fields.map((field) => (
      <div key={field.id} style={{
        display: "flex", flexDirection: "column", gap: 4,
        padding: "8px 0",
        borderBottom: "1px solid oklch(1 0 0 / 6%)",
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)" }}>
          {field.label}
        </div>
        <div>{renderValue(field)}</div>
      </div>
    ));
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deleteSubmission({ id: submission._id as any });
      onDeleted();
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "oklch(0 0 0 / 60%)",
        backdropFilter: "blur(4px)",
        padding: "16px",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--background)",
          border: "1px solid oklch(0.85 0.18 95 / 30%)",
          borderRadius: 20,
          width: "100%",
          maxWidth: 520,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 80px oklch(0 0 0 / 60%), 0 0 0 1px oklch(0.85 0.18 95 / 15%)",
        }}
      >
        {/* Modal header */}
        <div style={{
          padding: "16px 20px",
          borderBottom: "1px solid oklch(0.85 0.18 95 / 20%)",
          background: "oklch(0.85 0.18 95 / 6%)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}>
          <div style={{
            display: "flex", flexDirection: "column", flex: 1, minWidth: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{
                background: "oklch(0.85 0.18 95)",
                borderRadius: 8,
                padding: "3px 10px",
                display: "flex", alignItems: "center", gap: 5,
                boxShadow: "0 2px 8px oklch(0.85 0.18 95 / 30%)",
              }}>
                <Hash size={11} color="oklch(0.1 0 0)" />
                <span style={{ color: "oklch(0.1 0 0)", fontWeight: 800, fontSize: 13 }}>
                  Match {submission.matchNumber ?? "—"}
                </span>
              </div>
              <div style={{
                background: "oklch(1 0 0 / 6%)",
                border: "1px solid oklch(1 0 0 / 10%)",
                borderRadius: 8, padding: "3px 10px",
                display: "flex", alignItems: "center", gap: 5,
              }}>
                <ClipboardList size={11} style={{ color: "var(--muted-foreground)" }} />
                <span style={{ fontWeight: 700, fontSize: 13 }}>Team {submission.teamNumber ?? "—"}</span>
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 4 }}>
              Scouted by <strong style={{ color: "var(--foreground)" }}>{scoutName}</strong>
              {" · "}{formatTimestamp(submission.syncedAt)}
              {template && <> · <span style={{ color: "oklch(0.75 0.18 95)" }}>{template.name}</span></>}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} style={{ flexShrink: 0 }}>
            <X size={17} />
          </Button>
        </div>

        {/* Modal body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
          <div style={{ padding: "16px 20px 20px" }}>
            {!template ? (
              <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--muted-foreground)", fontSize: 13 }}>
                <ClipboardList size={28} style={{ margin: "0 auto 10px", opacity: 0.4 }} />
                Template not found. Raw data below:
                <pre style={{ marginTop: 12, fontSize: 11, textAlign: "left", background: "oklch(1 0 0 / 4%)", borderRadius: 8, padding: 10, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {JSON.stringify(parsedData, null, 2)}
                </pre>
              </div>
            ) : (
              <>
                {/* No-section fields */}
                {noSection.length > 0 && renderFields(noSection)}

                {/* Sectioned fields */}
                {Object.entries(sections).map(([sectionName, fields]) => (
                  <div key={sectionName} style={{ marginTop: 16 }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
                      color: "oklch(0.85 0.18 95)",
                      padding: "4px 0",
                      borderBottom: "1px solid oklch(0.85 0.18 95 / 25%)",
                      marginBottom: 4,
                    }}>
                      {sectionName}
                    </div>
                    {renderFields(fields)}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Modal footer — delete */}
        <div style={{
          padding: "12px 20px",
          borderTop: "1px solid oklch(1 0 0 / 8%)",
          flexShrink: 0,
          background: "oklch(1 0 0 / 2%)",
        }}>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                display: "flex", alignItems: "center", gap: 7,
                padding: "8px 14px", borderRadius: 10,
                border: "1px solid oklch(0.6 0.22 25 / 30%)",
                background: "oklch(0.6 0.22 25 / 8%)",
                color: "oklch(0.65 0.22 25)",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "oklch(0.6 0.22 25 / 16%)";
                (e.currentTarget as HTMLButtonElement).style.borderColor = "oklch(0.6 0.22 25 / 50%)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "oklch(0.6 0.22 25 / 8%)";
                (e.currentTarget as HTMLButtonElement).style.borderColor = "oklch(0.6 0.22 25 / 30%)";
              }}
            >
              <Trash2 size={14} />
              Delete Report
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "oklch(0.65 0.22 25)", fontWeight: 600 }}>
                <AlertTriangle size={14} />
                Are you sure? This cannot be undone.
              </div>
              <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                <button
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                  style={{
                    padding: "6px 14px", borderRadius: 9,
                    border: "1px solid oklch(1 0 0 / 12%)",
                    background: "transparent",
                    color: "var(--muted-foreground)",
                    fontSize: 13, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  style={{
                    padding: "6px 14px", borderRadius: 9,
                    border: "none",
                    background: "oklch(0.6 0.22 25)",
                    color: "white",
                    fontSize: 13, fontWeight: 700, cursor: deleting ? "not-allowed" : "pointer",
                    opacity: deleting ? 0.6 : 1,
                    transition: "opacity 0.15s",
                  }}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Admin Lock Screen ────────────────────────────────────────────────────────

export function AdminLockScreen({ feature }: { feature: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-muted-foreground select-none">
      <div className="flex flex-col items-center gap-4 p-10 rounded-2xl border border-border bg-card max-w-sm w-full text-center shadow-sm">
        <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
          <ShieldAlert className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-bold tracking-tight text-foreground">Admin Access Required</h2>
          <p className="text-sm text-muted-foreground">
            {feature} is restricted to admins. Enable admin mode in Settings to continue.
          </p>
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-muted/50 border border-border/50 text-sm text-muted-foreground w-full justify-center">
          <Lock className="h-4 w-4 shrink-0" />
          <span>Go to <strong className="text-foreground">Settings → Admin Mode</strong></span>
        </div>
      </div>
    </div>
  );
}
