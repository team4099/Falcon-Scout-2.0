import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { useAdminMutation } from "@/hooks/useAdminMutation";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import { useUIStore } from "@/store/uiStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Users,
  ShieldAlert,
  Lock,
  ClipboardList,
  CalendarDays,
  Hash,
  ChevronRight,
  X,
  UserCheck,
  UserX,
  Trophy,
  Star,
  SlidersHorizontal,
  UserPlus,
  ClipboardCheck,
  Wrench as WrenchIcon,
  CheckCircle2,
  CalendarCheck,
  Trash2,
  UserMinus,
  Eye,
  AlertTriangle,
  Ban,
  ShieldCheck,
  Clock,
  Pencil,
  Save,
  XCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface User {
  _id: string;
  name?: string;
  email?: string;
  image?: string;
}

interface ScoutPreference {
  _id: string;
  scoutId: string;
  eventKey: string;
  preferredPartners: string[];
  wantsMoreMatches: boolean;
  wantsPitRotation: boolean;
  wantsPitScouting?: boolean;
  updatedAt: number;
}

interface Submission {
  _id: string;
  templateId: string;
  eventKey: string;
  matchNumber?: number;
  teamNumber?: number;
  scoutId?: string;
  data: string;
  syncedAt: number;
}

interface FormField {
  id: string;
  type: string;
  label: string;
  required: boolean;
  options?: string[];
  section?: string;
}

interface FormTemplate {
  _id: string;
  name: string;
  fields: FormField[];
  formType?: string;
}

interface MatchAssignment {
  _id: string;
  eventKey: string;
  matchNumber: number;
  matchLabel: string;
  position: "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";
  scoutId: string;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function displayName(user: User): string {
  return user.name ?? user.email ?? "Unknown Scout";
}

function avatarLetter(user: User): string {
  return displayName(user).charAt(0).toUpperCase();
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  if (hours <= 0) return `${minutes}m left`;
  return `${hours}h ${minutes}m left`;
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
// All avatars use the site's yellow primary palette for a cohesive look.

function Avatar({ user, size = 40 }: { user: User; size?: number }) {
  if (user.image) {
    return (
      <img
        src={user.image}
        alt={displayName(user)}
        referrerPolicy="no-referrer"
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "linear-gradient(135deg, oklch(0.85 0.18 95 / 90%) 0%, oklch(0.75 0.20 80 / 90%) 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.38,
        fontWeight: 800,
        color: "oklch(0.1 0 0)",
        flexShrink: 0,
        boxShadow: "0 2px 10px oklch(0.85 0.18 95 / 35%)",
        border: "1.5px solid oklch(0.85 0.18 95 / 40%)",
      }}
    >
      {avatarLetter(user)}
    </div>
  );
}

// ─── Scout List Row ───────────────────────────────────────────────────────────

interface ScoutRowProps {
  user: User;
  count: number;
  selected: boolean;
  onClick: () => void;
  hasSubmissions: boolean;
  rank?: number;
  hasPrefs?: boolean;
  isExcluded?: boolean;
}

function ScoutRow({ user, count, selected, onClick, hasSubmissions, rank, hasPrefs, isExcluded }: ScoutRowProps) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left transition-all duration-150 rounded-xl"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 13px",
        background: selected
          ? "oklch(0.85 0.18 95 / 12%)"
          : "transparent",
        border: selected
          ? "1px solid oklch(0.85 0.18 95 / 45%)"
          : "1px solid transparent",
        outline: "none",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background = "oklch(0.85 0.18 95 / 6%)";
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <div style={{ position: "relative", flexShrink: 0 }}>
        <Avatar user={user} size={40} />
        {rank === 1 && (
          <div
            style={{
              position: "absolute",
              bottom: -3,
              right: -3,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "oklch(0.85 0.18 95)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1.5px solid var(--background)",
            }}
          >
            <Star size={8} color="oklch(0.1 0 0)" fill="oklch(0.1 0 0)" />
          </div>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            color: "var(--foreground)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {displayName(user)}
        </div>
        {user.email && user.name && (
          <div
            style={{
              fontSize: 11,
              color: "var(--muted-foreground)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {user.email}
          </div>
        )}
      </div>

      {hasSubmissions ? (
        <span
          style={{
            background: "oklch(0.85 0.18 95)",
            color: "oklch(0.1 0 0)",
            borderRadius: 20,
            padding: "2px 10px",
            fontSize: 12,
            fontWeight: 800,
            minWidth: 28,
            textAlign: "center",
            boxShadow: "0 2px 8px oklch(0.85 0.18 95 / 40%)",
            flexShrink: 0,
          }}
        >
          {count}
        </span>
      ) : (
        <span
          style={{
            background: "oklch(1 0 0 / 6%)",
            color: "var(--muted-foreground)",
            borderRadius: 20,
            padding: "2px 10px",
            fontSize: 12,
            fontWeight: 600,
            minWidth: 28,
            textAlign: "center",
            flexShrink: 0,
          }}
        >
          0
        </span>
      )}

      {/* Excluded badge */}
      {isExcluded && (
        <span title="Excluded from schedule generation" style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
          background: "oklch(0.55 0.18 30 / 20%)",
          border: "1px solid oklch(0.55 0.18 30 / 40%)",
        }}>
          <Ban size={10} style={{ color: "oklch(0.72 0.18 30)" }} />
        </span>
      )}

      {/* Preferences badge */}
      {hasPrefs && (
        <span title="Has submitted preferences" style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
          background: "oklch(0.65 0.18 270 / 20%)",
          border: "1px solid oklch(0.65 0.18 270 / 40%)",
        }}>
          <SlidersHorizontal size={10} style={{ color: "oklch(0.7 0.18 270)" }} />
        </span>
      )}

      <ChevronRight
        size={15}
        style={{
          color: selected ? "oklch(0.85 0.18 95)" : "var(--muted-foreground)",
          flexShrink: 0,
          transition: "color 0.15s",
        }}
      />
    </button>
  );
}

// ─── Submission Card ──────────────────────────────────────────────────────────

function SubmissionCard({ submission, onOpen }: { submission: Submission; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left"
      style={{
        background: "oklch(1 0 0 / 3%)",
        border: "1px solid oklch(1 0 0 / 8%)",
        borderRadius: 12,
        padding: "13px 15px",
        transition: "all 0.15s ease",
        cursor: "pointer",
        outline: "none",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "oklch(0.85 0.18 95 / 8%)";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "oklch(0.85 0.18 95 / 40%)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "oklch(1 0 0 / 3%)";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "oklch(1 0 0 / 8%)";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        {/* Match badge */}
        <div
          style={{
            background: "oklch(0.85 0.18 95)",
            borderRadius: 8,
            padding: "5px 11px",
            display: "flex",
            alignItems: "center",
            gap: 5,
            boxShadow: "0 2px 8px oklch(0.85 0.18 95 / 30%)",
          }}
        >
          <Hash size={12} color="oklch(0.1 0 0)" />
          <span style={{ color: "oklch(0.1 0 0)", fontWeight: 800, fontSize: 13 }}>
            Match {submission.matchNumber ?? "—"}
          </span>
        </div>

        {/* Team badge */}
        <div
          style={{
            background: "oklch(1 0 0 / 7%)",
            border: "1px solid oklch(1 0 0 / 10%)",
            borderRadius: 8,
            padding: "5px 11px",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <ClipboardList size={12} style={{ color: "var(--muted-foreground)" }} />
          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--foreground)" }}>
            Team {submission.teamNumber ?? "—"}
          </span>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, color: "var(--muted-foreground)", fontSize: 11 }}>
          <Eye size={12} />
          <span>View</span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color: "var(--muted-foreground)",
        }}
      >
        <CalendarDays size={11} />
        <span>{formatTimestamp(submission.syncedAt)}</span>
      </div>
    </button>
  );
}

// ─── Submission Detail Modal ──────────────────────────────────────────────────

function SubmissionDetailModal({
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
        <ScrollArea style={{ flex: 1 }}>
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
        </ScrollArea>

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

function AdminLockScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-muted-foreground select-none">
      <div className="flex flex-col items-center gap-4 p-10 rounded-2xl border border-border bg-card max-w-sm w-full text-center shadow-sm">
        <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
          <ShieldAlert className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-bold tracking-tight text-foreground">Admin Access Required</h2>
          <p className="text-sm text-muted-foreground">
            Manage Scouts is restricted to admins. Enable admin mode in Settings to continue.
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

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub: string;
  accent?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      style={{
        background: accent ? "oklch(0.85 0.18 95 / 10%)" : "oklch(1 0 0 / 3%)",
        border: accent ? "1px solid oklch(0.85 0.18 95 / 35%)" : "1px solid oklch(1 0 0 / 8%)",
        borderRadius: 14,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column" as const,
        gap: 6,
        minWidth: 0,
        flex: 1,
        textAlign: "left" as const,
        cursor: onClick ? "pointer" : "default",
        font: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Icon
          size={14}
          style={{ color: accent ? "oklch(0.85 0.18 95)" : "var(--muted-foreground)", flexShrink: 0 }}
        />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase" as const,
            letterSpacing: "0.08em",
            color: accent ? "oklch(0.85 0.18 95)" : "var(--muted-foreground)",
          }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 800,
          color: "var(--foreground)",
          lineHeight: 1,
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{sub}</div>
    </Tag>
  );
}

// ─── Report Ranking Modal ───────────────────────────────────────────────────────

function ReportRankingModal({
  ranking,
  onClose,
}: {
  ranking: { user: User; count: number }[];
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "oklch(0 0 0 / 70%)", backdropFilter: "blur(4px)", padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, 100%)", maxHeight: "80vh",
          borderRadius: 16, background: "var(--card, #111)",
          border: "1px solid oklch(0.85 0.18 95 / 30%)",
          overflow: "hidden", display: "flex", flexDirection: "column",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "14px 18px", borderBottom: "1px solid oklch(1 0 0 / 8%)",
          background: "oklch(0.85 0.18 95 / 8%)",
        }}>
          <Trophy size={16} style={{ color: "oklch(0.75 0.18 95)" }} />
          <span style={{ fontWeight: 800, fontSize: 14, color: "oklch(0.75 0.18 95)" }}>Report Ranking</span>
          <button
            onClick={onClose}
            style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--muted-foreground)", display: "flex" }}
          >
            <X size={16} />
          </button>
        </div>
        <ScrollArea style={{ flex: 1 }}>
          <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
            {ranking.length === 0 && (
              <div style={{ padding: "24px 12px", textAlign: "center", fontSize: 13, color: "var(--muted-foreground)" }}>No reports yet.</div>
            )}
            {ranking.map(({ user, count }, i) => (
              <div key={user._id} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 10px", borderRadius: 10,
                background: i === 0 && count > 0 ? "oklch(0.85 0.18 95 / 10%)" : "transparent",
              }}>
                <span style={{ width: 20, textAlign: "center", fontSize: 12, fontWeight: 800, color: "var(--muted-foreground)" }}>{i + 1}</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: count > 0 ? "var(--foreground)" : "var(--muted-foreground)" }}>{displayName(user)}</span>
                <span style={{
                  fontSize: 12, fontWeight: 800, padding: "2px 9px", borderRadius: 20,
                  background: count > 0 ? "oklch(0.85 0.18 95 / 15%)" : "oklch(1 0 0 / 4%)",
                  color: count > 0 ? "oklch(0.75 0.18 95)" : "var(--muted-foreground)",
                }}>{count}</span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ManageScoutsPage() {
  const { isAdminMode } = useUIStore();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [openSubmission, setOpenSubmission] = useState<Submission | null>(null);
  const [showRanking, setShowRanking] = useState(false);
  const [editingLabelFor, setEditingLabelFor] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const [showDeactivated, setShowDeactivated] = useState(false);

  const currentEvent = useCached(useQuery(api.events.getCurrentEvent), "current_event");
  const eventKey = currentEvent?.eventKey ?? "";
  const allUsers = useQuery(api.users.listUsers) as User[] | undefined;
  const submissions = useQuery(
    api.forms.listSubmissions,
    currentEvent ? { eventKey } : "skip"
  ) as Submission[] | undefined;
  const allPreferences = useQuery(
    api.schedules.listAllPreferences,
    currentEvent ? { eventKey } : "skip"
  ) as ScoutPreference[] | undefined;
  const allAssignments = useQuery(
    api.schedules.listMatchAssignments,
    currentEvent ? { eventKey } : "skip"
  ) as MatchAssignment[] | undefined;
  const allPitRotations = useQuery(
    api.schedules.listPitRotations,
    currentEvent ? { eventKey } : "skip"
  ) as PitRotation[] | undefined;
  const allTemplates = useQuery(api.forms.listTemplates) as FormTemplate[] | undefined;
  const dbExcludedScoutIds = useQuery(
    api.schedules.getScheduleExclusions,
    currentEvent ? { eventKey } : "skip"
  ) as string[] | undefined;

  // Admin status — only inherent admins (czhao, yabdulkadir) see per-user
  // admin state and the grant/revoke controls; everyone else gets [] back.
  const isInherentAdmin = useQuery(api.admin.isCurrentUserInherentAdmin);
  const adminStatuses = useQuery(api.admin.listAdminStatuses) as
    | { userId: string; isInherentAdmin: boolean; tempAdminExpiresAt: number | null; label: string | null }[]
    | undefined;
  const adminStatusByUser: Record<string, { isInherentAdmin: boolean; tempAdminExpiresAt: number | null; label: string | null }> = {};
  for (const s of adminStatuses ?? []) adminStatusByUser[s.userId] = s;

  const driveTeamIds = useQuery(api.admin.listDriveTeamIds) as string[] | undefined;
  const driveTeamSet = new Set(driveTeamIds ?? []);

  // Mutations
  const clearMatchAssignment = useAdminMutation(api.schedules.clearMatchAssignment);
  const upsertPitRotation    = useAdminMutation(api.schedules.upsertPitRotation);
  const setScheduleExclusions = useAdminMutation(api.schedules.setScheduleExclusions);
  const deleteSubmissions    = useAdminMutation(api.forms.deleteSubmissions);
  const adminSetPreferences = useAdminMutation(api.schedules.adminSetPreferences);
  const grantTemporaryAdmin  = useMutation(api.admin.grantTemporaryAdmin);
  const revokeTemporaryAdmin = useMutation(api.admin.revokeTemporaryAdmin);
  const setDriveTeamMember  = useAdminMutation(api.admin.setDriveTeamMember);
  const setAdminLabel       = useAdminMutation(api.admin.setAdminLabel);
  const setUserName         = useAdminMutation(api.users.setUserName);
  const deactivateUser      = useAdminMutation(api.admin.deactivateUser);
  const reactivateUser      = useAdminMutation(api.admin.reactivateUser);
  const deactivatedUsers = useQuery(api.admin.listDeactivatedUsers) as
    | { userId: string; deactivatedAt: number; user: User | null }[]
    | undefined;

  // Saving state
  const [clearingSlot, setClearingSlot]   = useState<string | null>(null);
  const [togglingRot,  setTogglingRot]    = useState<string | null>(null);
  const [togglingExclude, setTogglingExclude] = useState(false);
  const [togglingAdmin, setTogglingAdmin] = useState(false);
  const [grantHoursDraft, setGrantHoursDraft] = useState("12");
  const [togglingDriveTeam, setTogglingDriveTeam] = useState(false);
  const [deletingScoutReports, setDeletingScoutReports] = useState(false);
  const [deletingAllReports, setDeletingAllReports] = useState(false);
  const [editingPrefs, setEditingPrefs] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsDraft, setPrefsDraft] = useState<{
    preferredPartners: string[];
    wantsMoreMatches: boolean;
    wantsPitRotation: boolean;
    wantsPitScouting: boolean;
  } | null>(null);

  // Derived: excluded scout set
  const excludedSet = new Set(dbExcludedScoutIds ?? []);

  // ── Derived data ─────────────────────────────────────────────────────────────

  const submissionsByScout = (submissions ?? []).reduce<Record<string, Submission[]>>(
    (acc, sub) => {
      const key = sub.scoutId ?? "__unknown";
      if (!acc[key]) acc[key] = [];
      acc[key].push(sub);
      return acc;
    },
    {}
  );

  const scoutsWithSubs: User[] = [];
  const scoutsWithoutSubs: User[] = [];

  (allUsers ?? []).forEach((user) => {
    const count = (submissionsByScout[user._id] ?? []).length;
    if (count > 0) scoutsWithSubs.push(user);
    else scoutsWithoutSubs.push(user);
  });

  scoutsWithSubs.sort(
    (a, b) => (submissionsByScout[b._id]?.length ?? 0) - (submissionsByScout[a._id]?.length ?? 0)
  );

  const selectedUser = (allUsers ?? []).find((u) => u._id === selectedUserId) ?? null;
  const selectedSubmissions = selectedUserId
    ? (submissionsByScout[selectedUserId] ?? []).sort(
        (a, b) => (a.matchNumber ?? 0) - (b.matchNumber ?? 0)
      )
    : [];

  const topScout = scoutsWithSubs[0] ?? null;
  const topCount = topScout ? (submissionsByScout[topScout._id]?.length ?? 0) : 0;
  const reportRanking = [...(allUsers ?? [])]
    .map(user => ({ user, count: submissionsByScout[user._id]?.length ?? 0 }))
    .sort((a, b) => b.count - a.count);

  // Preferences map by scoutId
  const prefsById: Record<string, ScoutPreference> = {};
  for (const p of (allPreferences ?? [])) prefsById[p.scoutId] = p;
  const selectedPrefs = selectedUserId ? prefsById[selectedUserId] ?? null : null;

  // Exit preference-edit / name-edit / label-edit mode whenever the selected scout changes
  useEffect(() => {
    setEditingPrefs(false);
    setPrefsDraft(null);
    setEditingName(false);
    setEditingLabelFor(null);
  }, [selectedUserId]);

  function startEditingPrefs() {
    setPrefsDraft({
      preferredPartners: selectedPrefs?.preferredPartners ?? [],
      wantsMoreMatches: selectedPrefs?.wantsMoreMatches ?? false,
      wantsPitRotation: selectedPrefs?.wantsPitRotation ?? false,
      wantsPitScouting: selectedPrefs?.wantsPitScouting ?? false,
    });
    setEditingPrefs(true);
  }

  function toggleDraftPartner(id: string) {
    setPrefsDraft(d => d && {
      ...d,
      preferredPartners: d.preferredPartners.includes(id)
        ? d.preferredPartners.filter(p => p !== id)
        : [...d.preferredPartners, id],
    });
  }

  async function handleSavePrefs() {
    if (!selectedUserId || !prefsDraft || !eventKey) return;
    setSavingPrefs(true);
    try {
      await adminSetPreferences({
        scoutId: selectedUserId as any,
        eventKey,
        preferredPartners: prefsDraft.preferredPartners as any,
        wantsMoreMatches: prefsDraft.wantsMoreMatches,
        wantsPitRotation: prefsDraft.wantsPitRotation,
        wantsPitScouting: prefsDraft.wantsPitScouting,
      });
      toast.success("Preferences updated");
      setEditingPrefs(false);
      setPrefsDraft(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update preferences");
    } finally {
      setSavingPrefs(false);
    }
  }

  // Assignments & pit rotations for selected scout
  const scoutAssignments: MatchAssignment[] = selectedUserId
    ? (allAssignments ?? []).filter(a => a.scoutId === selectedUserId).sort((a, b) => a.matchNumber - b.matchNumber)
    : [];
  const scoutPitRotations: PitRotation[] = selectedUserId
    ? (allPitRotations ?? []).filter(r => r.scoutIds.includes(selectedUserId))
    : [];

  // Handlers
  async function handleClearAssignment(a: MatchAssignment) {
    const key = `${a.matchNumber}-${a.position}`;
    setClearingSlot(key);
    try {
      await clearMatchAssignment({ eventKey, matchNumber: a.matchNumber, position: a.position });
    } finally {
      setClearingSlot(null);
    }
  }

  async function handleTogglePitRotation(rot: PitRotation, add: boolean) {
    if (!selectedUserId) return;
    setTogglingRot(rot._id);
    try {
      const nextIds = add
        ? [...rot.scoutIds, selectedUserId]
        : rot.scoutIds.filter(id => id !== selectedUserId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await upsertPitRotation({ id: rot._id as any, eventKey, label: rot.label, startMatch: rot.startMatch, endMatch: rot.endMatch, isElims: rot.isElims, scoutIds: nextIds as any[] });
    } finally {
      setTogglingRot(null);
    }
  }

  const handleToggleExclude = useCallback(async (scoutId: string) => {
    if (!currentEvent?.eventKey) return;
    setTogglingExclude(true);
    try {
      const current = dbExcludedScoutIds ?? [];
      const isExcluded = current.includes(scoutId);
      const next = isExcluded
        ? current.filter(id => id !== scoutId)
        : [...current, scoutId];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await setScheduleExclusions({ eventKey: currentEvent.eventKey, excludedScoutIds: next as any[] });
    } finally {
      setTogglingExclude(false);
    }
  }, [currentEvent?.eventKey, dbExcludedScoutIds, setScheduleExclusions]);

  async function handleGrantAdmin(userId: string, hours: number) {
    setTogglingAdmin(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { expiresAt } = await grantTemporaryAdmin({ userId: userId as any, hours });
      toast.success(`Admin access granted for ${hours} hour${hours === 1 ? "" : "s"}.`, {
        description: `Expires ${new Date(expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}.`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't grant admin access.");
    } finally {
      setTogglingAdmin(false);
    }
  }

  async function handleRevokeAdmin(userId: string) {
    setTogglingAdmin(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await revokeTemporaryAdmin({ userId: userId as any });
      toast.success("Admin access revoked.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't revoke admin access.");
    } finally {
      setTogglingAdmin(false);
    }
  }

  async function handleSaveName(userId: string) {
    const trimmed = nameDraft.trim();
    if (!trimmed) { toast.error("Name can't be empty."); return; }
    setSavingName(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await setUserName({ userId: userId as any, name: trimmed });
      setEditingName(false);
      toast.success("Name updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update name.");
    } finally {
      setSavingName(false);
    }
  }

  async function handleDeactivateUser(userId: string, name: string) {
    if (!window.confirm(`Deactivate ${name}? They'll be hidden from Manage Scouts and excluded from schedule generation until they sign in again.`)) return;
    setDeactivating(userId);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deactivateUser({ userId: userId as any });
      toast.success(`${name} deactivated.`);
      setSelectedUserId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't deactivate user.");
    } finally {
      setDeactivating(null);
    }
  }

  async function handleReactivateUser(userId: string, name: string) {
    setDeactivating(userId);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await reactivateUser({ userId: userId as any });
      toast.success(`${name} restored.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't restore user.");
    } finally {
      setDeactivating(null);
    }
  }

  async function handleToggleDriveTeam(userId: string, isDriveTeam: boolean) {
    setTogglingDriveTeam(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await setDriveTeamMember({ userId: userId as any, isDriveTeam });
      toast.success(isDriveTeam ? "Tagged as drive team." : "Removed drive team tag.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update drive team tag.");
    } finally {
      setTogglingDriveTeam(false);
    }
  }

  async function handleDeleteScoutReports() {
    if (!currentEvent?.eventKey || !selectedUserId) return;
    const count = selectedSubmissions.length;
    if (count === 0) return;
    const name = selectedUser ? displayName(selectedUser) : "this scout";
    if (!window.confirm(`Delete all ${count} report${count !== 1 ? "s" : ""} from ${name}? This cannot be undone.`)) return;
    setDeletingScoutReports(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deleteSubmissions({ eventKey: currentEvent.eventKey, scoutId: selectedUserId as any });
    } finally {
      setDeletingScoutReports(false);
    }
  }

  async function handleDeleteAllReports() {
    if (!currentEvent?.eventKey) return;
    const count = submissions?.length ?? 0;
    if (count === 0) return;
    if (!window.confirm(`Delete ALL ${count} reports for ${currentEvent.eventName ?? currentEvent.eventKey}? This cannot be undone and affects every scout.`)) return;
    setDeletingAllReports(true);
    try {
      await deleteSubmissions({ eventKey: currentEvent.eventKey });
      setSelectedUserId(null);
    } finally {
      setDeletingAllReports(false);
    }
  }

  // ── Guard ─────────────────────────────────────────────────────────────────────

  if (!isAdminMode) return <AdminLockScreen />;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", gap: 20 }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4, justifyContent: "space-between" }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "oklch(0.85 0.18 95)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 4px 16px oklch(0.85 0.18 95 / 45%)",
              flexShrink: 0,
            }}
          >
            <Users size={19} color="oklch(0.1 0 0)" />
          </div>
          <div>
            <h1
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "var(--foreground)",
                margin: 0,
                lineHeight: 1.2,
                letterSpacing: "-0.02em",
              }}
            >
              Manage Scouts
            </h1>
            <p style={{ fontSize: 13, color: "var(--muted-foreground)", margin: 0 }}>
              {currentEvent
                ? `${currentEvent.eventName ?? currentEvent.eventKey} · ${submissions?.length ?? 0} total reports`
                : "Set an event in Settings to view scout activity"}
            </p>
          </div>
        </div>

        {currentEvent && (submissions?.length ?? 0) > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDeleteAllReports}
              disabled={deletingAllReports}
              style={{
                color: "oklch(0.72 0.18 30)",
                fontSize: 12,
                gap: 6,
              }}
            >
              <AlertTriangle size={13} />
              {deletingAllReports ? "Deleting…" : `Delete all ${submissions?.length ?? 0} reports`}
            </Button>
          </div>
        )}
      </div>

      {/* ── No event state ────────────────────────────────────────────────── */}
      {!currentEvent && (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "oklch(1 0 0 / 5%)",
              border: "1.5px solid oklch(1 0 0 / 10%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CalendarDays size={28} style={{ color: "var(--muted-foreground)" }} />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)", marginBottom: 6 }}>
              No Event Selected
            </div>
            <div style={{ fontSize: 13, color: "var(--muted-foreground)", maxWidth: 300 }}>
              Select a current event in Settings to view scout activity.
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      {currentEvent && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>

          {/* Stat row */}
          <div style={{ display: "flex", gap: 12, flexShrink: 0 }}>
            <StatCard
              icon={UserCheck}
              label="Active"
              value={scoutsWithSubs.length}
              sub="scouts with reports"
              accent
            />
            <StatCard
              icon={UserX}
              label="Inactive"
              value={scoutsWithoutSubs.length}
              sub="no reports this event"
            />
            <StatCard
              icon={Trophy}
              label="Top Scout"
              value={topScout ? displayName(topScout).split(" ")[0] : "—"}
              sub={topScout ? `${topCount} report${topCount !== 1 ? "s" : ""}` : "no reports yet"}
              onClick={() => setShowRanking(true)}
            />
          </div>

          {/* Two-panel layout — on mobile the detail panel covers the full screen */}
          <div style={{ flex: 1, display: "flex", gap: 14, minHeight: 0, position: "relative" }}>

            {/* Left: Scout list — hidden on mobile when a scout is selected */}
            <div
              className={selectedUser ? "hidden md:flex" : "flex"}
              style={{
                width: selectedUser ? 290 : "100%",
                maxWidth: selectedUser ? 290 : "none",
                flexShrink: 0,
                flexDirection: "column",
                minHeight: 0,
                background: "oklch(1 0 0 / 3%)",
                border: "1px solid oklch(1 0 0 / 8%)",
                borderRadius: 16,
                overflow: "hidden",
                transition: "width 0.2s ease, max-width 0.2s ease",
              }}
            >
              {/* List header */}
              <div
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid oklch(1 0 0 / 8%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexShrink: 0,
                  background: "oklch(0.85 0.18 95 / 5%)",
                }}
              >
                <UserCheck size={14} style={{ color: "oklch(0.85 0.18 95)" }} />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "oklch(0.85 0.18 95)",
                  }}
                >
                  All Scouts
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    background: "oklch(0.85 0.18 95 / 20%)",
                    color: "oklch(0.85 0.18 95)",
                    borderRadius: 20,
                    padding: "1px 8px",
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {(allUsers ?? []).length}
                </span>
              </div>

              <ScrollArea style={{ flex: 1 }}>
                <div style={{ padding: "10px 10px 16px" }}>

                  {/* Active scouts */}
                  {scoutsWithSubs.length > 0 && (
                    <>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "6px 4px 4px",
                          marginBottom: 2,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "oklch(0.85 0.18 95 / 80%)",
                          }}
                        >
                          Active
                        </span>
                        <div
                          style={{
                            flex: 1,
                            height: 1,
                            background: "oklch(0.85 0.18 95 / 20%)",
                            borderRadius: 999,
                          }}
                        />
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: "oklch(0.85 0.18 95 / 80%)",
                          }}
                        >
                          {scoutsWithSubs.length}
                        </span>
                      </div>
                      {scoutsWithSubs.map((user, idx) => (
                        <ScoutRow
                          key={user._id}
                          user={user}
                          count={submissionsByScout[user._id]?.length ?? 0}
                          selected={selectedUserId === user._id}
                          onClick={() =>
                            setSelectedUserId(selectedUserId === user._id ? null : user._id)
                          }
                          hasSubmissions={true}
                          rank={idx + 1}
                          hasPrefs={!!prefsById[user._id]}
                          isExcluded={excludedSet.has(user._id)}
                        />
                      ))}
                    </>
                  )}

                  {/* Separator */}
                  {scoutsWithSubs.length > 0 && scoutsWithoutSubs.length > 0 && (
                    <Separator style={{ margin: "10px 4px" }} />
                  )}

                  {/* Inactive scouts */}
                  {scoutsWithoutSubs.length > 0 && (
                    <>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "6px 4px 4px",
                          marginBottom: 2,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--muted-foreground)",
                          }}
                        >
                          No submissions
                        </span>
                        <div
                          style={{
                            flex: 1,
                            height: 1,
                            background: "oklch(1 0 0 / 8%)",
                            borderRadius: 999,
                          }}
                        />
                        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted-foreground)" }}>
                          {scoutsWithoutSubs.length}
                        </span>
                      </div>
                      {scoutsWithoutSubs.map((user) => (
                        <ScoutRow
                          key={user._id}
                          user={user}
                          count={0}
                          selected={selectedUserId === user._id}
                          onClick={() =>
                            setSelectedUserId(selectedUserId === user._id ? null : user._id)
                          }
                          hasSubmissions={false}
                          hasPrefs={!!prefsById[user._id]}
                          isExcluded={excludedSet.has(user._id)}
                        />
                      ))}
                    </>
                  )}

                  {/* Deactivated (soft-deleted) users — restorable */}
                  {(deactivatedUsers ?? []).length > 0 && (
                    <>
                      <Separator style={{ margin: "10px 4px" }} />
                      <button
                        onClick={() => setShowDeactivated(s => !s)}
                        style={{
                          display: "flex", alignItems: "center", gap: 6, width: "100%",
                          padding: "6px 4px 4px", marginBottom: 2, border: "none", background: "transparent", cursor: "pointer",
                        }}
                      >
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted-foreground)" }}>
                          Deactivated
                        </span>
                        <div style={{ flex: 1, height: 1, background: "oklch(1 0 0 / 8%)", borderRadius: 999 }} />
                        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted-foreground)" }}>{deactivatedUsers!.length}</span>
                        <ChevronRight size={12} style={{ color: "var(--muted-foreground)", transform: showDeactivated ? "rotate(90deg)" : "none" }} />
                      </button>
                      {showDeactivated && deactivatedUsers!.map(({ userId, user }) => (
                        <div key={userId} style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "6px 8px", borderRadius: 9, opacity: 0.7,
                        }}>
                          <Avatar user={user ?? { _id: userId }} size={24} />
                          <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "var(--muted-foreground)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {user ? displayName(user) : "Unknown"}
                          </div>
                          <button
                            onClick={() => handleReactivateUser(userId, user ? displayName(user) : "Scout")}
                            disabled={deactivating === userId}
                            style={{
                              border: "none", background: "transparent", cursor: "pointer",
                              padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                              color: "oklch(0.6 0.18 180)",
                            }}
                          >
                            Restore
                          </button>
                        </div>
                      ))}
                    </>
                  )}

                  {/* No users at all */}
                  {(allUsers ?? []).length === 0 && (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 12,
                        padding: "48px 16px",
                        textAlign: "center",
                      }}
                    >
                      <Users size={32} style={{ color: "var(--muted-foreground)", opacity: 0.4 }} />
                      <div>
                        <div style={{ fontWeight: 600, color: "var(--foreground)", marginBottom: 4 }}>
                          No scouts yet
                        </div>
                        <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
                          Scouts will appear here once they sign in.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Right: Detail panel — full-screen overlay on mobile, side panel on desktop */}
            {selectedUser ? (
              <div
                className="fixed inset-0 z-40 md:static md:z-auto md:flex md:flex-col md:flex-1 md:min-w-0 md:min-h-0 md:rounded-2xl md:overflow-hidden"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  background: "var(--background)",
                  overflow: "hidden",
                  border: "1px solid oklch(0.85 0.18 95 / 25%)",
                }}
              >
                {/* Panel header */}
                <div
                  style={{
                    padding: "14px 18px",
                    borderBottom: "1px solid oklch(0.85 0.18 95 / 20%)",
                    display: "flex",
                    alignItems: "center",
                    gap: 13,
                    flexShrink: 0,
                    background: "oklch(0.85 0.18 95 / 6%)",
                  }}
                >
                  {/* Mobile-only back button */}
                  <button
                    className="md:hidden"
                    onClick={() => setSelectedUserId(null)}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      background: "transparent", border: "none", cursor: "pointer",
                      color: "var(--muted-foreground)", fontSize: 13, fontWeight: 600,
                      padding: "4px 6px 4px 0", flexShrink: 0,
                    }}
                    aria-label="Back to scout list"
                  >
                    <ChevronRight size={16} style={{ transform: "rotate(180deg)" }} />
                    <span>Back</span>
                  </button>

                  <Avatar user={selectedUser} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingName ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <input
                          autoFocus
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(selectedUser._id); if (e.key === "Escape") setEditingName(false); }}
                          style={{
                            flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, padding: "3px 7px", borderRadius: 6,
                            border: "1px solid oklch(0.85 0.18 95 / 40%)",
                            background: "oklch(1 0 0 / 5%)", color: "var(--foreground)",
                          }}
                        />
                        <button onClick={() => handleSaveName(selectedUser._id)} disabled={savingName} style={{ border: "none", background: "transparent", cursor: "pointer", color: "oklch(0.75 0.18 95)", display: "flex", flexShrink: 0 }} title="Save">
                          <Save size={14} />
                        </button>
                        <button onClick={() => setEditingName(false)} disabled={savingName} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--muted-foreground)", display: "flex", flexShrink: 0 }} title="Cancel">
                          <XCircle size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingName(true); setNameDraft(displayName(selectedUser)); }}
                        style={{
                          display: "flex", alignItems: "center", gap: 6, maxWidth: "100%",
                          border: "none", background: "transparent", cursor: "pointer", padding: 0,
                          font: "inherit", textAlign: "left",
                        }}
                        title="Edit name"
                      >
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: 15,
                            color: "var(--foreground)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {displayName(selectedUser)}
                        </div>
                        <Pencil size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
                      </button>
                    )}
                    {selectedUser.email && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--muted-foreground)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {selectedUser.email}
                      </div>
                    )}
                  </div>

                  {/* Submission count pill — hidden while editing the name so the
                      Save/Cancel buttons always have room on narrow screens */}
                  {!editingName && (
                    <div
                      className="hidden sm:block"
                      style={{
                        background: "oklch(0.85 0.18 95)",
                        borderRadius: 20,
                        padding: "4px 12px",
                        fontSize: 12,
                        fontWeight: 800,
                        color: "oklch(0.1 0 0)",
                        boxShadow: "0 2px 10px oklch(0.85 0.18 95 / 40%)",
                        flexShrink: 0,
                      }}
                    >
                      {selectedSubmissions.length} report{selectedSubmissions.length !== 1 ? "s" : ""}
                    </div>
                  )}

                  {/* Desktop-only X close */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSelectedUserId(null)}
                    className="hidden md:inline-flex"
                    style={{ flexShrink: 0 }}
                  >
                    <X size={17} />
                  </Button>
                </div>

                {/* Mini stats strip */}
                <div
                  style={{
                    display: "flex",
                    gap: 0,
                    borderBottom: "1px solid oklch(1 0 0 / 8%)",
                    flexShrink: 0,
                  }}
                >
                  {[
                    {
                      label: "Reports",
                      value: selectedSubmissions.length,
                    },
                    {
                      label: "Teams",
                      value: new Set(selectedSubmissions.map((s) => s.teamNumber)).size,
                    },
                    {
                      label: "Last Match",
                      value: selectedSubmissions.length > 0
                        ? selectedSubmissions[selectedSubmissions.length - 1].matchNumber ?? "—"
                        : "—",
                    },
                  ].map((stat, i) => (
                    <div
                      key={stat.label}
                      style={{
                        flex: 1,
                        padding: "12px 16px",
                        textAlign: "center",
                        borderRight: i < 2 ? "1px solid oklch(1 0 0 / 8%)" : "none",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 20,
                          fontWeight: 800,
                          color: i === 0 ? "oklch(0.85 0.18 95)" : "var(--foreground)",
                          lineHeight: 1,
                          letterSpacing: "-0.02em",
                        }}
                      >
                        {stat.value}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--muted-foreground)", marginTop: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {stat.label}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Submissions list */}
                <ScrollArea style={{ flex: 1 }}>
                  <div style={{ padding: "14px 18px 20px", display: "flex", flexDirection: "column", gap: 8 }}>

                    {/* ── Exclude from Schedule toggle ── */}
                    <div style={{
                      borderRadius: 13,
                      background: excludedSet.has(selectedUser._id)
                        ? "oklch(0.55 0.18 30 / 10%)"
                        : "oklch(1 0 0 / 3%)",
                      border: excludedSet.has(selectedUser._id)
                        ? "1px solid oklch(0.55 0.18 30 / 35%)"
                        : "1px solid oklch(1 0 0 / 8%)",
                      overflow: "hidden",
                      marginBottom: 4,
                      transition: "all 0.2s",
                    }}>
                      <div style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "12px 14px",
                      }}>
                        <div style={{
                          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                          background: excludedSet.has(selectedUser._id)
                            ? "oklch(0.55 0.18 30 / 20%)"
                            : "oklch(1 0 0 / 6%)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          transition: "background 0.2s",
                        }}>
                          <Ban size={15} style={{
                            color: excludedSet.has(selectedUser._id)
                              ? "oklch(0.72 0.18 30)"
                              : "var(--muted-foreground)",
                            transition: "color 0.2s",
                          }} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: 13, fontWeight: 700,
                            color: excludedSet.has(selectedUser._id)
                              ? "oklch(0.75 0.18 30)"
                              : "var(--foreground)",
                          }}>
                            Exclude from Schedule
                          </div>
                          <div style={{ fontSize: 11, color: "var(--muted-foreground)", lineHeight: 1.4, marginTop: 1 }}>
                            {excludedSet.has(selectedUser._id)
                              ? "This scout is excluded from auto-generated schedules."
                              : "Toggle to skip this scout during schedule generation."}
                          </div>
                        </div>
                        {/* Toggle switch */}
                        <button
                          onClick={() => handleToggleExclude(selectedUser._id)}
                          disabled={togglingExclude}
                          style={{
                            width: 44, height: 24, borderRadius: 12, flexShrink: 0,
                            background: excludedSet.has(selectedUser._id)
                              ? "oklch(0.55 0.18 30)"
                              : "oklch(1 0 0 / 12%)",
                            border: excludedSet.has(selectedUser._id)
                              ? "1.5px solid oklch(0.55 0.18 30 / 60%)"
                              : "1.5px solid oklch(1 0 0 / 15%)",
                            cursor: togglingExclude ? "wait" : "pointer",
                            position: "relative",
                            transition: "all 0.2s",
                            padding: 0,
                            opacity: togglingExclude ? 0.5 : 1,
                          }}
                          title={excludedSet.has(selectedUser._id) ? "Include in schedule" : "Exclude from schedule"}
                        >
                          <div style={{
                            width: 18, height: 18, borderRadius: "50%",
                            background: excludedSet.has(selectedUser._id)
                              ? "white"
                              : "oklch(1 0 0 / 35%)",
                            position: "absolute",
                            top: 1.5, 
                            left: excludedSet.has(selectedUser._id) ? 22 : 2,
                            transition: "left 0.2s, background 0.2s",
                            boxShadow: "0 1px 3px oklch(0 0 0 / 20%)",
                          }} />
                        </button>
                      </div>
                    </div>

                    {/* ── Admin Access ── (inherent admins only — czhao, yabdulkadir) */}
                    {isInherentAdmin && (() => {
                      const status = adminStatusByUser[selectedUser._id];
                      const isEditingLabel = editingLabelFor === selectedUser._id;

                      async function saveLabel() {
                        setSavingLabel(true);
                        try {
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          await setAdminLabel({ userId: selectedUser!._id as any, label: labelDraft });
                          setEditingLabelFor(null);
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Couldn't update label.");
                        } finally {
                          setSavingLabel(false);
                        }
                      }

                      function LabelEditor({ fallback }: { fallback: string }) {
                        if (isEditingLabel) {
                          return (
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                              <input
                                autoFocus
                                value={labelDraft}
                                onChange={(e) => setLabelDraft(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") saveLabel(); if (e.key === "Escape") setEditingLabelFor(null); }}
                                placeholder={fallback}
                                style={{
                                  flex: 1, fontSize: 12, padding: "3px 7px", borderRadius: 6,
                                  border: "1px solid oklch(0.85 0.18 95 / 40%)",
                                  background: "oklch(1 0 0 / 5%)", color: "var(--foreground)",
                                }}
                              />
                              <button onClick={saveLabel} disabled={savingLabel} style={{ border: "none", background: "transparent", cursor: "pointer", color: "oklch(0.75 0.18 95)", display: "flex" }} title="Save">
                                <Save size={13} />
                              </button>
                              <button onClick={() => setEditingLabelFor(null)} disabled={savingLabel} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--muted-foreground)", display: "flex" }} title="Cancel">
                                <XCircle size={13} />
                              </button>
                            </div>
                          );
                        }
                        return (
                          <button
                            onClick={() => { setEditingLabelFor(selectedUser!._id); setLabelDraft(status?.label ?? fallback); }}
                            style={{
                              display: "flex", alignItems: "center", gap: 5, marginTop: 1,
                              border: "none", background: "transparent", cursor: "pointer", padding: 0,
                              color: "inherit", font: "inherit", textAlign: "left",
                            }}
                            title="Edit label"
                          >
                            <span>{status?.label ?? fallback}</span>
                            <Pencil size={10} style={{ opacity: 0.6, flexShrink: 0 }} />
                          </button>
                        );
                      }

                      if (status?.isInherentAdmin) {
                        return (
                          <div style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "12px 14px", borderRadius: 13,
                            background: "oklch(0.85 0.18 95 / 8%)",
                            border: "1px solid oklch(0.85 0.18 95 / 30%)",
                            marginBottom: 4,
                          }}>
                            <ShieldCheck size={16} style={{ color: "oklch(0.75 0.18 95)", flexShrink: 0 }} />
                            <div style={{ fontSize: 12.5, fontWeight: 700, color: "oklch(0.75 0.18 95)", flex: 1, minWidth: 0 }}>
                              <LabelEditor fallback="Permanent team lead — always has admin access" />
                            </div>
                          </div>
                        );
                      }
                      const hasTempAdmin = !!status?.tempAdminExpiresAt;
                      return (
                        <div style={{
                          borderRadius: 13,
                          background: hasTempAdmin ? "oklch(0.85 0.18 95 / 8%)" : "oklch(1 0 0 / 3%)",
                          border: hasTempAdmin
                            ? "1px solid oklch(0.85 0.18 95 / 30%)"
                            : "1px solid oklch(1 0 0 / 8%)",
                          overflow: "hidden",
                          marginBottom: 4,
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px" }}>
                            <div style={{
                              width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                              background: hasTempAdmin ? "oklch(0.85 0.18 95 / 20%)" : "oklch(1 0 0 / 6%)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>
                              <ShieldCheck size={15} style={{ color: hasTempAdmin ? "oklch(0.75 0.18 95)" : "var(--muted-foreground)" }} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontSize: 13, fontWeight: 700,
                                color: hasTempAdmin ? "oklch(0.75 0.18 95)" : "var(--foreground)",
                              }}>
                                {hasTempAdmin ? <LabelEditor fallback="Temporary Admin" /> : "Admin Access"}
                              </div>
                              {hasTempAdmin && (
                                <div style={{ fontSize: 11, color: "var(--muted-foreground)", lineHeight: 1.4, marginTop: 1, display: "flex", alignItems: "center", gap: 4 }}>
                                  <Clock size={11} />
                                  {formatRemaining(status!.tempAdminExpiresAt!)}
                                </div>
                              )}
                              {!hasTempAdmin && (
                                <div style={{ fontSize: 11, color: "var(--muted-foreground)", lineHeight: 1.4, marginTop: 1 }}>
                                  Grant admin access for a set number of hours.
                                </div>
                              )}
                            </div>
                            {hasTempAdmin ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={togglingAdmin}
                                onClick={() => handleRevokeAdmin(selectedUser._id)}
                              >
                                Revoke
                              </Button>
                            ) : (
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min={1}
                                  max={720}
                                  step={1}
                                  value={grantHoursDraft}
                                  onChange={(e) => setGrantHoursDraft(e.target.value)}
                                  disabled={togglingAdmin}
                                  aria-label="Hours of admin access to grant"
                                  style={{
                                    width: 52,
                                    fontSize: 13,
                                    padding: "6px 6px",
                                    borderRadius: 8,
                                    border: "1px solid oklch(1 0 0 / 15%)",
                                    background: "oklch(1 0 0 / 4%)",
                                    color: "var(--foreground)",
                                    textAlign: "center",
                                  }}
                                />
                                <span style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>hrs</span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={togglingAdmin || !Number.isFinite(Number(grantHoursDraft)) || Number(grantHoursDraft) < 1}
                                  onClick={() => {
                                    const parsed = Math.round(Number(grantHoursDraft));
                                    const hours = Math.min(720, Math.max(1, Number.isFinite(parsed) ? parsed : 12));
                                    handleGrantAdmin(selectedUser._id, hours);
                                  }}
                                >
                                  Grant Admin
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── Drive Team tag — excludes from match scouting, adds to every pit rotation ── */}
                    <div style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "12px 14px", borderRadius: 13,
                      background: driveTeamSet.has(selectedUser._id) ? "oklch(0.7 0.19 25 / 8%)" : "oklch(1 0 0 / 3%)",
                      border: driveTeamSet.has(selectedUser._id)
                        ? "1px solid oklch(0.7 0.19 25 / 30%)"
                        : "1px solid oklch(1 0 0 / 8%)",
                      marginBottom: 4,
                    }}>
                      <div style={{
                        width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                        background: driveTeamSet.has(selectedUser._id) ? "oklch(0.7 0.19 25 / 20%)" : "oklch(1 0 0 / 6%)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <WrenchIcon size={15} style={{ color: driveTeamSet.has(selectedUser._id) ? "oklch(0.7 0.19 25)" : "var(--muted-foreground)" }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: driveTeamSet.has(selectedUser._id) ? "oklch(0.7 0.19 25)" : "var(--foreground)" }}>
                          Drive Team
                        </div>
                        <div style={{ fontSize: 11, color: "var(--muted-foreground)", lineHeight: 1.4, marginTop: 1 }}>
                          Excludes from match scouting; auto-assigns to every qual pit rotation.
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={togglingDriveTeam}
                        onClick={() => handleToggleDriveTeam(selectedUser._id, !driveTeamSet.has(selectedUser._id))}
                      >
                        {driveTeamSet.has(selectedUser._id) ? "Remove Tag" : "Tag as Drive Team"}
                      </Button>
                    </div>

                    {/* Preferences section */}
                    {(selectedPrefs || eventKey) && (
                      <div style={{
                        borderRadius: 13,
                        background: "oklch(0.65 0.18 270 / 8%)",
                        border: "1px solid oklch(0.65 0.18 270 / 30%)",
                        overflow: "hidden",
                        marginBottom: 4,
                      }}>
                        <div style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "10px 13px",
                          borderBottom: "1px solid oklch(0.65 0.18 270 / 20%)",
                          background: "oklch(0.65 0.18 270 / 10%)",
                        }}>
                          <SlidersHorizontal size={13} style={{ color: "oklch(0.7 0.18 270)" }} />
                          <span style={{ fontWeight: 700, fontSize: 12, color: "oklch(0.75 0.18 270)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Scout Preferences</span>
                          {selectedPrefs && !editingPrefs && (
                            <span style={{ marginLeft: "auto", fontSize: 11, color: "oklch(0.5 0.1 270)" }}>
                              {new Date(selectedPrefs.updatedAt).toLocaleDateString()}
                            </span>
                          )}
                          {!editingPrefs ? (
                            <button
                              type="button"
                              onClick={startEditingPrefs}
                              title="Edit preferences"
                              style={{
                                marginLeft: selectedPrefs ? 8 : "auto", display: "flex", alignItems: "center", gap: 4,
                                padding: "3px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer",
                                background: "oklch(0.65 0.18 270 / 12%)", border: "1px solid oklch(0.65 0.18 270 / 30%)",
                                color: "oklch(0.75 0.18 270)",
                              }}
                            >
                              <Pencil size={11} /> Edit
                            </button>
                          ) : (
                            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                              <button
                                type="button"
                                onClick={() => { setEditingPrefs(false); setPrefsDraft(null); }}
                                disabled={savingPrefs}
                                title="Cancel"
                                style={{
                                  display: "flex", alignItems: "center", gap: 4,
                                  padding: "3px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer",
                                  background: "oklch(1 0 0 / 4%)", border: "1px solid oklch(1 0 0 / 10%)",
                                  color: "var(--muted-foreground)",
                                }}
                              >
                                <XCircle size={11} /> Cancel
                              </button>
                              <button
                                type="button"
                                onClick={handleSavePrefs}
                                disabled={savingPrefs}
                                title="Save preferences"
                                style={{
                                  display: "flex", alignItems: "center", gap: 4,
                                  padding: "3px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer",
                                  background: "oklch(0.65 0.18 270 / 20%)", border: "1px solid oklch(0.65 0.18 270 / 40%)",
                                  color: "oklch(0.8 0.18 270)", opacity: savingPrefs ? 0.6 : 1,
                                }}
                              >
                                <Save size={11} /> {savingPrefs ? "Saving…" : "Save"}
                              </button>
                            </div>
                          )}
                        </div>
                        <div style={{ padding: "10px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
                          {!editingPrefs ? (
                            <>
                              {!selectedPrefs && (
                                <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                                  This scout hasn't submitted preferences yet. Click Edit to set them.
                                </div>
                              )}
                              {selectedPrefs && selectedPrefs.preferredPartners.length > 0 && (
                                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                                  <UserPlus size={13} style={{ color: "oklch(0.7 0.18 270)", marginTop: 2, flexShrink: 0 }} />
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: "oklch(0.7 0.18 270)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>Preferred partners</div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                                      {selectedPrefs.preferredPartners.map(pid => {
                                        const partner = (allUsers ?? []).find(u => u._id === pid);
                                        return partner ? (
                                          <span key={pid} style={{
                                            padding: "3px 9px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                                            background: "oklch(0.65 0.18 270 / 15%)",
                                            border: "1px solid oklch(0.65 0.18 270 / 30%)",
                                            color: "var(--foreground)",
                                          }}>{partner.name ?? partner.email ?? "Scout"}</span>
                                        ) : null;
                                      })}
                                    </div>
                                  </div>
                                </div>
                              )}
                              {selectedPrefs && (
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                  <span style={{
                                    display: "flex", alignItems: "center", gap: 5,
                                    padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                                    background: selectedPrefs.wantsMoreMatches ? "oklch(0.65 0.18 270 / 15%)" : "oklch(1 0 0 / 4%)",
                                    border: `1px solid ${selectedPrefs.wantsMoreMatches ? "oklch(0.65 0.18 270 / 35%)" : "oklch(1 0 0 / 10%)"}`,
                                    color: selectedPrefs.wantsMoreMatches ? "oklch(0.75 0.18 270)" : "var(--muted-foreground)",
                                  }}>
                                    {selectedPrefs.wantsMoreMatches ? <CheckCircle2 size={11} /> : <ClipboardCheck size={11} />}
                                    More matches
                                  </span>
                                  <span style={{
                                    display: "flex", alignItems: "center", gap: 5,
                                    padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                                    background: selectedPrefs.wantsPitRotation ? "oklch(0.65 0.18 270 / 15%)" : "oklch(1 0 0 / 4%)",
                                    border: `1px solid ${selectedPrefs.wantsPitRotation ? "oklch(0.65 0.18 270 / 35%)" : "oklch(1 0 0 / 10%)"}`,
                                    color: selectedPrefs.wantsPitRotation ? "oklch(0.75 0.18 270)" : "var(--muted-foreground)",
                                  }}>
                                    {selectedPrefs.wantsPitRotation ? <CheckCircle2 size={11} /> : <WrenchIcon size={11} />}
                                    Pit rotation
                                  </span>
                                  <span style={{
                                    display: "flex", alignItems: "center", gap: 5,
                                    padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                                    background: selectedPrefs.wantsPitScouting ? "oklch(0.65 0.18 270 / 15%)" : "oklch(1 0 0 / 4%)",
                                    border: `1px solid ${selectedPrefs.wantsPitScouting ? "oklch(0.65 0.18 270 / 35%)" : "oklch(1 0 0 / 10%)"}`,
                                    color: selectedPrefs.wantsPitScouting ? "oklch(0.75 0.18 270)" : "var(--muted-foreground)",
                                  }}>
                                    {selectedPrefs.wantsPitScouting ? <CheckCircle2 size={11} /> : <ClipboardList size={11} />}
                                    Pit scouting
                                  </span>
                                </div>
                              )}
                            </>
                          ) : prefsDraft && (
                            <>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                {([
                                  { key: "wantsMoreMatches" as const, label: "More matches", icon: ClipboardCheck },
                                  { key: "wantsPitRotation" as const, label: "Pit rotation", icon: WrenchIcon },
                                  { key: "wantsPitScouting" as const, label: "Pit scouting", icon: ClipboardList },
                                ]).map(({ key, label, icon: Icon }) => {
                                  const on = prefsDraft[key];
                                  return (
                                    <button
                                      key={key}
                                      type="button"
                                      onClick={() => setPrefsDraft(d => d && { ...d, [key]: !d[key] })}
                                      style={{
                                        display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
                                        padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                                        background: on ? "oklch(0.65 0.18 270 / 18%)" : "oklch(1 0 0 / 4%)",
                                        border: `1px solid ${on ? "oklch(0.65 0.18 270 / 45%)" : "oklch(1 0 0 / 12%)"}`,
                                        color: on ? "oklch(0.8 0.18 270)" : "var(--muted-foreground)",
                                      }}
                                    >
                                      {on ? <CheckCircle2 size={11} /> : <Icon size={11} />}
                                      {label}
                                    </button>
                                  );
                                })}
                              </div>
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: "oklch(0.7 0.18 270)", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.06em" }}>Preferred partners</div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, maxHeight: 140, overflowY: "auto" }}>
                                  {(allUsers ?? []).filter(u => u._id !== selectedUserId).map(u => {
                                    const on = prefsDraft.preferredPartners.includes(u._id);
                                    return (
                                      <button
                                        key={u._id}
                                        type="button"
                                        onClick={() => toggleDraftPartner(u._id)}
                                        style={{
                                          padding: "3px 9px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                                          background: on ? "oklch(0.65 0.18 270 / 18%)" : "oklch(1 0 0 / 4%)",
                                          border: `1px solid ${on ? "oklch(0.65 0.18 270 / 45%)" : "oklch(1 0 0 / 12%)"}`,
                                          color: on ? "var(--foreground)" : "var(--muted-foreground)",
                                        }}
                                      >{u.name ?? u.email ?? "Scout"}</button>
                                    );
                                  })}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {/* ── Match Assignments section ── */}
                    <div style={{
                      borderRadius: 13,
                      background: "oklch(0.85 0.18 95 / 6%)",
                      border: "1px solid oklch(0.85 0.18 95 / 25%)",
                      overflow: "hidden",
                      marginBottom: 4,
                    }}>
                      <div style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "10px 13px",
                        borderBottom: "1px solid oklch(0.85 0.18 95 / 15%)",
                        background: "oklch(0.85 0.18 95 / 8%)",
                      }}>
                        <CalendarCheck size={13} style={{ color: "oklch(0.75 0.18 95)" }} />
                        <span style={{ fontWeight: 700, fontSize: 12, color: "oklch(0.75 0.18 95)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Match Assignments</span>
                        <span style={{
                          marginLeft: "auto", fontSize: 11, fontWeight: 700,
                          padding: "2px 8px", borderRadius: 20,
                          background: "oklch(0.85 0.18 95 / 15%)",
                          color: "oklch(0.75 0.18 95)",
                        }}>{scoutAssignments.length}</span>
                      </div>
                      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
                        {scoutAssignments.length === 0 ? (
                          <div style={{ padding: "14px 8px", textAlign: "center", fontSize: 12, color: "var(--muted-foreground)" }}>
                            No match assignments scheduled.
                          </div>
                        ) : (
                          scoutAssignments.map(a => {
                            const isRed = a.position.startsWith("red");
                            const slotKey = `${a.matchNumber}-${a.position}`;
                            const posLabel = { red1:"Red 1",red2:"Red 2",red3:"Red 3",blue1:"Blue 1",blue2:"Blue 2",blue3:"Blue 3" }[a.position] ?? a.position;
                            return (
                              <div key={a._id} style={{
                                display: "flex", alignItems: "center", gap: 8,
                                padding: "6px 8px", borderRadius: 9,
                                background: isRed ? "oklch(0.6 0.22 25 / 8%)" : "oklch(0.55 0.22 255 / 8%)",
                                border: `1px solid ${isRed ? "oklch(0.6 0.22 25 / 25%)" : "oklch(0.55 0.22 255 / 25%)"}`,
                              }}>
                                <div style={{
                                  width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                                  background: isRed ? "oklch(0.6 0.22 25 / 20%)" : "oklch(0.55 0.22 255 / 20%)",
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  fontWeight: 800, fontSize: 11,
                                  color: isRed ? "oklch(0.65 0.22 25)" : "oklch(0.65 0.22 255)",
                                }}>{a.position.slice(-1)}</div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 700, fontSize: 12, fontFamily: "monospace" }}>{a.matchLabel}</div>
                                  <div style={{ fontSize: 11, color: isRed ? "oklch(0.65 0.22 25)" : "oklch(0.65 0.22 255)", fontWeight: 600 }}>{posLabel}</div>
                                </div>
                                <button
                                  onClick={() => handleClearAssignment(a)}
                                  disabled={clearingSlot === slotKey}
                                  style={{
                                    border: "none", background: "transparent", cursor: "pointer",
                                    padding: "4px", borderRadius: 6, color: "var(--muted-foreground)",
                                    display: "flex", alignItems: "center",
                                    opacity: clearingSlot === slotKey ? 0.4 : 1,
                                    transition: "opacity 0.15s",
                                  }}
                                  title="Remove assignment"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>

                    {/* ── Pit Rotations section ── */}
                    <div style={{
                      borderRadius: 13,
                      background: "oklch(0.55 0.18 180 / 6%)",
                      border: "1px solid oklch(0.55 0.18 180 / 25%)",
                      overflow: "hidden",
                      marginBottom: 4,
                    }}>
                      <div style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "10px 13px",
                        borderBottom: "1px solid oklch(0.55 0.18 180 / 15%)",
                        background: "oklch(0.55 0.18 180 / 8%)",
                      }}>
                        <WrenchIcon size={13} style={{ color: "oklch(0.6 0.18 180)" }} />
                        <span style={{ fontWeight: 700, fontSize: 12, color: "oklch(0.6 0.18 180)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Pit Rotations</span>
                        <span style={{
                          marginLeft: "auto", fontSize: 11, fontWeight: 700,
                          padding: "2px 8px", borderRadius: 20,
                          background: "oklch(0.55 0.18 180 / 15%)",
                          color: "oklch(0.6 0.18 180)",
                        }}>{scoutPitRotations.length} assigned</span>
                      </div>
                      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
                        {/* Rotations this scout is already in */}
                        {scoutPitRotations.map(rot => (
                          <div key={rot._id} style={{
                            display: "flex", alignItems: "center", gap: 8,
                            padding: "6px 8px", borderRadius: 9,
                            background: "oklch(0.55 0.18 180 / 10%)",
                            border: "1px solid oklch(0.55 0.18 180 / 30%)",
                          }}>
                            <WrenchIcon size={13} style={{ color: "oklch(0.6 0.18 180)", flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: 12 }}>{rot.label ?? (rot.isElims ? "Elims Pit" : `Q${rot.startMatch}–Q${rot.endMatch}`)}</div>
                              {!rot.isElims && rot.startMatch != null && (
                                <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>Matches {rot.startMatch}–{rot.endMatch}</div>
                              )}
                            </div>
                            <button
                              onClick={() => handleTogglePitRotation(rot, false)}
                              disabled={togglingRot === rot._id}
                              style={{
                                border: "none", background: "transparent", cursor: "pointer",
                                padding: "4px", borderRadius: 6, color: "var(--muted-foreground)",
                                display: "flex", alignItems: "center",
                                opacity: togglingRot === rot._id ? 0.4 : 1,
                              }}
                              title="Remove from rotation"
                            >
                              <UserMinus size={13} />
                            </button>
                          </div>
                        ))}
                        {scoutPitRotations.length === 0 && (
                          <div style={{ padding: "14px 8px", textAlign: "center", fontSize: 12, color: "var(--muted-foreground)" }}>
                            Not assigned to any pit rotation.
                          </div>
                        )}
                      </div>
                    </div>

                    {selectedSubmissions.length === 0 ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 14,
                          padding: "60px 16px",
                          textAlign: "center",
                        }}
                      >
                        <div
                          style={{
                            width: 52,
                            height: 52,
                            borderRadius: "50%",
                            background: "oklch(1 0 0 / 5%)",
                            border: "1.5px solid oklch(1 0 0 / 10%)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <ClipboardList size={22} style={{ color: "var(--muted-foreground)" }} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, color: "var(--foreground)", marginBottom: 6 }}>
                            No submissions
                          </div>
                          <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
                            This scout hasn't submitted any reports for this event.
                          </div>
                        </div>
                      </div>
                    ) : (
                      selectedSubmissions.map((sub) => (
                        <SubmissionCard key={sub._id} submission={sub} onOpen={() => setOpenSubmission(sub)} />
                      ))
                    )}

                    {/* ── Delete all reports (this scout) — bottom of the panel ── */}
                    {selectedSubmissions.length > 0 && (
                      <button
                        onClick={handleDeleteScoutReports}
                        disabled={deletingScoutReports}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                          padding: "9px 12px",
                          borderRadius: 11,
                          background: "oklch(0.55 0.18 30 / 8%)",
                          border: "1px solid oklch(0.55 0.18 30 / 25%)",
                          color: "oklch(0.72 0.18 30)",
                          fontSize: 12.5, fontWeight: 700,
                          cursor: deletingScoutReports ? "default" : "pointer",
                          opacity: deletingScoutReports ? 0.6 : 1,
                          marginTop: 8,
                        }}
                      >
                        <Trash2 size={13} />
                        {deletingScoutReports
                          ? "Deleting…"
                          : `Delete all ${selectedSubmissions.length} report${selectedSubmissions.length !== 1 ? "s" : ""}`}
                      </button>
                    )}

                    {/* ── Deactivate user (soft delete) — most destructive action, always last ── */}
                    {!adminStatusByUser[selectedUser._id]?.isInherentAdmin && (
                      <button
                        onClick={() => handleDeactivateUser(selectedUser._id, displayName(selectedUser))}
                        disabled={deactivating === selectedUser._id}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                          padding: "9px 12px",
                          borderRadius: 11,
                          background: "oklch(0.577 0.245 27 / 8%)",
                          border: "1px solid oklch(0.577 0.245 27 / 30%)",
                          color: "var(--destructive)",
                          fontSize: 12.5, fontWeight: 700,
                          cursor: deactivating === selectedUser._id ? "default" : "pointer",
                          opacity: deactivating === selectedUser._id ? 0.6 : 1,
                          marginTop: 8,
                        }}
                      >
                        <Ban size={13} />
                        {deactivating === selectedUser._id ? "Deactivating…" : "Deactivate User"}
                      </button>
                    )}
                  </div>
                </ScrollArea>
              </div>
            ) : (
              /* Empty hint when no scout is selected */
              <div
                className="hidden md:flex"
                style={{
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 16,
                  border: "2px dashed oklch(1 0 0 / 10%)",
                }}
              >
                <div style={{ textAlign: "center" }}>
                  <Users size={36} style={{ color: "var(--muted-foreground)", opacity: 0.25, margin: "0 auto 10px" }} />
                  <p style={{ fontSize: 14, fontWeight: 600, color: "var(--muted-foreground)" }}>Select a scout</p>
                  <p style={{ fontSize: 12, color: "var(--muted-foreground)", opacity: 0.7 }}>
                    Click any scout to see their match reports
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showRanking && (
        <ReportRankingModal ranking={reportRanking} onClose={() => setShowRanking(false)} />
      )}

      {/* Submission Detail Modal */}
      {openSubmission && (
        <SubmissionDetailModal
          submission={openSubmission}
          scoutName={selectedUser ? displayName(selectedUser) : "Unknown Scout"}
          templates={allTemplates}
          onClose={() => setOpenSubmission(null)}
          onDeleted={() => setOpenSubmission(null)}
        />
      )}
    </div>
  );
}
