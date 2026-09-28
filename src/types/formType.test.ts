import { describe, it, expect } from "vitest";
import { FORM_TYPE_ORDER, FORM_TYPE_LABEL, formTypeRank, hasChoiceOptions } from "./index";
import type { FormType } from "./index";

describe("form type ordering", () => {
  it("is match scouting → pit → note scout → spying", () => {
    expect(FORM_TYPE_ORDER).toEqual(["default", "pit", "super", "spy"]);
  });

  it("shows the stored \"super\" type as Note Scout", () => {
    expect(FORM_TYPE_LABEL.super).toBe("Note Scout");
    expect(FORM_TYPE_LABEL.spy).toBe("Spying");
  });

  it("treats dropdown and multiple choice as option-based fields", () => {
    expect(hasChoiceOptions("select")).toBe(true);
    expect(hasChoiceOptions("radio")).toBe(true);
    expect(hasChoiceOptions("text")).toBe(false);
  });

  it("ranks each known type by its position", () => {
    expect(formTypeRank("default")).toBe(0);
    expect(formTypeRank("pit")).toBe(1);
    expect(formTypeRank("super")).toBe(2);
    expect(formTypeRank("spy")).toBe(3);
  });

  it("treats a missing formType as default — older templates predate the field", () => {
    expect(formTypeRank(undefined)).toBe(0);
  });

  it("treats an unknown formType (e.g. legacy \"checklist\") as default rather than dropping it to the end", () => {
    expect(formTypeRank("something-new")).toBe(0);
  });

  it("sorts a mixed template list into the intended order", () => {
    const templates = [
      { name: "Spying", formType: "spy" },
      { name: "test form", formType: "super" },
      { name: "Pit Scout", formType: "pit" },
      { name: "Match Scouting", formType: undefined },
    ];
    const sorted = [...templates].sort(
      (a, b) => formTypeRank(a.formType) - formTypeRank(b.formType)
    );
    expect(sorted.map((t) => t.name)).toEqual([
      "Match Scouting",
      "Pit Scout",
      "test form",
      "Spying",
    ]);
  });

  it("validates a `form=` deep-link param the way ScoutMatchPage does", () => {
    const parse = (v: string | null) =>
      FORM_TYPE_ORDER.includes(v as FormType) ? (v as FormType) : null;
    expect(parse("pit")).toBe("pit");
    expect(parse("default")).toBe("default");
    expect(parse("bogus")).toBeNull();
    expect(parse(null)).toBeNull();
  });
});
