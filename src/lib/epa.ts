// Parsing helpers for Statbotics v3 EPA payloads.
//
// Shape reference (statbotics `TeamEvent.to_dict` / `TeamYear.to_dict`):
//   epa: {
//     total_points: 45.2,          // bare float, NOT {mean, sd}
//     unitless: 1620, norm: 1540,
//     breakdown: { total_points: 45.2, auto_points: 12.3,
//                  teleop_points: 25.0, endgame_points: 7.9, ... },
//     stats: { start, pre_elim, mean, max },
//     ranks: { total: { rank, percentile, team_count }, ... }   // team_year only
//   }
//
// The component names (`auto_points`, `teleop_points`, `endgame_points`) are
// year-scoped in statbotics' `key_to_name` table and live under `breakdown`,
// so lookups search recursively rather than assuming a flat object. Older
// payloads used `{mean, sd}` leaves, which `readMean` still accepts.

/** Extract a number from a bare float or a legacy `{mean, sd}` leaf. */
export function readMean(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Number(v.toFixed(1)) : null;
  if (v && typeof v === "object") {
    const mean = (v as Record<string, unknown>).mean;
    if (typeof mean === "number" && Number.isFinite(mean)) return Number(mean.toFixed(1));
  }
  return null;
}

/**
 * Recursively search an EPA object for the first of `keys` that resolves to a
 * number. Handles both flat (`epa.auto_points`) and nested
 * (`epa.breakdown.auto_points`) layouts.
 *
 * All requested keys are checked at the current depth before recursing, so a
 * shallow exact match always beats a deeper one.
 */
export function findInEpa(obj: unknown, ...keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const key of keys) {
    if (key in o) {
      const m = readMean(o[key]);
      if (m !== null) return m;
    }
  }
  for (const val of Object.values(o)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const found = findInEpa(val, ...keys);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Total (event or season) EPA. */
export function totalEpa(epaObj: unknown): number | null {
  return findInEpa(epaObj, "total_points", "total") ?? readMean(epaObj);
}

export interface TeamEpa {
  event: number | null;
  overall: number | null;
  auto: number | null;
  teleop: number | null;
  endgame: number | null;
}

export const EMPTY_TEAM_EPA: TeamEpa = {
  event: null,
  overall: null,
  auto: null,
  teleop: null,
  endgame: null,
};

/** Pull the component breakdown out of a statbotics `epa` object. */
export function parseEpaComponents(epaObj: unknown): Omit<TeamEpa, "overall"> {
  if (!epaObj || typeof epaObj !== "object") {
    return { event: null, auto: null, teleop: null, endgame: null };
  }
  return {
    event: totalEpa(epaObj),
    auto: findInEpa(epaObj, "auto_points", "auto"),
    teleop: findInEpa(epaObj, "teleop_points", "teleop"),
    endgame: findInEpa(epaObj, "endgame_points", "endgame"),
  };
}
