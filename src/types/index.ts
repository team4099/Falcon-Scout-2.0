// Shared TypeScript types across the app

export type FieldType = "text" | "number" | "checkbox" | "select" | "radio" | "counter" | "textarea" | "teamNumber" | "rating" | "photo";

/** "super" is shown as "Note Scout" — the stored value predates the rename and
 *  stays so templates and cached clients at an event keep working. */
export type FormType = "default" | "super" | "pit" | "spy";

/** The order form types are presented in everywhere. */
export const FORM_TYPE_ORDER: FormType[] = ["default", "pit", "super", "spy"];

export const FORM_TYPE_LABEL: Record<FormType, string> = {
  default: "Default",
  pit: "Pit Scout",
  super: "Note Scout",
  spy: "Spying",
};

/** Field types that pick one answer from `options`. */
export function hasChoiceOptions(t: FieldType): boolean {
  return t === "select" || t === "radio";
}

/** Sort key for a template's `formType` (missing/unknown → treated as default). */
export function formTypeRank(t: string | undefined): number {
  const i = FORM_TYPE_ORDER.indexOf((t ?? "default") as FormType);
  return i === -1 ? 0 : i;
}

/** Form Builder sidebar order: the admin's drag order first, then forms nobody
 *  has placed yet (by type, oldest first). */
export function sortForms<T extends { sortOrder?: number; formType?: string; _creationTime: number }>(forms: T[]): T[] {
  return [...forms].sort((a, b) =>
    (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) ||
    formTypeRank(a.formType) - formTypeRank(b.formType) ||
    a._creationTime - b._creationTime
  );
}

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  required: boolean;
  options?: string[];    // for select/radio fields; rating fields use options[0] as max (default "5")
  section?: string;
  showInRankings?: boolean; // offered as a hidden-by-default Dashboard rankings column
}

export interface FormTemplate {
  _id: string;
  name: string;
  description?: string;
  formType?: FormType;
  fields: FormField[];
  isActive: boolean;
}

export interface FormSubmission {
  _id: string;
  templateId: string;
  eventKey: string;
  matchNumber: number;
  teamNumber: number;
  scoutId?: string;
  data: string;
  syncedAt: number;
}

export type FormData = Record<string, string | number | boolean>;

export interface KanbanColumn {
  id: string;
  title: string;
  color?: string;
}

export interface KanbanCard {
  _id: string;
  boardId: string;
  columnId: string;
  teamNumber: number;
  eventKey: string;
  notes?: string;
  position: number;
  _creationTime?: number;
}

// Statbotics EPA data shape
export interface TeamEPA {
  team: number;
  epa: {
    mean: number;
    sd: number;
  };
  record?: {
    wins: number;
    losses: number;
    ties: number;
  };
}

// TBA simplified team info
export interface TBATeam {
  team_number: number;
  nickname: string;
  city?: string;
  state_prov?: string;
}

export interface TBAEventRanking {
  team_key: string;
  rank: number;
  dq: number;
  record: { wins: number; losses: number; ties: number };
}
