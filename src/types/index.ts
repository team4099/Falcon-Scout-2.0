// Shared TypeScript types across the app

export type FieldType = "text" | "number" | "checkbox" | "select" | "counter" | "textarea" | "teamNumber" | "rating";

export type FormType = "default" | "super" | "pit" | "checklist";

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  required: boolean;
  options?: string[];    // for select fields; rating fields use options[0] as max (default "5")
  section?: string;
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
