// Column model for the Dashboard rankings table: fixed built-in columns plus
// any form fields an admin tagged `showInRankings` in the form builder.
import type { FormField } from "@/types";

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
  { id: REPORTS_COLUMN_ID, label: "Scouting Reports", width: 120, defaultVisible: true, sortable: false, group: "Stats" },
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
  return columns.filter((c) => overrides[c.id] ?? c.defaultVisible);
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
