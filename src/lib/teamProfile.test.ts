import { describe, expect, it } from "vitest";
import { isEmptyValue, isLowerBetter, isNoteField, latestPit, newestFirst, rankIn } from "./teamProfile";

const sub = (id: string, matchNumber: number, extra: Partial<{ compLevel: "qm" | "elim"; syncedAt: number }> = {}) => ({
  _id: id, templateId: "t", matchNumber, data: "{}", ...extra,
});

describe("rankIn", () => {
  it("ranks higher values first and shares ranks on ties", () => {
    const vals = { 1: 50, 2: 40, 3: 40, 4: 10, 5: null };
    expect(rankIn(vals, 1)).toEqual({ rank: 1, total: 4 });
    expect(rankIn(vals, 3)).toEqual({ rank: 2, total: 4 });
    expect(rankIn(vals, 4)).toEqual({ rank: 4, total: 4 });
  });
  it("ranks lowest first for lower-is-better stats", () => {
    expect(rankIn({ 1: 0, 2: 0, 3: 4 }, 2, true)).toEqual({ rank: 1, total: 3 });
    expect(rankIn({ 1: 0, 2: 0, 3: 4 }, 3, true)).toEqual({ rank: 3, total: 3 });
  });
  it("returns null for a team without a value", () => {
    expect(rankIn({ 1: 5, 5: null }, 5)).toBeNull();
    expect(rankIn({ 1: 5 }, 99)).toBeNull();
  });
});

describe("isEmptyValue", () => {
  it("treats blanks as empty but keeps false and 0 as answers", () => {
    for (const v of [undefined, null, "", "   ", []]) expect(isEmptyValue(v)).toBe(true);
    for (const v of [false, 0, "x", ["a"]]) expect(isEmptyValue(v)).toBe(false);
  });
});

describe("isNoteField", () => {
  it("only text fields are notes", () => {
    expect(isNoteField("text")).toBe(true);
    expect(isNoteField("textarea")).toBe(true);
    expect(isNoteField("radio")).toBe(false);
    expect(isNoteField("photo")).toBe(false);
  });
});

describe("newestFirst", () => {
  it("puts later matches first, elims above quals, then latest sync", () => {
    const out = newestFirst([
      sub("q2", 2),
      sub("e1", 1, { compLevel: "elim" }),
      sub("q18-old", 18, { syncedAt: 1 }),
      sub("q18-new", 18, { syncedAt: 2 }),
    ]);
    expect(out.map((s) => s._id)).toEqual(["e1", "q18-new", "q18-old", "q2"]);
  });
});

describe("latestPit", () => {
  it("picks the most recent and falls back when it is deleted", () => {
    const old = { id: "old", syncedAt: 1 };
    const recent = { id: "new", syncedAt: 5 };
    expect(latestPit([old, recent])).toBe(recent);
    expect(latestPit([old])).toBe(old);
    expect(latestPit([])).toBeNull();
  });
});

describe("isLowerBetter", () => {
  it("flags stats a team wants less of", () => {
    for (const l of ["Teleop Pieces Missed", "Robot Died / Disabled", "Fouls", "Penalties"]) expect(isLowerBetter(l)).toBe(true);
    for (const l of ["Auto Pieces Scored", "Driver Skill", "Defense Played", "Left Starting Zone"]) expect(isLowerBetter(l)).toBe(false);
  });
});
