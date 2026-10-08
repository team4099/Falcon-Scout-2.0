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
 * against the other. Description, coin reward, active state and the "Rankings
 * column" tag are settings, not format, so they are left out.
 */
export function formatKey(form: { name: string; formType?: string; fields: FormatField[] }): string {
  return JSON.stringify([
    form.name,
    form.formType ?? "default",
    form.fields.map((f) => [f.id, f.type, f.label, f.required, f.options ?? [], f.section ?? ""]),
  ]);
}
