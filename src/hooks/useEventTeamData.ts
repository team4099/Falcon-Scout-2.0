// Per-event team data shared by the Dashboard rankings and the Picklist:
// Convex submissions/templates plus TBA + Statbotics stats, seeded from the
// stale localStorage copy so both pages render instantly (and offline).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useCached } from "@/hooks/useCached";
import {
  fetchStatboticsEventTeams,
  fetchStatboticsTeamYear,
  fetchTBAEventTeams,
  fetchTBAEventRankings,
  fetchTBAEventMatches,
  getCacheError,
  clearCacheErrKey,
  clearCacheKey,
  statboticsEventTeamsCacheKey,
  getStatboticsHealth,
  statboticsHostLabel,
} from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import { parseEpaComponents, totalEpa } from "@/lib/epa";
import type { TeamEpa } from "@/lib/epa";
import { aggregateField, taggedFieldColumns } from "@/lib/rankingColumns";
import type { FieldCell } from "@/lib/rankingColumns";
import type { FormField } from "@/types";
import { lsGetStale, lsSet, TTL } from "@/lib/persistentCache";

export interface EventSubmission {
  _id: string;
  templateId: string;
  teamNumber: number;
  matchNumber: number;
  compLevel?: "qm" | "elim";
  scoutId?: string;
  syncedAt?: number;
  data: string; // JSON string
}

export interface EventTemplate {
  _id: string;
  name: string;
  formType?: string;
  fields: FormField[];
}

/** How many statbotics season-EPA requests to have in flight at once. Their
 *  API docs ask consumers not to hammer the servers. */
const SB_FETCH_CONCURRENCY = 6;

export function useEventTeamData(
  eventKey: string,
  /** Called with the event roster whenever TBA returns a fresh one. */
  onFreshRoster?: (teamNumbers: number[]) => void,
) {
  const eventYear = eventKey ? Number(eventKey.slice(0, 4)) : new Date().getFullYear();

  const allSubmissionsLive = useQuery(api.forms.listSubmissions, eventKey ? { eventKey } : "skip");
  const allSubmissions = useCached(allSubmissionsLive, `submissions_${eventKey}`) as EventSubmission[] | undefined;

  const activeTemplatesLive = useQuery(api.forms.listActiveTemplates);
  const activeTemplates = useCached(activeTemplatesLive, "active_templates") as EventTemplate[] | undefined;
  const fields: FormField[] = useMemo(() => {
    if (!activeTemplates) return [];
    const defaultTpl = activeTemplates.find((t) => (t.formType ?? "default") === "default");
    return (defaultTpl ?? activeTemplates[0])?.fields ?? [];
  }, [activeTemplates]);

  const pitTemplate = useMemo(
    () => activeTemplates?.find((t) => t.formType === "pit") ?? null,
    [activeTemplates],
  );
  const pitFields: FormField[] = pitTemplate?.fields ?? [];

  // Every live template (incl. inactive): the team panel renders each report
  // with its own form, and a pit report from a retired pit form is still a pit
  // report rather than a match report.
  const allTemplatesLive = useQuery(api.forms.listTemplates);
  const allTemplatesCached = useCached(allTemplatesLive, "all_templates");
  const allTemplates = useMemo(
    () => (allTemplatesCached ?? activeTemplates ?? []) as EventTemplate[],
    [allTemplatesCached, activeTemplates],
  );
  const pitTemplateIds = useMemo(() => {
    const ids = new Set(allTemplates.filter((t) => t.formType === "pit").map((t) => t._id));
    if (pitTemplate) ids.add(pitTemplate._id);
    return ids;
  }, [allTemplates, pitTemplate]);

  // ── External (TBA / Statbotics), seeded from stale localStorage ───────────
  const [sbTeams, setSbTeams] = useState<Record<number, Record<string, unknown>>>(
    () => lsGetStale(`dash_sbTeams_${eventKey}`) ?? {},
  );
  const [sbOverall, setSbOverall] = useState<Record<number, number>>(
    () => lsGetStale(`dash_sbOverall_${eventKey}`) ?? {},
  );
  const [tbaTeams, setTbaTeams] = useState<number[]>(() => lsGetStale(`dash_tbaTeams_${eventKey}`) ?? []);
  const [tbaRankings, setTbaRankings] = useState<Record<number, Record<string, unknown>>>(
    () => lsGetStale(`dash_tbaRankings_${eventKey}`) ?? {},
  );
  const [avgScoreByTeam, setAvgScoreByTeam] = useState<Record<number, number>>(
    () => lsGetStale(`dash_avgScore_${eventKey}`) ?? {},
  );
  const [matchData, setMatchData] = useState<TBAMatch[]>(
    // `tba_matches_full_` is the key fetchTBAEventMatches itself writes.
    () => lsGetStale<TBAMatch[]>(`dash_matches_${eventKey}`) ?? lsGetStale<TBAMatch[]>(`tba_matches_full_${eventKey}`) ?? [],
  );
  const [loadingExternal, setLoadingExternal] = useState(true);
  // Non-null when the statbotics EPA fetch failed upstream, so empty EPA
  // values can explain themselves instead of looking like an app bug.
  const [sbError, setSbError] = useState<{ status: number } | null>(null);
  // Non-null when the hosts that answered have no rows for this event: Season
  // EPA still loads, so the blank event columns need their own explanation.
  // `downHost` names a host that failed on the way, which may be the only one
  // carrying the event.
  const [sbNoData, setSbNoData] = useState<{ downHost: string | null } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const seededEventKeyRef = useRef(eventKey);
  const onFreshRosterRef = useRef(onFreshRoster);
  useEffect(() => { onFreshRosterRef.current = onFreshRoster; });

  // Re-seed when the event changes (e.g. switched in Settings).
  useEffect(() => {
    if (!eventKey || seededEventKeyRef.current === eventKey) return;
    seededEventKeyRef.current = eventKey;
    setSbTeams(lsGetStale(`dash_sbTeams_${eventKey}`) ?? {});
    setSbOverall(lsGetStale(`dash_sbOverall_${eventKey}`) ?? {});
    setTbaTeams(lsGetStale(`dash_tbaTeams_${eventKey}`) ?? []);
    setTbaRankings(lsGetStale(`dash_tbaRankings_${eventKey}`) ?? {});
    setAvgScoreByTeam(lsGetStale(`dash_avgScore_${eventKey}`) ?? {});
    setMatchData(lsGetStale<TBAMatch[]>(`dash_matches_${eventKey}`) ?? []);
  }, [eventKey]);

  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    setLoadingExternal(true);

    async function loadExternal() {
      const [sbData, tbaTeamData, tbaRankData, matches] = await Promise.all([
        fetchStatboticsEventTeams(eventKey),
        fetchTBAEventTeams(eventKey),
        fetchTBAEventRankings(eventKey),
        fetchTBAEventMatches(eventKey),
      ]);
      if (cancelled) return;

      // An empty array is a real answer ("no rows for this event yet"); null
      // means the request failed. Surface the upstream error either way.
      const sbErr = getCacheError(statboticsEventTeamsCacheKey(eventKey));
      setSbError(!Array.isArray(sbData) || sbData.length === 0 ? sbErr : null);
      if (Array.isArray(sbData) && sbData.length === 0 && !sbErr) {
        const e = getStatboticsHealth().lastError;
        const recent = e !== null && Date.now() - e.at < TTL.SHORT;
        setSbNoData({ downHost: recent ? statboticsHostLabel(e.source) : null });
      } else {
        setSbNoData(null);
      }

      if (Array.isArray(sbData) && sbData.length > 0) {
        const map: Record<number, Record<string, unknown>> = {};
        for (const t of sbData as Array<{ team: number } & Record<string, unknown>>) map[t.team] = t;
        setSbTeams(map);
        lsSet(`dash_sbTeams_${eventKey}`, map, TTL.SHORT);
      }

      if (Array.isArray(tbaTeamData)) {
        const nums = (tbaTeamData as Array<{ team_number: number }>).map((t) => t.team_number);
        setTbaTeams(nums);
        lsSet(`dash_tbaTeams_${eventKey}`, nums, TTL.MEDIUM);
        onFreshRosterRef.current?.(nums);

        // Season EPA per roster team (not per Statbotics event row: those
        // don't exist until the event is processed). /team_years caps at
        // 1000 rows, so fetch per team, a few at a time.
        void (async () => {
          const overall: Record<number, number> = {};
          for (let i = 0; i < nums.length; i += SB_FETCH_CONCURRENCY) {
            if (cancelled) return;
            const results = await Promise.all(
              nums.slice(i, i + SB_FETCH_CONCURRENCY).map((team) =>
                fetchStatboticsTeamYear(team, eventYear).catch(() => null),
              ),
            );
            for (const d of results) {
              if (!d || typeof d !== "object") continue;
              const v = totalEpa((d as { epa?: unknown }).epa);
              if (v !== null) overall[(d as { team: number }).team] = v;
            }
          }
          if (cancelled) return;
          setSbOverall(overall);
          lsSet(`dash_sbOverall_${eventKey}`, overall, TTL.SHORT);
        })();
      }

      if (tbaRankData && typeof tbaRankData === "object" && "rankings" in tbaRankData) {
        const map: Record<number, Record<string, unknown>> = {};
        for (const r of (tbaRankData as { rankings: Array<{ team_key: string } & Record<string, unknown>> }).rankings) {
          map[Number(r.team_key.replace("frc", ""))] = r;
        }
        setTbaRankings(map);
        lsSet(`dash_tbaRankings_${eventKey}`, map, TTL.SHORT);
      }

      // Per-team average qual score from played TBA matches (score -1 = unplayed).
      if (Array.isArray(matches)) {
        const totals: Record<number, { sum: number; count: number }> = {};
        for (const match of matches as TBAMatch[]) {
          if (match.comp_level !== "qm") continue;
          for (const color of ["red", "blue"] as const) {
            const alliance = match.alliances[color];
            if (!alliance || alliance.score < 0) continue;
            for (const teamKey of alliance.team_keys) {
              const num = Number(teamKey.replace("frc", ""));
              if (!num) continue;
              totals[num] ??= { sum: 0, count: 0 };
              totals[num].sum += alliance.score;
              totals[num].count += 1;
            }
          }
        }
        const avgMap: Record<number, number> = {};
        for (const [team, { sum, count }] of Object.entries(totals)) {
          if (count > 0) avgMap[Number(team)] = Math.round(sum / count);
        }
        setAvgScoreByTeam(avgMap);
        lsSet(`dash_avgScore_${eventKey}`, avgMap, TTL.SHORT);
        setMatchData(matches as TBAMatch[]);
        lsSet(`dash_matches_${eventKey}`, matches, TTL.SHORT);
      }
      if (!cancelled) setLoadingExternal(false);
    }

    loadExternal().catch(() => { if (!cancelled) setLoadingExternal(false); });
    return () => { cancelled = true; };
  }, [eventKey, eventYear, reloadNonce]);

  /** Retry after a Statbotics outage, skipping the 5-min error backoff. */
  function reloadExternal() {
    clearCacheErrKey(statboticsEventTeamsCacheKey(eventKey));
    // An empty answer is cached briefly; without this a retry just re-reads it.
    if (sbNoData) clearCacheKey(statboticsEventTeamsCacheKey(eventKey));
    setReloadNonce((n) => n + 1);
  }

  // Keyed off sbTeams ∪ sbOverall: before Statbotics processes an event,
  // sbTeams is empty but season EPA is already known.
  const epaMap = useMemo(() => {
    const map: Record<number, TeamEpa> = {};
    const teamNums = new Set([...Object.keys(sbTeams), ...Object.keys(sbOverall)].map(Number));
    for (const num of teamNums) {
      const sb = sbTeams[num];
      map[num] = { ...parseEpaComponents(sb && "epa" in sb ? sb.epa : null), overall: sbOverall[num] ?? null };
    }
    return map;
  }, [sbTeams, sbOverall]);

  // Match/note reports vs pit reports, per team. Spying (teamNumber 0) is neither.
  const { submissionsByTeam, pitSubmissionsByTeam } = useMemo(() => {
    const reports: Record<number, EventSubmission[]> = {};
    const pits: Record<number, EventSubmission[]> = {};
    for (const s of allSubmissions ?? []) {
      if (s.teamNumber === 0) continue;
      const bucket = pitTemplateIds.has(s.templateId) ? pits : reports;
      (bucket[s.teamNumber] ??= []).push(s);
    }
    return { submissionsByTeam: reports, pitSubmissionsByTeam: pits };
  }, [allSubmissions, pitTemplateIds]);

  // Form fields an admin tagged "Rankings column", and each team's aggregate
  // per tagged field (oldest match first, so "latest note" is the latest).
  const fieldColumns = useMemo(() => taggedFieldColumns(activeTemplates ?? []), [activeTemplates]);
  const fieldCellsByTeam = useMemo(() => {
    const out: Record<number, Record<string, FieldCell>> = {};
    if (fieldColumns.length === 0) return out;
    const byTeamTpl = new Map<string, Record<string, unknown>[]>();
    const subs = [...(allSubmissions ?? [])]
      .filter((s) => s.teamNumber > 0)
      .sort((a, b) => a.matchNumber - b.matchNumber || (a.syncedAt ?? 0) - (b.syncedAt ?? 0));
    for (const s of subs) {
      let data: Record<string, unknown>;
      try { data = JSON.parse(s.data) as Record<string, unknown>; } catch { continue; }
      const key = `${s.teamNumber}|${s.templateId}`;
      const list = byTeamTpl.get(key);
      if (list) list.push(data); else byTeamTpl.set(key, [data]);
    }
    for (const [key, rows] of byTeamTpl) {
      const [team, tpl] = key.split("|");
      for (const col of fieldColumns) {
        if (col.templateId !== tpl) continue;
        (out[Number(team)] ??= {})[col.id] = aggregateField(col.field, rows.map((d) => d[col.field.id]));
      }
    }
    return out;
  }, [allSubmissions, fieldColumns]);

  return {
    eventYear,
    allSubmissions,
    activeTemplates,
    allTemplates,
    fields,
    pitFields,
    tbaTeams,
    tbaRankings,
    avgScoreByTeam,
    matchData,
    loadingExternal,
    sbError,
    sbNoData,
    reloadExternal,
    epaMap,
    submissionsByTeam,
    pitSubmissionsByTeam,
    fieldColumns,
    fieldCellsByTeam,
  };
}

export type EventTeamData = ReturnType<typeof useEventTeamData>;
