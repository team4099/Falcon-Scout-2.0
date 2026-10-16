// What counts as "the format" of a form — shared by the server (which freezes
// a copy for past events before the format changes) and the Form Builder
// (which asks about the current event only when it would).

interface FormatField {
  id: string;
  type: string;
  label: string;
  required: boolean;
  options?: string[];
  section?: string;
}

/**
 * Equal for two forms exactly when a report filed with one reads the same
 * against the other. Descriptions (form and field), coin reward, active state and
 * the "Rankings column" tag are settings, not format, so they are left out.
 */
export function formatKey(form: { name: string; formType?: string; fields: FormatField[] }): string {
  return JSON.stringify([
    form.name,
    form.formType ?? "default",
    form.fields.map((f) => [f.id, f.type, f.label, f.required, f.options ?? [], f.section ?? ""]),
  ]);
}

// ── Synced fields ────────────────────────────────────────────────────────────
// A field copied into another form keeps its id, so answers from either form
// are stored under the same key and read as one field (Dashboard columns,
// charts). What a field asks is shared; where it sits and whether it's
// required or a rankings column stay per form.

/** Every form's pinned team-number field shares this id; it is never synced. */
export const AUTO_TEAM_FIELD_ID = "__auto_team__";

interface SyncField extends FormatField {
  description?: string;
}

/** `target` rewritten to ask what `source` asks. */
export function syncedCopy<F extends SyncField>(target: F, source: SyncField): F {
  const { options: _o, description: _d, ...rest } = target;
  return {
    ...rest,
    type: source.type,
    label: source.label,
    ...(source.options === undefined ? {} : { options: source.options }),
    ...(source.description === undefined ? {} : { description: source.description }),
  } as F;
}

/** Can this field be shared with another form? */
export function isSyncable(f: { id: string; type: string }): boolean {
  return f.id !== AUTO_TEAM_FIELD_ID && f.type !== "teamNumber";
}
