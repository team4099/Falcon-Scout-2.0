import { describe, expect, it } from "vitest";
import { findInEpa, parseEpaComponents, readMean, totalEpa } from "./epa";

// Fixtures mirror statbotics v3 `TeamEvent.to_dict` / `TeamYear.to_dict`
// (backend/src/db/models/team_event.py, team_year.py) with the 2026
// `key_to_name` breakdown names (backend/src/breakdown.py).

const teamEventEpa = {
  total_points: 45.23,
  unitless: 1620.5,
  norm: 1540.2,
  breakdown: {
    total_points: 45.23,
    auto_points: 12.34,
    teleop_points: 25.01,
    endgame_points: 7.88,
    energized_rp: 0.61,
    supercharged_rp: 0.44,
    traversal_rp: 0.28,
    tiebreaker_points: 3.2,
    auto_fuel: 5.5,
    auto_tower: 6.84,
    transition_fuel: 4.1,
    first_shift_fuel: 6.2,
    second_shift_fuel: 7.3,
    endgame_fuel: 2.4,
    endgame_tower: 5.48,
    teleop_fuel: 20.0,
    total_fuel: 25.5,
  },
  stats: { start: 30.0, pre_elim: 44.1, mean: 43.7, max: 51.2 },
};

const teamYearEpa = {
  total_points: 48.9,
  unitless: 1701.3,
  norm: 1588.0,
  breakdown: { ...teamEventEpa.breakdown, total_points: 48.9 },
  stats: { start: 28.0, pre_champs: 47.2, max: 55.6 },
  ranks: {
    // `ranks.total` is an OBJECT — the "total" key lookup must not latch onto it
    total: { rank: 42, percentile: 0.94, team_count: 3841 },
    country: { rank: 30, percentile: 0.95, team_count: 3200 },
    state: { rank: 4, percentile: 0.97, team_count: 120 },
    district: { rank: null, percentile: null, team_count: null },
  },
};

describe("readMean", () => {
  it("reads a bare float", () => expect(readMean(45.23)).toBe(45.2));
  it("reads a legacy {mean, sd} leaf", () =>
    expect(readMean({ mean: 12.36, sd: 2.1 })).toBe(12.4));
  it("rejects non-numeric input", () => {
    expect(readMean(null)).toBeNull();
    expect(readMean("45")).toBeNull();
    expect(readMean({ rank: 42 })).toBeNull();
  });
  it("rejects NaN and Infinity", () => {
    expect(readMean(NaN)).toBeNull();
    expect(readMean(Infinity)).toBeNull();
  });
});

describe("findInEpa", () => {
  it("finds a key nested under breakdown", () => {
    expect(findInEpa(teamEventEpa, "auto_points", "auto")).toBe(12.3);
    expect(findInEpa(teamEventEpa, "teleop_points", "teleop")).toBe(25.0);
    expect(findInEpa(teamEventEpa, "endgame_points", "endgame")).toBe(7.9);
  });

  it("prefers a shallow match over a deeper one", () => {
    // total_points exists at the top level AND inside breakdown
    expect(findInEpa(teamEventEpa, "total_points")).toBe(45.2);
  });

  it("skips object-valued keys and keeps searching", () => {
    // team_year has ranks.total = {rank,...}; "total" must not resolve to it
    expect(findInEpa(teamYearEpa, "total_points", "total")).toBe(48.9);
  });

  it("returns null for a key that does not exist", () => {
    expect(findInEpa(teamEventEpa, "nonexistent_points")).toBeNull();
  });

  it("tolerates non-object input", () => {
    expect(findInEpa(null, "auto_points")).toBeNull();
    expect(findInEpa(undefined, "auto_points")).toBeNull();
    expect(findInEpa(42, "auto_points")).toBeNull();
  });
});

describe("totalEpa", () => {
  it("reads event EPA from a team_event payload", () =>
    expect(totalEpa(teamEventEpa)).toBe(45.2));
  it("reads season EPA from a team_year payload", () =>
    expect(totalEpa(teamYearEpa)).toBe(48.9));
  it("falls back to a bare number", () => expect(totalEpa(50.57)).toBe(50.6));
  it("returns null when there is nothing to read", () =>
    expect(totalEpa({ stats: {} })).toBeNull());
});

describe("parseEpaComponents", () => {
  it("extracts every dashboard column from a real-shaped payload", () => {
    expect(parseEpaComponents(teamEventEpa)).toEqual({
      event: 45.2,
      auto: 12.3,
      teleop: 25.0,
      endgame: 7.9,
    });
  });

  it("returns all-null when statbotics is unavailable", () => {
    expect(parseEpaComponents(null)).toEqual({
      event: null,
      auto: null,
      teleop: null,
      endgame: null,
    });
  });

  it("handles a partial payload without throwing", () => {
    expect(parseEpaComponents({ total_points: 10 })).toEqual({
      event: 10,
      auto: null,
      teleop: null,
      endgame: null,
    });
  });
});
