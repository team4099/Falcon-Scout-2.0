// Playoff alliance profile, opened from the bracket. Same shell as the team
// profile: an overview comparing every team on the alliance (tap a team for
// its full profile) and the alliance's Spying reports.
import { useEffect, useMemo, useState } from "react";
import { X, TrendingUp, ClipboardList, ChevronRight } from "lucide-react";
import { useEventTeamData } from "@/hooks/useEventTeamData";
import type { EventSubmission } from "@/hooks/useEventTeamData";
import { aggregateField } from "@/lib/rankingColumns";
import { EMPTY_TEAM_EPA, type TeamEpa } from "@/lib/epa";
import { fetchTBATeamInfo } from "@/lib/api";
import { parseSubData, fieldsForData, isEmptyValue, isLowerBetter } from "@/lib/teamProfile";
import type { FormField } from "@/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import TeamDetailPanel, { AnswerList, PhotoLightbox, TeamAvatar } from "@/pages/TeamDetailPanel";

const MY_TEAM = 4099;
const fmt = (n: number) => String(Math.round(n * 10) / 10);

interface Row {
  label: string;
  values: Array<number | null>;
  /** Alliance total, for stats that add up across robots. */
  total: number | null;
  suffix?: string;
  lowerBetter?: boolean;
}

const EPA_ROWS: Array<[keyof TeamEpa, string]> = [
  ["event", "Event EPA"],
  ["overall", "Season EPA"],
  ["auto", "Auto EPA"],
  ["teleop", "Teleop EPA"],
  ["endgame", "Endgame EPA"],
];

function sum(vals: Array<number | null>): number | null {
  const nums = vals.filter((v): v is number => v !== null);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

function TeamCard({ team, rank, onOpen }: { team: number; rank: number | null; onOpen: () => void }) {
  const [nickname, setNickname] = useState<string | null>(null);
  useEffect(() => {
    fetchTBATeamInfo(team).then((d) => {
      if (d && typeof d === "object") setNickname((d as { nickname?: string }).nickname ?? null);
    }).catch(() => {});
  }, [team]);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left hover:border-primary/50 hover:bg-muted/30 active:scale-[0.99] transition"
    >
      <TeamAvatar teamNumber={team} size={36} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className={`font-bold ${team === MY_TEAM ? "text-primary" : ""}`}>{team}</span>
          {rank !== null && <span className="text-[11px] font-mono text-muted-foreground">#{rank}</span>}
        </div>
        <p className="text-xs text-muted-foreground truncate">{nickname ?? "Open profile"}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground shrink-0" />
    </button>
  );
}

export default function AllianceDetailPanel({
  allianceNumber, teams, eventKey, onClose,
}: {
  allianceNumber: number;
  teams: number[];
  eventKey: string;
  onClose: () => void;
}) {
  const data = useEventTeamData(eventKey);
  const [tab, setTab] = useState("overview");
  const [openTeam, setOpenTeam] = useState<number | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && openTeam === null && !photo) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, openTeam, photo]);

  const rankOf = (t: number) => (data.tbaRankings[t] as { rank?: number } | undefined)?.rank ?? null;

  // One row per stat, one column per team: EPA, TBA score, then the match
  // form's numeric fields aggregated the same way as the team profile.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const [key, label] of EPA_ROWS) {
      const values = teams.map((t) => (data.epaMap[t] ?? EMPTY_TEAM_EPA)[key]);
      if (values.some((v) => v !== null)) out.push({ label, values, total: sum(values) });
    }
    const avg = teams.map((t) => data.avgScoreByTeam[t] ?? null);
    if (avg.some((v) => v !== null)) out.push({ label: "Avg qual score", values: avg, total: null });
    const statFields = data.fields.filter((f: FormField) => ["number", "counter", "rating", "checkbox"].includes(f.type));
    for (const f of statFields) {
      const values = teams.map((t) => {
        const reports = (data.submissionsByTeam[t] ?? []).map(parseSubData);
        const v = aggregateField(f, reports.map((d) => d[f.id])).sort;
        return typeof v === "number" ? v : null;
      });
      if (!values.some((v) => v !== null)) continue;
      const additive = f.type === "number" || f.type === "counter";
      out.push({
        label: f.label, values,
        total: additive ? sum(values) : null,
        suffix: f.type === "checkbox" ? "%" : undefined,
        lowerBetter: isLowerBetter(f.label),
      });
    }
    return out;
  }, [teams, data.epaMap, data.avgScoreByTeam, data.fields, data.submissionsByTeam]);

  // Spying reports filed on this alliance, newest first.
  const spyReports = useMemo(() => {
    const tplById = new Map(data.allTemplates.map((t) => [t._id, t]));
    const known = new Map<string, FormField>();
    for (const t of data.allTemplates) for (const f of t.fields) if (!known.has(f.id)) known.set(f.id, f);
    return (data.allSubmissions ?? [])
      .filter((s: EventSubmission) => s.teamNumber === 0 || tplById.get(s.templateId)?.formType === "spy")
      .map((s) => ({ s, d: parseSubData(s), tpl: tplById.get(s.templateId) }))
      .filter(({ d }) => Number(d._alliance) === allianceNumber)
      .sort((a, b) => (b.s.syncedAt ?? 0) - (a.s.syncedAt ?? 0))
      .map(({ s, d, tpl }) => ({
        s, d, name: tpl?.name ?? "Spying",
        fields: fieldsForData(tpl?.fields ?? [], d, known)
          .filter((f) => f.type !== "teamNumber" && !isEmptyValue(d[f.id])),
      }));
  }, [data.allSubmissions, data.allTemplates, allianceNumber]);

  const best = (r: Row) => {
    const nums = r.values.filter((v): v is number => v !== null);
    if (nums.length < 2) return null;
    return r.lowerBetter ? Math.min(...nums) : Math.max(...nums);
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="w-full max-w-2xl bg-background border-l border-border flex flex-col h-full overflow-hidden shadow-2xl animate-in slide-in-from-right duration-300">
        <div className="flex items-center gap-4 px-5 py-4 border-b border-border shrink-0">
          <div className="h-12 w-12 shrink-0 rounded-xl bg-primary/10 flex items-center justify-center text-lg font-bold text-primary">
            A{allianceNumber}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold">Alliance {allianceNumber}</h2>
            <p className="text-sm text-muted-foreground font-mono truncate">
              {teams.length ? teams.join("  ") : "Teams not selected yet"}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-5 mt-3 shrink-0 w-fit">
            <TabsTrigger value="overview" className="gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="reports" className="gap-1.5">
              <ClipboardList className="h-3.5 w-3.5" /> Spying Reports ({spyReports.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="flex-1 min-h-0 mt-0">
            <ScrollArea className="h-full">
              <div className="px-5 py-4 space-y-5 pb-8">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {teams.map((t) => (
                    <TeamCard key={t} team={t} rank={rankOf(t)} onOpen={() => setOpenTeam(t)} />
                  ))}
                </div>

                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No stats for these teams yet.</p>
                ) : (
                  <div>
                    <div className="overflow-x-auto rounded-xl border border-border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/30 text-xs text-muted-foreground">
                            <th className="text-left font-medium px-3 py-2">Stat</th>
                            {teams.map((t) => (
                              <th key={t} className={`text-right font-mono font-semibold px-3 py-2 ${t === MY_TEAM ? "text-primary" : "text-foreground"}`}>{t}</th>
                            ))}
                            <th className="text-right font-medium px-3 py-2">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => {
                            const b = best(r);
                            return (
                              <tr key={r.label} className="border-t border-border/60">
                                <td className="px-3 py-2 text-xs text-muted-foreground max-w-[10rem] truncate" title={r.label}>{r.label}</td>
                                {r.values.map((v, i) => (
                                  <td key={i} className={`px-3 py-2 text-right font-mono tabular-nums ${
                                    v === null ? "text-muted-foreground/40" : v === b ? "font-semibold text-foreground" : "text-muted-foreground"
                                  }`}>
                                    {v === null ? "-" : `${fmt(v)}${r.suffix ?? ""}`}
                                  </td>
                                ))}
                                <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">
                                  {r.total === null ? "" : fmt(r.total)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Best on the alliance in bold. Tap a team above for its full profile.
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="reports" className="flex-1 min-h-0 mt-0">
            <ScrollArea className="h-full">
              <div className="px-5 py-4 space-y-3 pb-8">
                {spyReports.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                    <ClipboardList className="h-8 w-8 opacity-30" />
                    <p className="text-sm">No spying reports on Alliance {allianceNumber} yet.</p>
                  </div>
                ) : spyReports.map(({ s, d, name, fields }) => (
                  <div key={s._id} className="border border-border rounded-xl overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/20">
                      <span className="font-bold text-sm">{name}</span>
                      {s.syncedAt && (
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(s.syncedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
                    <div className="px-4 py-3 bg-background/50">
                      {fields.length === 0
                        ? <p className="text-xs text-muted-foreground italic">No answers recorded.</p>
                        : <AnswerList fields={fields as Parameters<typeof AnswerList>[0]["fields"]} data={d} onPhoto={setPhoto} />}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>

      {photo && <PhotoLightbox src={photo} onClose={() => setPhoto(null)} />}

      {openTeam !== null && (
        <TeamDetailPanel
          key={openTeam}
          teamNumber={openTeam}
          eventKey={eventKey}
          eventYear={data.eventYear}
          submissions={data.submissionsByTeam[openTeam] ?? []}
          fields={data.fields}
          epa={data.epaMap[openTeam] ?? EMPTY_TEAM_EPA}
          avgScore={data.avgScoreByTeam[openTeam] ?? null}
          tbaRank={data.tbaRankings[openTeam] ?? null}
          pitSubmissions={data.pitSubmissionsByTeam[openTeam] ?? []}
          pitFields={data.pitFields}
          templates={data.allTemplates}
          epaByTeam={data.epaMap}
          avgScoreByTeam={data.avgScoreByTeam}
          submissionsByTeam={data.submissionsByTeam}
          onClose={() => setOpenTeam(null)}
        />
      )}
    </div>
  );
}
