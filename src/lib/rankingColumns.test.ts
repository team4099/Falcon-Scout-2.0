import { describe, expect, it } from "vitest";
import type { FormField } from "@/types";
import {
  BUILTIN_COLUMNS,
  aggregateField,
  taggedFieldColumns,
  visibleColumns,
} from "./rankingColumns";

const f = (type: FormField["type"], extra: Partial<FormField> = {}): FormField => ({
  id: "x", type, label: "X", required: false, ...extra,
});

describe("aggregateField", () => {
  it("averages numeric fields and ignores blanks", () => {
    expect(aggregateField(f("counter"), [2, "", 5, undefined, "4"])).toEqual({ display: "3.7", sort: 11 / 3 });
  });
  it("reports checkbox yes-rate", () => {
    expect(aggregateField(f("checkbox"), [true, "true", false, false])).toEqual({ display: "50%", sort: 50 });
  });
  it("uses the most common choice", () => {
    expect(aggregateField(f("radio"), ["Low", "High", "High"]).display).toBe("High");
  });
  it("shows the latest text note", () => {
    expect(aggregateField(f("textarea"), ["old", "new", ""]).display).toBe("new");
  });
  it("is empty with no data", () => {
    expect(aggregateField(f("number"), [])).toEqual({ display: "—", sort: null });
  });
});

describe("taggedFieldColumns", () => {
  it("only offers tagged, aggregatable fields from team-based forms", () => {
    const cols = taggedFieldColumns([
      { _id: "m", name: "Match", formType: "default", fields: [
        f("counter", { id: "a", showInRankings: true }),
        f("counter", { id: "b" }),
        f("photo", { id: "c", showInRankings: true }),
      ] },
      { _id: "s", name: "Spy", formType: "spy", fields: [f("text", { id: "d", showInRankings: true })] },
    ]);
    expect(cols.map((c) => c.id)).toEqual(["f:m:a"]);
    expect(cols[0].defaultVisible).toBe(false);
  });
});

describe("visibleColumns", () => {
  it("applies overrides on top of defaults", () => {
    const tagged = { ...BUILTIN_COLUMNS[0], id: "f:m:a", defaultVisible: false };
    const ids = visibleColumns([...BUILTIN_COLUMNS, tagged], { rank: false, "f:m:a": true }).map((c) => c.id);
    expect(ids).not.toContain("rank");
    expect(ids).toContain("f:m:a");
    expect(ids).toContain("reports");
  });
});
