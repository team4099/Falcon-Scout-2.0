import type { FormField } from "@/types";

/** Section a field lives in; fields with no section belong to the first one. */
export function sectionOf(field: FormField, sections: string[]): string {
  return field.section ?? sections[0] ?? "General";
}

/**
 * Stable-sort fields into section order. The scout form (and the builder on
 * reload) orders sections by first appearance in the fields array, so this is
 * what makes a section reorder stick after save.
 */
export function orderFieldsBySection(fields: FormField[], sections: string[]): FormField[] {
  const rank = (f: FormField) => {
    const i = sections.indexOf(sectionOf(f, sections));
    return i === -1 ? sections.length : i;
  };
  return fields
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map(({ f }) => f);
}

/** Move the section at `index` one slot up (-1) or down (+1). No-op at the ends. */
export function moveSection(sections: string[], index: number, dir: -1 | 1): string[] {
  const to = index + dir;
  if (index < 0 || to < 0 || to >= sections.length) return sections;
  const next = [...sections];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/**
 * Move field `activeId` into `targetSection`, placed at `overId`'s position
 * (or at the end of the section when `overId` is null, e.g. an empty section).
 */
export function moveFieldToSection(
  fields: FormField[],
  sections: string[],
  activeId: string,
  targetSection: string,
  overId: string | null,
): FormField[] {
  const active = fields.find((f) => f.id === activeId);
  if (!active) return fields;
  const moved = { ...active, section: targetSection };
  const rest = fields.filter((f) => f.id !== activeId);
  let at = overId ? rest.findIndex((f) => f.id === overId) : -1;
  if (at === -1) {
    // After the last field already in the target section, else at the end.
    const lastInSection = rest.map((f) => sectionOf(f, sections)).lastIndexOf(targetSection);
    at = lastInSection === -1 ? rest.length : lastInSection + 1;
  }
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}
