import { describe, it, expect } from "vitest";
import { resolveBracket, allianceTeams, togglePrediction, FINALS } from "./bracket";
import type { TBAMatch } from "./api";

function m(level: "sf" | "f", set: number, num: number, win: "red" | "blue" | "" | null): TBAMatch {
  const played = win !== null;
  return {
    key: `2026test_${level}${set}m${num}`, comp_level: level, set_number: set, match_number: num,
    time: null, predicted_time: null, actual_time: null,
    winning_alliance: win ?? "",
    alliances: {
      red:  { team_keys: [], score: played ? (win === "red" ? 100 : 50) : -1 },
      blue: { team_keys: [], score: played ? (win === "blue" ? 100 : 50) : -1 },
    },
  };
}

describe("resolveBracket", () => {
  it("seeds round 1 and leaves later slots empty with no results", () => {
    const b = resolveBracket([], {});
    expect([b.slots[1].red, b.slots[1].blue]).toEqual([1, 8]);
    expect([b.slots[4].red, b.slots[4].blue]).toEqual([2, 7]);
    expect(b.slots[7].red).toBeNull();
    expect(b.champion).toBeNull();
  });

  it("moves winners up and losers down from actual results", () => {
    const b = resolveBracket([m("sf", 1, 1, "blue"), m("sf", 2, 1, "red")], {});
    expect(b.slots[1]).toMatchObject({ winner: 8, decidedBy: "actual", redScore: 50, blueScore: 100 });
    expect([b.slots[7].red, b.slots[7].blue]).toEqual([8, 4]);
    expect([b.slots[5].red, b.slots[5].blue]).toEqual([1, 5]);
  });

  it("ignores unplayed and tied games, using the replay", () => {
    const b = resolveBracket([m("sf", 1, 1, ""), m("sf", 1, 2, "red"), m("sf", 2, 1, null)], {});
    expect(b.slots[1].winner).toBe(1);
    expect(b.slots[2].winner).toBeNull();
  });

  it("applies predictions to undecided matches and chains them", () => {
    const b = resolveBracket([], { 1: 1, 2: 5, 7: 5 });
    expect(b.slots[7]).toMatchObject({ red: 1, blue: 5, winner: 5, decidedBy: "predicted" });
    expect([b.slots[11].red, b.slots[9].red]).toEqual([5, 1]);
    expect([b.slots[11].redProjected, b.slots[1].redProjected]).toEqual([true, false]);
    expect(b.corrected).toEqual([]);
  });

  it("corrects a prediction when the actual result eliminates the moved-up alliance", () => {
    // Viewer moved alliance 1 through M1 and M7; alliance 1 actually lost M1.
    const b = resolveBracket([m("sf", 1, 1, "blue")], { 1: 1, 7: 1, 2: 4 });
    expect(b.slots[1]).toMatchObject({ winner: 8, decidedBy: "actual" });
    expect(b.corrected.sort()).toEqual([1, 7]);
    expect(b.slots[7]).toMatchObject({ red: 8, blue: 4, winner: null });
  });

  it("marks predictions confirmed by results as settled", () => {
    const b = resolveBracket([m("sf", 1, 1, "red")], { 1: 1 });
    expect(b.settled).toEqual([1]);
    expect(b.corrected).toEqual([]);
  });

  it("decides the finals on 2 wins and crowns a champion", () => {
    // M11 is the upper final, M12 the lower one (matches real TBA sf numbering).
    const upper = [1, 2, 3, 4, 7, 8, 11].map((s) => m("sf", s, 1, "red"));
    const lower = [5, 6, 9, 10, 12, 13].map((s) => m("sf", s, 1, "blue"));
    const one = resolveBracket([...upper, ...lower, m("f", 1, 1, "blue")], {});
    expect([one.slots[FINALS].red, one.slots[FINALS].blue]).toEqual([1, 7]);
    expect(one.champion).toBeNull();
    expect([one.slots[FINALS].redScore, one.slots[FINALS].blueScore]).toEqual([0, 1]);
    const done = resolveBracket(
      [...upper, ...lower, m("f", 1, 1, "blue"), m("f", 1, 2, "red"), m("f", 1, 3, "red")], {});
    expect(done.champion).toBe(1);
    expect(done.slots[FINALS].games).toEqual([
      { red: 50, blue: 100 }, { red: 100, blue: 50 }, { red: 100, blue: 50 },
    ]);
  });
});

describe("real event regression", () => {
  it("2025chcmp: alliance 1 wins through the lower bracket", () => {
    // Winning sides of sf1-sf13 and f1m1-2 as played (TBA/Statbotics).
    const sides = "rrrrrrrrrbbrr".split("").map((c) => (c === "r" ? "red" : "blue") as "red" | "blue");
    const b = resolveBracket([
      ...sides.map((w, i) => m("sf", i + 1, 1, w)),
      m("f", 1, 1, "blue"), m("f", 1, 2, "blue"),
    ], {});
    expect([b.slots[11].red, b.slots[11].blue, b.slots[11].winner]).toEqual([1, 3, 3]);
    expect([b.slots[13].red, b.slots[13].blue]).toEqual([1, 8]);
    expect([b.slots[FINALS].red, b.slots[FINALS].blue]).toEqual([3, 1]);
    expect(b.champion).toBe(1);
  });
});

describe("helpers", () => {
  it("maps TBA alliances by name, falling back to order", () => {
    expect(allianceTeams([
      { name: "Alliance 3", picks: ["frc4099", "frc1"] },
      { name: null, picks: ["frc5"] },
    ])).toEqual({ 3: [4099, 1], 2: [5] });
    expect(allianceTeams(null)).toEqual({});
  });

  it("toggles predictions", () => {
    expect(togglePrediction({}, 3, 6)).toEqual({ 3: 6 });
    expect(togglePrediction({ 3: 6 }, 3, 6)).toEqual({});
    expect(togglePrediction({ 3: 6 }, 3, 3)).toEqual({ 3: 3 });
  });
});
