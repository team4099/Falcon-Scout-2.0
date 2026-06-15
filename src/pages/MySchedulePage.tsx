import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchTBAEventMatches } from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import {
  CalendarDays, CalendarCheck, ClipboardList, Wrench, Coffee,
  Loader2, CheckCircle2, Users,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Position = "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";

interface MatchAssignment {
  _id: string;
  matchNumber: number;
  matchLabel: string;
  position: Position;
}

interface PitRotation {
  _id: string;
  label?: string;
  startMatch?: number;
  endMatch?: number;
  isElims?: boolean;
  scoutIds: string[];
}

// ── Position labels ───────────────────────────────────────────────────────────

const POS_LABEL: Record<Position, string> = {
  red1: "Red 1", red2: "Red 2", red3: "Red 3",
  blue1: "Blue 1", blue2: "Blue 2", blue3: "Blue 3",
};

// ── Theme tokens — gold / black only ─────────────────────────────────────────

const G       = "oklch(0.85 0.18 95)";
const G_DIM   = "oklch(0.85 0.18 95 / 10%)";
const G_MED   = "oklch(0.85 0.18 95 / 25%)";
const G_STR   = "oklch(0.85 0.18 95 / 45%)";
const G_TXT   = "oklch(0.1 0 0)";
const SURFACE   = "oklch(1 0 0 / 3%)";
const SURF_BORD = "oklch(1 0 0 / 8%)";
const MUTED     = "var(--muted-foreground)";
const FG        = "var(--foreground)";

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchSortKey(m: TBAMatch) {
  const lvl: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
  return (lvl[m.comp_level] ?? 99) * 1_000_000 + m.set_number * 10_000 + m.match_number;
}

function formatTime(m: TBAMatch): string | null {
  const ts = m.predicted_time ?? m.time;
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ── Scouting match card ───────────────────────────────────────────────────────

function ScoutingCard({ assignment, match }: { assignment: MatchAssignment; match: TBAMatch | null }) {
  const time = match ? formatTime(match) : null;

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
        borderRadius: 12, background: G_DIM, border: `1px solid ${G_MED}`,
        transition: "transform 0.1s ease", cursor: "default",
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      {/* Icon */}
      <div style={{
        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
        background: G, display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: `0 2px 10px ${G} / 40%`,
      }}>
        <ClipboardList size={16} color={G_TXT} />
      </div>

      {/* Match + position */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: FG, fontFamily: "monospace", letterSpacing: "-0.01em" }}>
          {assignment.matchLabel}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
          {POS_LABEL[assignment.position]}{time ? ` · ${time}` : ""}
        </div>
      </div>

      {/* Position badge */}
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "4px 11px", borderRadius: 8,
        background: G, color: G_TXT, fontSize: 12, fontWeight: 700,
        border: `1px solid ${G_STR}`, flexShrink: 0,
        boxShadow: `0 2px 8px ${G} / 30%`,
      }}>
        {POS_LABEL[assignment.position]}
      </span>
    </div>
  );
}

// ── Elims pit card ─────────────────────────────────────────────────────────────

function ElimsCard() {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
        borderRadius: 12, background: G_DIM, border: `1.5px solid ${G_STR}`,
        transition: "transform 0.1s ease", cursor: "default",
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
        background: G, display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: `0 2px 10px ${G} / 40%`,
      }}>
        <Wrench size={16} color={G_TXT} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: FG }}>Playoffs</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>QF, SF & Finals</div>
      </div>
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "4px 11px", borderRadius: 8,
        background: G, color: G_TXT, fontSize: 12, fontWeight: 700,
        border: `1px solid ${G_STR}`, flexShrink: 0,
        boxShadow: `0 2px 8px ${G} / 30%`,
      }}>
        <Wrench size={11} />
        Elims Pit Duty
      </span>
    </div>
  );
}

// ── Qual pit rotation card ─────────────────────────────────────────────────────

function QualPitCard({ rotation }: { rotation: PitRotation }) {
  const span = (rotation.startMatch != null && rotation.endMatch != null)
    ? rotation.endMatch - rotation.startMatch + 1 : null;
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
        borderRadius: 12, background: SURFACE, border: `1px solid ${SURF_BORD}`,
        transition: "transform 0.1s ease", cursor: "default",
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "translateX(3px)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "none")}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
        background: G_DIM, border: `1px solid ${G_MED}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Wrench size={16} style={{ color: G }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: FG, fontFamily: "monospace" }}>
          Q{rotation.startMatch} – Q{rotation.endMatch}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
          {rotation.label ? `${rotation.label} · ` : ""}{span} match{span !== 1 ? "es" : ""}
        </div>
      </div>
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "4px 11px", borderRadius: 8,
        background: G_DIM, color: G, fontSize: 12, fontWeight: 700,
        border: `1px solid ${G_MED}`, flexShrink: 0,
      }}>
        <Wrench size={11} />
        Pit Duty
      </span>
    </div>
  );
}

// ── Section shell ─────────────────────────────────────────────────────────────

function Section({
  icon: Icon, title, description, count, accent, children,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  count: number;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      borderRadius: 16, overflow: "hidden",
      background: accent ? G_DIM : SURFACE,
      border: `1px solid ${accent ? G_MED : SURF_BORD}`,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        borderBottom: `1px solid ${accent ? G_MED : SURF_BORD}`,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: accent ? G : "oklch(1 0 0 / 6%)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: accent ? `0 2px 8px ${G} / 30%` : "none",
        }}>
          <Icon size={15} color={accent ? G_TXT : MUTED} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: FG }}>{title}</div>
          <div style={{ fontSize: 11, color: MUTED }}>{description}</div>
        </div>
        <span style={{
          background: accent ? G : "oklch(1 0 0 / 6%)",
          color: accent ? G_TXT : MUTED,
          borderRadius: 20, padding: "2px 11px", fontSize: 12, fontWeight: 800,
          flexShrink: 0,
          boxShadow: accent && count > 0 ? `0 2px 8px ${G} / 30%` : "none",
        }}>
          {count}
        </span>
      </div>

      <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        {count === 0 ? (
          <p style={{ fontSize: 13, color: MUTED, padding: "8px 4px", opacity: 0.7 }}>
            Nothing assigned here yet.
          </p>
        ) : children}
      </div>
    </div>
  );
}

// ── Preferences Panel ────────────────────────────────────────────────────────

interface UserRecord { _id: string; name?: string; email?: string; image?: string; }
interface ScoutPrefs { preferredPartners: string[]; wantsMoreMatches: boolean; wantsPitRotation: boolean; }

function displayName(u: UserRecord) { return u.name ?? u.email ?? "Scout"; }
function avatarLetter(u: UserRecord) { return displayName(u).charAt(0).toUpperCase(); }

function MiniAvatar({ user, size = 24 }: { user: UserRecord; size?: number }) {
  if (user.image) {
    return <img src={user.image} alt={displayName(user)} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: "linear-gradient(135deg, oklch(0.85 0.18 95 / 90%) 0%, oklch(0.75 0.20 80 / 90%) 100%)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.42, fontWeight: 800, color: "oklch(0.1 0 0)",
    }}>
      {avatarLetter(user)}
    </div>
  );
}

function Toggle({ on, onToggle, label, sub }: { on: boolean; onToggle: () => void; label: string; sub: string }) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "13px 15px", borderRadius: 13, width: "100%", textAlign: "left", cursor: "pointer",
        background: on ? G_DIM : SURFACE,
        border: `1.5px solid ${on ? G_STR : SURF_BORD}`,
        transition: "all 0.18s ease",
        outline: "none",
      }}
    >
      {/* Track */}
      <div style={{
        width: 40, height: 22, borderRadius: 11, flexShrink: 0,
        background: on ? G : "oklch(1 0 0 / 12%)",
        border: `1.5px solid ${on ? G_STR : "oklch(1 0 0 / 18%)"}`,
        position: "relative", transition: "background 0.18s ease, border-color 0.18s ease",
      }}>
        <div style={{
          position: "absolute", top: 2, left: on ? 20 : 2,
          width: 14, height: 14, borderRadius: "50%",
          background: on ? G_TXT : "oklch(0.6 0 0)",
          transition: "left 0.18s ease, background 0.18s ease",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
        }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: FG }}>{label}</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>{sub}</div>
      </div>
    </button>
  );
}

function PartnerPicker({
  allUsers, selfId, selected, onChange,
}: {
  allUsers: UserRecord[];
  selfId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const scouts = allUsers.filter(u => u._id !== selfId);

  function toggle(id: string) {
    if (selected.includes(id)) {
      onChange(selected.filter(x => x !== id));
    } else {
      if (selected.length >= 3) return;
      onChange([...selected, id]);
    }
  }

  if (scouts.length === 0) {
    return (
      <div style={{ padding: "18px 0", textAlign: "center", fontSize: 13, color: MUTED }}>
        No other scouts found
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {scouts.map(u => {
        const isSelected = selected.includes(u._id);
        const atLimit = selected.length >= 3 && !isSelected;
        return (
          <button
            key={u._id}
            onClick={() => toggle(u._id)}
            disabled={atLimit}
            style={{
              display: "flex", alignItems: "center", gap: 11,
              padding: "9px 12px", borderRadius: 11, width: "100%",
              textAlign: "left", cursor: atLimit ? "not-allowed" : "pointer",
              outline: "none",
              background: isSelected ? G_DIM : SURFACE,
              border: `1.5px solid ${isSelected ? G_STR : SURF_BORD}`,
              opacity: atLimit ? 0.4 : 1,
              transition: "all 0.15s ease",
            }}
            onMouseEnter={e => {
              if (!atLimit && !isSelected)
                (e.currentTarget as HTMLButtonElement).style.background = "oklch(1 0 0 / 5%)";
            }}
            onMouseLeave={e => {
              if (!isSelected)
                (e.currentTarget as HTMLButtonElement).style.background = isSelected ? G_DIM : SURFACE;
            }}
          >
            <MiniAvatar user={u} size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontWeight: 600, fontSize: 13, color: FG,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {displayName(u)}
              </div>
              {u.email && u.name && (
                <div style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {u.email}
                </div>
              )}
            </div>
            {/* Checkmark */}
            <div style={{
              width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
              background: isSelected ? G : "oklch(1 0 0 / 8%)",
              border: `1.5px solid ${isSelected ? G_STR : "oklch(1 0 0 / 15%)"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.15s ease",
            }}>
              {isSelected && (
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1 4L3.5 6.5L9 1" stroke="oklch(0.1 0 0)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PreferencesPanel({
  eventKey, selfId, allUsers, existingPrefs,
}: {
  eventKey: string;
  selfId: string;
  allUsers: UserRecord[];
  existingPrefs: ScoutPrefs | null;
}) {
  const upsert = useMutation(api.schedules.upsertMyPreferences);
  const [partners, setPartners] = useState<string[]>(existingPrefs?.preferredPartners ?? []);
  const [wantsMore, setWantsMore] = useState(existingPrefs?.wantsMoreMatches ?? false);
  const [wantsPit, setWantsPit] = useState(existingPrefs?.wantsPitRotation ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(!!existingPrefs);

  const dirty = useMemo(() => {
    if (!existingPrefs) return partners.length > 0 || wantsMore || wantsPit;
    return (
      JSON.stringify(partners) !== JSON.stringify(existingPrefs.preferredPartners) ||
      wantsMore !== existingPrefs.wantsMoreMatches ||
      wantsPit !== existingPrefs.wantsPitRotation
    );
  }, [partners, wantsMore, wantsPit, existingPrefs]);

  async function handleSave() {
    setSaving(true);
    try {
      await upsert({ eventKey, preferredPartners: partners as any, wantsMoreMatches: wantsMore, wantsPitRotation: wantsPit });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

      {/* Header card */}
      <div style={{
        borderRadius: 16, padding: "20px 20px 18px",
        background: G_DIM, border: `1.5px solid ${G_MED}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 11, flexShrink: 0,
            background: G, display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 4px 14px ${G} / 45%`,
          }}>
            <CalendarCheck size={20} color={G_TXT} />
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: FG, letterSpacing: "-0.01em" }}>No schedule yet</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 1 }}>Tell your admin how you'd like to be assigned</div>
          </div>
        </div>
        <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.55, margin: 0 }}>
          Your admin hasn't built your schedule yet. Fill out your preferences below and they'll be visible when the team creates assignments.
        </p>
      </div>

      {/* Partner picker */}
      <div style={{
        borderRadius: 14, overflow: "hidden",
        background: SURFACE, border: `1px solid ${SURF_BORD}`,
      }}>
        <div style={{ padding: "12px 15px", borderBottom: `1px solid ${SURF_BORD}`, display: "flex", alignItems: "center", gap: 9 }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: G_DIM, border: `1px solid ${G_MED}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Users size={13} style={{ color: G }} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: FG }}>Preferred Partners</div>
            <div style={{ fontSize: 11, color: MUTED }}>Pick up to 3 scouts you'd like to scout alongside</div>
          </div>
          <span style={{
            marginLeft: "auto", background: G_DIM, color: G,
            borderRadius: 20, padding: "2px 9px", fontSize: 11, fontWeight: 700,
            border: `1px solid ${G_MED}`, flexShrink: 0,
          }}>
            {partners.length}/3
          </span>
        </div>
        <div style={{ padding: "12px 14px 14px" }}>
          <PartnerPicker allUsers={allUsers} selfId={selfId} selected={partners} onChange={ids => { setPartners(ids); setSaved(false); }} />
        </div>
      </div>

      {/* Toggles */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Toggle
          on={wantsMore}
          onToggle={() => { setWantsMore(v => !v); setSaved(false); }}
          label="Scout more matches"
          sub="Let your admin know you're happy to take extra scouting slots"
        />
        <Toggle
          on={wantsPit}
          onToggle={() => { setWantsPit(v => !v); setSaved(false); }}
          label="Include me in pit rotations"
          sub="Opt in to pit scouting duty between matches"
        />
      </div>

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving || (!dirty && saved)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
          padding: "13px 24px", borderRadius: 12, cursor: saving || (!dirty && saved) ? "default" : "pointer",
          background: saved && !dirty ? G_DIM : G,
          border: `1.5px solid ${saved && !dirty ? G_MED : G_STR}`,
          color: saved && !dirty ? G : G_TXT,
          fontWeight: 800, fontSize: 14, letterSpacing: "-0.01em",
          transition: "all 0.18s ease", outline: "none",
          opacity: saving ? 0.7 : 1,
          boxShadow: saved && !dirty ? "none" : `0 4px 18px ${G} / 40%`,
        }}
      >
        {saving ? (
          <><Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />Saving…</>
        ) : saved && !dirty ? (
          <><CheckCircle2 size={16} />Preferences saved</>  
        ) : (
          <>Save preferences</>
        )}
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MySchedulePage() {
  const [tbaMatches, setTbaMatches] = useState<TBAMatch[]>([]);
  const [tbaLoading, setTbaLoading] = useState(false);

  const currentEvent   = useCached(useQuery(api.events.getCurrentEvent), "current_event");
  const viewer         = useQuery(api.users.viewer);
  const allUsers       = useQuery(api.users.listUsers) as UserRecord[] | undefined;
  const myAssignments  = useQuery(
    api.schedules.getMyMatchAssignments,
    currentEvent ? { eventKey: currentEvent.eventKey } : "skip"
  ) as MatchAssignment[] | undefined;
  const myPitRotations = useQuery(
    api.schedules.getMyPitRotations,
    currentEvent ? { eventKey: currentEvent.eventKey } : "skip"
  ) as PitRotation[] | undefined;
  const myPreferences  = useQuery(
    api.schedules.getMyPreferences,
    currentEvent ? { eventKey: currentEvent.eventKey } : "skip"
  );

  useEffect(() => {
    if (!currentEvent?.eventKey) { setTbaMatches([]); return; }
    setTbaLoading(true);
    fetchTBAEventMatches(currentEvent.eventKey)
      .then(data => { if (Array.isArray(data)) setTbaMatches([...data].sort((a, b) => matchSortKey(a) - matchSortKey(b))); })
      .finally(() => setTbaLoading(false));
  }, [currentEvent?.eventKey]);

  const matchMap = useMemo(() => {
    const m: Record<number, TBAMatch> = {};
    for (const t of tbaMatches) m[t.match_number] = t;
    return m;
  }, [tbaMatches]);

  const assignments = useMemo(() =>
    [...(myAssignments ?? [])].sort((a, b) => a.matchNumber - b.matchNumber),
    [myAssignments]
  );
  const pitRotations = useMemo(() =>
    [...(myPitRotations ?? [])].sort((a, b) => (a.startMatch ?? 0) - (b.startMatch ?? 0)),
    [myPitRotations]
  );

  const elimsRotation = pitRotations.find(r => r.isElims) ?? null;
  const qualRotations  = pitRotations.filter(r => !r.isElims);

  const pitMatchCount = useMemo(() => {
    const nums = new Set<number>();
    for (const rot of qualRotations) {
      if (rot.startMatch != null && rot.endMatch != null) {
        for (let n = rot.startMatch; n <= rot.endMatch; n++) nums.add(n);
      }
    }
    return nums.size;
  }, [qualRotations]);

  const totalMatches   = tbaMatches.filter(m => m.comp_level === "qm").length;
  const scoutingCount  = assignments.length;
  const offCount       = Math.max(0, totalMatches - scoutingCount - pitMatchCount);
  const loading        = myAssignments === undefined || myPitRotations === undefined;
  const hasAnything    = scoutingCount > 0 || pitRotations.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", gap: 20 }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, background: G, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 4px 16px ${G} / 45%`,
          }}>
            <CalendarDays size={19} color={G_TXT} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: FG, margin: 0, lineHeight: 1.2, letterSpacing: "-0.02em" }}>
              My Schedule
            </h1>
            <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>
              {currentEvent
                ? `${currentEvent.eventName ?? currentEvent.eventKey}`
                : "Set an event in Settings to see your schedule"}
            </p>
          </div>
        </div>
      </div>

      {/* ── No event ─────────────────────────────────────────────────────── */}
      {!currentEvent && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: SURFACE, border: `1.5px solid ${SURF_BORD}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CalendarDays size={28} style={{ color: MUTED }} />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: FG, marginBottom: 6 }}>No Event Selected</div>
            <div style={{ fontSize: 13, color: MUTED, maxWidth: 300 }}>Ask an admin to set the current event, then check back here.</div>
          </div>
        </div>
      )}

      {/* ── Loading ───────────────────────────────────────────────────────── */}
      {currentEvent && loading && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: MUTED }}>
          <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
          <span style={{ fontSize: 14 }}>Loading your schedule…</span>
        </div>
      )}

      {/* ── Empty → Preferences Panel ─────────────────────────────────── */}
      {currentEvent && !loading && !hasAnything && (
        <ScrollArea style={{ flex: 1 }}>
          <div style={{ paddingBottom: 24 }}>
            {viewer && allUsers ? (
              <PreferencesPanel
                eventKey={currentEvent.eventKey}
                selfId={viewer._id as string}
                allUsers={allUsers}
                existingPrefs={myPreferences
                  ? {
                      preferredPartners: (myPreferences as any).preferredPartners ?? [],
                      wantsMoreMatches:  (myPreferences as any).wantsMoreMatches  ?? false,
                      wantsPitRotation:  (myPreferences as any).wantsPitRotation  ?? false,
                    }
                  : null
                }
              />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "60px 0", gap: 10, color: MUTED }}>
                <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
                <span style={{ fontSize: 14 }}>Loading…</span>
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      {/* ── Schedule ──────────────────────────────────────────────────────── */}
      {currentEvent && !loading && hasAnything && (
        <ScrollArea style={{ flex: 1 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 24 }}>

            {/* Summary strip */}
            <div style={{ display: "flex", gap: 2, padding: 4, borderRadius: 14, background: SURFACE, border: `1px solid ${SURF_BORD}` }}>
              {([
                { label: "Scouting",  count: scoutingCount,         icon: ClipboardList, accent: true  },
                { label: "Pit Duty",  count: qualRotations.length + (elimsRotation ? 1 : 0), icon: Wrench, accent: false },
                { label: "Off",       count: offCount,               icon: Coffee,        accent: false },
              ] as const).map(({ label, count, icon: Icon, accent }) => (
                <div key={label} style={{
                  flex: 1, display: "flex", alignItems: "center", gap: 8,
                  padding: "10px 14px", borderRadius: 10,
                  background: accent && count > 0 ? G_DIM : "transparent",
                  border: `1px solid ${accent && count > 0 ? G_MED : "transparent"}`,
                }}>
                  <Icon size={14} style={{ color: accent && count > 0 ? G : MUTED, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: FG, lineHeight: 1 }}>{count}</div>
                    <div style={{
                      fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: accent && count > 0 ? G : MUTED,
                    }}>
                      {label}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {tbaLoading && (
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 12px", borderRadius: 10,
                background: G_DIM, border: `1px solid ${G_MED}`,
                fontSize: 12, color: G,
              }}>
                <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                <span>Loading match times…</span>
              </div>
            )}

            {/* Scouting matches */}
            <Section
              icon={ClipboardList} title="Your Scouting Matches"
              description="Matches where you are assigned to scout a robot"
              count={scoutingCount} accent
            >
              {assignments.map(a => (
                <ScoutingCard key={a._id} assignment={a} match={matchMap[a.matchNumber] ?? null} />
              ))}
            </Section>

            {/* Elims pit rotation — shown separately if assigned */}
            {elimsRotation && (
              <Section
                icon={Wrench} title="Elims Pit Rotation"
                description="You are on pit duty for all playoff matches"
                count={1} accent
              >
                <ElimsCard />
              </Section>
            )}

            {/* Qual pit rotations */}
            {qualRotations.length > 0 && (
              <Section
                icon={Wrench} title="Qual Pit Rotations"
                description="Match ranges where you are on pit duty during quals"
                count={qualRotations.length} accent={false}
              >
                {qualRotations.map(r => <QualPitCard key={r._id} rotation={r} />)}
              </Section>
            )}

            {/* Off summary */}
            {totalMatches > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                borderRadius: 14, background: SURFACE, border: `1px solid ${SURF_BORD}`,
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                  background: "oklch(1 0 0 / 6%)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <Coffee size={15} style={{ color: MUTED }} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: FG }}>
                    {offCount} match{offCount !== 1 ? "es" : ""} off
                  </div>
                  <div style={{ fontSize: 12, color: MUTED }}>
                    No assignment for these qual matches — you're free!
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
