import { describe, expect, it } from "vitest";
import type { FormField } from "@/types";
import {
  BUILTIN_COLUMNS,
  PICKLIST_DEFAULT_COLUMNS,
  aggregateField,
  statCell,
  withDefaults,
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

  it("always puts the scouting reports column last", () => {
    const tagged = { ...BUILTIN_COLUMNS[0], id: "f:m:a", defaultVisible: true };
    const ids = visibleColumns([...BUILTIN_COLUMNS, tagged], {}).map((c) => c.id);
    expect(ids[ids.length - 1]).toBe("reports");
    expect(ids).toContain("f:m:a");
  });
});

describe("picklist card stats", () => {
  const stats = {
    rank: 3,
    avgScore: 181.6,
    epa: { event: 40.54, overall: 39.3, auto: null, teleop: 21.5, endgame: 13.9 },
    reportCount: 6,
    fieldCells: { "f:m:a": { display: "2.8", sort: 2.8 }, "f:m:b": { display: "—", sort: null } },
  };

  it("defaults to a short set but offers every rankings column", () => {
    const cols = withDefaults(BUILTIN_COLUMNS, PICKLIST_DEFAULT_COLUMNS);
    expect(cols.map((c) => c.id)).toEqual(BUILTIN_COLUMNS.map((c) => c.id));
    expect(visibleColumns(cols, {}).map((c) => c.id)).toEqual(["rank", "epaEvent", "epaOverall", "reports"]);
    expect(visibleColumns(cols, { epaAuto: true, rank: false }).map((c) => c.id)).toContain("epaAuto");
  });

  it("formats built-ins, keeping season EPA distinct from event EPA", () => {
    expect(statCell("rank", stats).display).toBe("#3");
    expect(statCell("avgScore", stats).display).toBe("182");
    expect(statCell("epaEvent", stats)).toEqual({ display: "40.5", empty: false, accent: true });
    expect(statCell("epaOverall", stats).display).toBe("39.3");
    expect(statCell("epaTeleop", stats)).toEqual({ display: "21.5", empty: false, accent: false });
    expect(statCell("epaAuto", stats).empty).toBe(true);
    expect(statCell("reports", stats).display).toBe("6");
    expect(statCell("reports", { ...stats, reportCount: 0 }).empty).toBe(true);
  });

  it("shows tagged scouting fields and marks missing ones empty", () => {
    expect(statCell("f:m:a", stats).display).toBe("2.8");
    expect(statCell("f:m:b", stats).empty).toBe(true);
    expect(statCell("f:m:missing", stats).empty).toBe(true);
  });
});
