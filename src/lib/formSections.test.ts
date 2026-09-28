import { describe, expect, it } from "vitest";
import type { FormField } from "@/types";
import { moveFieldToSection, moveSection, orderFieldsBySection } from "./formSections";

const f = (id: string, section?: string): FormField =>
  ({ id, label: id, type: "text", required: false, section }) as FormField;
const ids = (fs: FormField[]) => fs.map((x) => `${x.id}:${x.section ?? "-"}`);

describe("moveSection", () => {
  it("swaps with the neighbour", () => {
    expect(moveSection(["A", "B", "C"], 2, -1)).toEqual(["A", "C", "B"]);
    expect(moveSection(["A", "B", "C"], 0, 1)).toEqual(["B", "A", "C"]);
  });
  it("is a no-op at the ends", () => {
    const s = ["A", "B"];
    expect(moveSection(s, 0, -1)).toBe(s);
    expect(moveSection(s, 1, 1)).toBe(s);
  });
});

describe("orderFieldsBySection", () => {
  it("groups by section order and keeps order within a section", () => {
    const fields = [f("a1", "A"), f("b1", "B"), f("a2", "A"), f("b2", "B")];
    expect(ids(orderFieldsBySection(fields, ["B", "A"]))).toEqual(["b1:B", "b2:B", "a1:A", "a2:A"]);
  });
  it("treats a missing section as the first section", () => {
    const fields = [f("b1", "B"), f("x")];
    expect(ids(orderFieldsBySection(fields, ["A", "B"]))).toEqual(["x:-", "b1:B"]);
  });
});

describe("moveFieldToSection", () => {
  const fields = [f("a1", "A"), f("a2", "A"), f("b1", "B"), f("b2", "B")];
  it("moves a field before the target field in another section", () => {
    expect(ids(moveFieldToSection(fields, ["A", "B"], "a1", "B", "b2")))
      .toEqual(["a2:A", "b1:B", "a1:B", "b2:B"]);
  });
  it("appends to the end of the section when there is no target field", () => {
    expect(ids(moveFieldToSection(fields, ["A", "B"], "b2", "A", null)))
      .toEqual(["a1:A", "a2:A", "b2:A", "b1:B"]);
  });
  it("appends to an empty section at the end", () => {
    expect(ids(moveFieldToSection(fields, ["A", "B", "C"], "a1", "C", null)))
      .toEqual(["a2:A", "b1:B", "b2:B", "a1:C"]);
  });
  it("ignores an unknown field", () => {
    expect(moveFieldToSection(fields, ["A", "B"], "zz", "A", null)).toBe(fields);
  });
});
