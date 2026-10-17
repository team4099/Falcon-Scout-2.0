// Admin-only feed of every form submitted at the current event, newest first.
// Reads forms.listSubmissionSummaries (no answer data; same rows Data Viewer uses)
// (no new data exposure); deleting from the detail modal is requireAdmin.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useCurrentEvent } from "@/hooks/useCurrentEvent";
import { useUIStore } from "@/store/uiStore";
import {
  SubmissionDetailModal,
  AdminLockScreen,
  formatTimestamp,
  type Submission,
  type FormTemplate,
} from "@/components/SubmissionDetailModal";
import { filterFeed } from "@/lib/submissionFeed";
import { scoutLabel } from "@/lib/scoutName";
import { fetchTBAEventMatches, type TBAMatch } from "@/lib/api";
import { buildAttendance, teamAtPosition, type AttendanceAssignment } from "@/lib/scoutAttendance";
import { Inbox, Search, CheckCircle2, XCircle } from "lucide-react";

interface User {
  _id: string;
  name?: string;
  nickname?: string;
  email?: string;
}

// Per-device "last opened the feed" timestamp → NEW badges. A convenience
// only, so it's fine for Settings → Clear Cache to wipe it.
const LAST_SEEN_KEY = "submissions_last_seen";
const PAGE = 100;

function readLastSeen(): number {
  try {
    return Number(localStorage.getItem(LAST_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

export default function SubmissionsPage() {
  const { isAdminMode } = useUIStore();
  const currentEvent = useCurrentEvent();
  const eventKey = currentEvent?.eventKey ?? "";
  const submissions = useQuery(api.forms.listSubmissionSummaries, eventKey ? { eventKey } : "skip") as
    | Submission[]
    | undefined;
  // This event's forms as they were scouted (incl. since-edited or deleted ones).
  const templates = useQuery(api.forms.listEventTemplates, eventKey ? { eventKey } : "skip") as
    | FormTemplate[]
    | undefined;
  const users = useQuery(api.users.listUsers) as User[] | undefined;

  const [templateId, setTemplateId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<Submission | null>(null);
  // Snapshot on mount so NEW badges stay put while the page is open; the next
  // visit only flags what arrived after this one.
  const [lastSeen] = useState(readLastSeen);
  useEffect(() => {
    if (!isAdminMode) return;
    try {
      localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
    } catch {
      /* storage blocked — badges just won't persist */
    }
  }, [isAdminMode]);

  const scoutName = useMemo(() => {
    const byId = new Map((users ?? []).map((u) => [u._id, u]));
    return (id?: string) => {
      const u = id ? byId.get(id) : undefined;
      return u ? scoutLabel(u, "Unknown scout") : "Unknown scout";
    };
  }, [users]);
  const formName = useMemo(() => {
    const byId = new Map((templates ?? []).map((t) => [t._id, t.name]));
    return (id: string) => byId.get(id) ?? "Unknown form";
  }, [templates]);

  // ── Attendance: assigned qual scouts vs. forms actually filed ───────────────
  const [view, setView] = useState<"feed" | "attendance">("feed");
  const [onlyMissed, setOnlyMissed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const assignments = useQuery(
    api.schedules.listMatchAssignments,
    eventKey && view === "attendance" ? { eventKey } : "skip",
  ) as AttendanceAssignment[] | undefined;
  const [tbaQuals, setTbaQuals] = useState<TBAMatch[] | null | undefined>(undefined);
  useEffect(() => {
    if (!eventKey || view !== "attendance") return;
    let live = true;
    fetchTBAEventMatches(eventKey)
      .then((m) => live && setTbaQuals(Array.isArray(m) ? m.filter((x) => x.comp_level === "qm") : null))
      .catch(() => live && setTbaQuals(null));
    return () => { live = false; };
  }, [eventKey, view]);
  const attendance = useMemo(() => {
    if (!assignments || !submissions || !templates || !tbaQuals) return undefined;
    const quals = new Map(tbaQuals.map((m) => [m.match_number, m]));
    const played = new Set(
      tbaQuals.filter((m) => m.alliances.red.score >= 0 && m.alliances.blue.score >= 0).map((m) => m.match_number),
    );
    return buildAttendance({
      assignments,
      submissions,
      matchTemplateIds: new Set(templates.filter((t) => (t.formType ?? "default") === "default").map((t) => t._id)),
      playedQuals: played,
      teamFor: (n, pos) => teamAtPosition(quals.get(n)?.alliances, pos),
    }).sort((a, b) => b.missed - a.missed || scoutName(a.scoutId).localeCompare(scoutName(b.scoutId)));
  }, [assignments, submissions, templates, tbaQuals, scoutName]);

  const feed = useMemo(
    () => filterFeed(submissions ?? [], { templateId, query, scoutName, formName }),
    [submissions, templateId, query, scoutName, formName],
  );
  // Only offer chips for forms that actually have submissions here.
  const formChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of submissions ?? []) counts.set(s.templateId, (counts.get(s.templateId) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [submissions]);
  const newCount = (submissions ?? []).filter((s) => s.syncedAt > lastSeen).length;

  if (!isAdminMode) return <AdminLockScreen feature="Submissions" />;

  const chip = (active: boolean): React.CSSProperties => ({
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
    cursor: "pointer",
    border: `1px solid ${active ? "oklch(0.85 0.18 95)" : "oklch(1 0 0 / 12%)"}`,
    background: active ? "oklch(0.85 0.18 95 / 15%)" : "transparent",
    color: active ? "oklch(0.85 0.18 95)" : "var(--muted-foreground)",
  });
  const pick = (id: string | null) => { setTemplateId(id); setLimit(PAGE); };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", gap: 14 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <div
          style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            background: "oklch(0.85 0.18 95)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <Inbox size={19} color="oklch(0.1 0 0)" />
        </div>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>Submissions</h1>
          <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
            {eventKey || "No event"} · {submissions?.length ?? "…"} total
            {newCount > 0 && <span style={{ color: "oklch(0.85 0.18 95)", fontWeight: 700 }}> · {newCount} new</span>}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button style={chip(view === "feed")} onClick={() => setView("feed")}>Feed</button>
        <button style={chip(view === "attendance")} onClick={() => setView("attendance")}>Attendance</button>
      </div>

      {view === "attendance" && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
          {attendance === undefined ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
              {tbaQuals === null
                ? "Couldn't load match results from TBA, so missed matches can't be worked out."
                : "Loading…"}
            </div>
          ) : attendance.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
              No assigned qual matches have been played yet.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12, color: "var(--muted-foreground)" }}>
                <span>
                  {attendance.reduce((n, r) => n + r.missed, 0)} missed of{" "}
                  {attendance.reduce((n, r) => n + r.submitted + r.missed, 0)} played assignments
                </span>
                <button style={chip(onlyMissed)} onClick={() => setOnlyMissed((v) => !v)}>Missed only</button>
              </div>
              {attendance.filter((r) => !onlyMissed || r.missed > 0).map((r) => {
                const isOpen = expanded === r.scoutId;
                return (
                  <div key={r.scoutId} style={{ border: "1px solid oklch(1 0 0 / 8%)", borderRadius: 12, background: "oklch(1 0 0 / 2%)" }}>
                    <button
                      onClick={() => setExpanded(isOpen ? null : r.scoutId)}
                      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "10px 12px", cursor: "pointer" }}
                    >
                      <span style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {scoutName(r.scoutId)}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: "oklch(0.75 0.17 150)" }}>{r.submitted} done</span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: r.missed ? "oklch(0.7 0.2 25)" : "var(--muted-foreground)" }}>
                        {r.missed} missed
                      </span>
                    </button>
                    {isOpen && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 12px 12px" }}>
                        {r.matches.map((m) => (
                          <span
                            key={m.matchNumber}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 8,
                              fontSize: 12, fontWeight: 600,
                              color: m.submitted ? "oklch(0.75 0.17 150)" : "oklch(0.7 0.2 25)",
                              background: m.submitted ? "oklch(0.75 0.17 150 / 12%)" : "oklch(0.7 0.2 25 / 14%)",
                            }}
                          >
                            {m.submitted ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                            {m.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      {view === "feed" && (<>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
        <label
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "0 12px", height: 40,
            borderRadius: 10, border: "1px solid oklch(1 0 0 / 12%)", background: "oklch(1 0 0 / 3%)",
          }}
        >
          <Search size={15} style={{ color: "var(--muted-foreground)", flexShrink: 0 }} />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }}
            placeholder="Team #, match #, scout, or form"
            inputMode="search"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: 16 }}
          />
        </label>
        {formChips.length > 1 && (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
            <button style={chip(templateId === null)} onClick={() => pick(null)}>All</button>
            {formChips.map(([id, n]) => (
              <button key={id} style={chip(templateId === id)} onClick={() => pick(id)}>
                {formName(id)} · {n}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Feed */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
        {submissions === undefined ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
            {eventKey ? "Loading…" : "Set a current event in Settings to see submissions."}
          </div>
        ) : feed.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
            {submissions.length === 0 ? "No forms submitted at this event yet." : "Nothing matches that filter."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 16 }}>
            {feed.slice(0, limit).map((s) => {
              const isNew = s.syncedAt > lastSeen;
              return (
                <button
                  key={s._id}
                  onClick={() => setOpen(s)}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
                    padding: "10px 12px", borderRadius: 12, cursor: "pointer",
                    border: `1px solid ${isNew ? "oklch(0.85 0.18 95 / 40%)" : "oklch(1 0 0 / 8%)"}`,
                    background: isNew ? "oklch(0.85 0.18 95 / 6%)" : "oklch(1 0 0 / 2%)",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 52, flexShrink: 0 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted-foreground)", letterSpacing: "0.06em" }}>
                      {s.matchNumber ? "MATCH" : "FORM"}
                    </span>
                    <span style={{ fontSize: 17, fontWeight: 800, color: "oklch(0.85 0.18 95)" }}>
                      {s.matchNumber || "—"}
                    </span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {/* Spying rows aren't per-team (teamNumber 0) — label them by form instead. */}
                      <span style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.teamNumber ? `Team ${s.teamNumber}` : formName(s.templateId)}</span>
                      {isNew && (
                        <span style={{
                          fontSize: 9.5, fontWeight: 800, padding: "1px 6px", borderRadius: 6,
                          background: "oklch(0.85 0.18 95)", color: "oklch(0.1 0 0)",
                        }}>
                          NEW
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted-foreground)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.teamNumber ? `${formName(s.templateId)} · ` : ""}{scoutName(s.scoutId)}
                    </div>
                  </div>
                  <span style={{ fontSize: 11.5, color: "var(--muted-foreground)", flexShrink: 0 }}>
                    {formatTimestamp(s.syncedAt)}
                  </span>
                </button>
              );
            })}
            {feed.length > limit && (
              <button style={{ ...chip(false), alignSelf: "center", marginTop: 6 }} onClick={() => setLimit((n) => n + PAGE)}>
                Show more ({feed.length - limit} left)
              </button>
            )}
          </div>
        )}
      </div>
      </>)}

      {open && (
        <SubmissionDetailModal
          submission={open}
          scoutName={scoutName(open.scoutId)}
          templates={templates}
          onClose={() => setOpen(null)}
          onDeleted={() => setOpen(null)}
        />
      )}
    </div>
  );
}
