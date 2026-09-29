// Column model for the Dashboard rankings table: fixed built-in columns plus
// any form fields an admin tagged `showInRankings` in the form builder.
import type { FormField } from "@/types";
import type { TeamEpa } from "@/lib/epa";

export interface RankingColumn {
  id: string;
  label: string;
  /** Grid min width in px — the same value drives header and row cells. */
  width: number;
  defaultVisible: boolean;
  sortable: boolean;
  /** Picker grouping: built-in stats vs. tagged form fields (by form name). */
  group: string;
}

export const REPORTS_COLUMN_ID = "reports";

export const BUILTIN_COLUMNS: RankingColumn[] = [
  { id: "rank",       label: "Rank",       width: 56, defaultVisible: true, sortable: true, group: "Stats" },
  { id: "avgScore",   label: "Avg Score",  width: 72, defaultVisible: true, sortable: true, group: "Stats" },
  { id: "epaEvent",   label: "Event EPA",  width: 72, defaultVisible: true, sortable: true, group: "Stats" },
  { id: "epaOverall", label: "Season EPA", width: 84, defaultVisible: true, sortable: true, group: "Stats" },
  { id: "epaAuto",    label: "Auto",       width: 48, defaultVisible: true, sortable: true, group: "Stats" },
  { id: "epaTeleop",  label: "Teleop",     width: 56, defaultVisible: true, sortable: true, group: "Stats" },
  { id: "epaEndgame", label: "Endgame",    width: 64, defaultVisible: true, sortable: true, group: "Stats" },
  { id: REPORTS_COLUMN_ID, label: "Scouting Reports", width: 72, defaultVisible: true, sortable: false, group: "Stats" },
];

export function fieldColumnId(templateId: string, fieldId: string): string {
  return `f:${templateId}:${fieldId}`;
}

/** Tagged fields become columns, hidden until a viewer turns them on. Spying
 *  submissions carry no team number, so spy forms can't feed a team row. */
export function taggedFieldColumns(
  templates: Array<{ _id: string; name: string; formType?: string; fields: FormField[] }>
): Array<RankingColumn & { templateId: string; field: FormField }> {
  return templates
    .filter((t) => t.formType !== "spy")
    .flatMap((t) =>
      t.fields
        .filter((f) => f.showInRankings && f.type !== "photo" && f.type !== "teamNumber")
        .map((f) => ({
          id: fieldColumnId(t._id, f.id),
          label: f.label,
          width: 96,
          defaultVisible: false,
          sortable: true,
          group: t.name,
          templateId: t._id,
          field: f,
        }))
    );
}

export function visibleColumns<C extends RankingColumn>(
  columns: C[],
  overrides: Record<string, boolean>
): C[] {
  // Scouting reports always sit last, next to the row's hide button.
  const shown = columns.filter((c) => overrides[c.id] ?? c.defaultVisible);
  return [...shown.filter((c) => c.id !== REPORTS_COLUMN_ID), ...shown.filter((c) => c.id === REPORTS_COLUMN_ID)];
}

export interface FieldCell {
  display: string;
  sort: number | string | null;
}

const EMPTY_CELL: FieldCell = { display: "—", sort: null };

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * One team's value for a tagged field across its submissions, oldest first.
 * Numbers → average, checkbox → % yes, choices → most common answer,
 * free text → the latest note.
 */
export function aggregateField(field: FormField, values: unknown[]): FieldCell {
  const present = values.filter((v) => v !== undefined && v !== null && String(v).trim() !== "");
  if (present.length === 0) return EMPTY_CELL;

  switch (field.type) {
    case "number":
    case "counter":
    case "rating": {
      const nums = present.map(Number).filter(Number.isFinite);
      if (nums.length === 0) return EMPTY_CELL;
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      return { display: fmt(avg), sort: avg };
    }
    case "checkbox": {
      const yes = present.filter((v) => v === true || v === "true").length;
      const pct = Math.round((100 * yes) / present.length);
      return { display: `${pct}%`, sort: pct };
    }
    case "text":
    case "textarea": {
      const last = String(present[present.length - 1]).trim();
      return { display: last, sort: last.toLowerCase() };
    }
    default: {
      const counts = new Map<string, number>();
      for (const v of present) {
        const k = String(v);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let best = "";
      let bestN = 0;
      for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
      return { display: best, sort: best.toLowerCase() };
    }
  }
}

// ── Picklist cards ───────────────────────────────────────────────────────────
// The picklist offers the same options as the rankings Columns menu, with a
// shorter default set so a card stays readable.

export const PICKLIST_DEFAULT_COLUMNS = new Set(["rank", "epaEvent", "epaOverall", REPORTS_COLUMN_ID]);

/** Same columns, but visible by default only when listed in `on`. */
export function withDefaults<C extends RankingColumn>(columns: C[], on: Set<string>): C[] {
  return columns.map((c) => ({ ...c, defaultVisible: on.has(c.id) }));
}

export interface TeamStats {
  rank: number | null;
  avgScore: number | null;
  epa: TeamEpa;
  reportCount: number;
  fieldCells: Record<string, FieldCell>;
}

export interface StatCell {
  display: string;
  /** No data yet: rendered muted. */
  empty: boolean;
  /** EPA totals get the accent color, as on the Dashboard. */
  accent: boolean;
}

export const EPA_KEYS: Record<string, keyof TeamEpa> = {
  epaEvent: "event",
  epaOverall: "overall",
  epaAuto: "auto",
  epaTeleop: "teleop",
  epaEndgame: "endgame",
};

/** One team's value for any built-in or tagged-field column. */
export function statCell(id: string, t: TeamStats): StatCell {
  const cell = (v: string | null, accent = false): StatCell =>
    v === null ? { display: "—", empty: true, accent: false } : { display: v, empty: false, accent };
  if (id === "rank") return cell(t.rank !== null ? `#${t.rank}` : null);
  if (id === "avgScore") return cell(t.avgScore !== null ? String(Math.round(t.avgScore)) : null);
  if (id === REPORTS_COLUMN_ID) return cell(t.reportCount > 0 ? String(t.reportCount) : null);
  const epaKey = EPA_KEYS[id];
  if (epaKey) {
    const v = t.epa[epaKey];
    return cell(v !== null ? fmt(v) : null, id === "epaEvent" || id === "epaOverall");
  }
  const f = t.fieldCells[id];
  return cell(f && f.sort !== null ? f.display : null);
}

/** Short header for a picklist card / list column. */
export function columnShortLabel(c: RankingColumn): string {
  return c.id === REPORTS_COLUMN_ID ? "Reports" : c.label;
}
