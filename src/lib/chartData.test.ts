import { describe, expect, it } from "vitest";
import {
  buildTimelines, chartMetrics, parseMatchKey, scatterValue, seasonTrend,
  slimStatboticsMatches, slimStatboticsTeamMatches, slimTbaMatch,
} from "./chartData";
import type { FieldColumn, SlimMatch } from "./chartData";
import type { TeamStats } from "./rankingColumns";
import type { FormField } from "@/types";

const EV = "2026test";

function col(id: string, type: FormField["type"], label = id): FieldColumn {
  return {
    id: `f:tpl:${id}`, label, width: 96, defaultVisible: false, sortable: true, group: "Match Scouting",
    templateId: "tpl", field: { id, type, label, required: false, showInRankings: true },
  };
}

const m = (k: string, red: number[], blue: number[], rs: number | null, bs: number | null, t: number | null = null): SlimMatch =>
  ({ k, t, red, blue, rs, bs });

describe("chartMetrics", () => {
  const cols = [col("driver", "rating", "Driver Ability"), col("notes", "textarea"), col("climb", "checkbox", "Climbed")];

  it("scatter offers every dashboard column that has a number, plus numeric tagged fields", () => {
    const ids = chartMetrics("scatter", cols).map((x) => x.id);
    expect(ids).toEqual([
      "rank", "avgScore", "epaEvent", "epaOverall", "epaAuto", "epaTeleop", "epaEndgame", "reports",
      "f:tpl:driver", "f:tpl:climb",
    ]);
    expect(chartMetrics("scatter", cols).find((x) => x.id === "f:tpl:climb")?.label).toBe("Climbed (% yes)");
  });

  it("line drops the columns with no per-match value", () => {
    const ids = chartMetrics("line", cols).map((x) => x.id);
    expect(ids).not.toContain("rank");
    expect(ids).not.toContain("reports");
    expect(ids).not.toContain("epaOverall");
    expect(ids).toContain("avgScore");
    expect(ids).toContain("f:tpl:driver");
  });
});

describe("scatterValue", () => {
  const t: TeamStats = {
    rank: 3, avgScore: 80, reportCount: 0,
    epa: { event: 40, overall: 42, auto: 10, teleop: 20, endgame: 10 },
    fieldCells: { "f:tpl:driver": { display: "4.5", sort: 4.5 }, "f:tpl:notes": { display: "x", sort: "x" } },
  };
  it("reads builtins, EPA, and numeric fields; text fields have no value", () => {
    expect(scatterValue("rank", t)).toBe(3);
    expect(scatterValue("epaOverall", t)).toBe(42);
    expect(scatterValue("reports", t)).toBe(0);
    expect(scatterValue("f:tpl:driver", t)).toBe(4.5);
    expect(scatterValue("f:tpl:notes", t)).toBeNull();
  });
});

describe("slimming", () => {
  it("TBA: unplayed scores are null, team keys become numbers", () => {
    const s = slimTbaMatch({
      key: `${EV}_qm1`, time: 5, predicted_time: null, actual_time: null,
      alliances: { red: { team_keys: ["frc1", "frc2"], score: -1 }, blue: { team_keys: ["frc3"], score: 50 } },
    });
    expect(s).toEqual({ k: `${EV}_qm1`, t: 5, red: [1, 2], blue: [3], rs: null, bs: 50 });
  });

  it("Statbotics matches + team_matches", () => {
    expect(slimStatboticsMatches([{
      key: `${EV}_f1m2`, time: 9, alliances: { red: { team_keys: [1] }, blue: { team_keys: [2] } },
      result: { red_score: 100, blue_score: 90 },
    }, { nope: 1 }])).toEqual([{ k: `${EV}_f1m2`, t: 9, red: [1], blue: [2], rs: 100, bs: 90 }]);
    expect(slimStatboticsTeamMatches([{
      team: 1, match: `${EV}_qm1`,
      epa: { total_points: 50.04, post: 51, breakdown: { total_points: 50.04, auto_points: 10, teleop_points: 30, endgame_points: 10.04 } },
    }])).toEqual([{ team: 1, k: `${EV}_qm1`, e: [50, 10, 30, 10] }]);
  });

  it("parses match keys", () => {
    expect(parseMatchKey(`${EV}_qm12`)).toEqual({ event: EV, level: "qm", set: 1, num: 12 });
    expect(parseMatchKey(`${EV}_sf3m1`)).toEqual({ event: EV, level: "sf", set: 3, num: 1 });
    expect(parseMatchKey("junk")).toBeNull();
  });
});

describe("buildTimelines", () => {
  const driver = col("driver", "rating");
  const sub = (team: number, matchNumber: number, driverVal: number, compLevel: "qm" | "elim" = "qm") =>
    ({ templateId: "tpl", teamNumber: team, matchNumber, compLevel, data: JSON.stringify({ driver: driverVal }) });

  it("event scope: scores, per-match EPA, and averaged scouting on a shared Q#/E# axis", () => {
    const out = buildTimelines({
      teams: [1],
      scope: "event",
      eventKey: EV,
      matches: [
        m(`${EV}_qm2`, [1], [2], 60, 40),
        m(`${EV}_qm1`, [2], [1], 30, 70),
        m(`${EV}_qm3`, [1], [2], null, null), // unplayed, unscouted → dropped
        m(`${EV}_f1m1`, [1], [2], 90, 80),
        m(`${EV}_sf2m1`, [2], [1], 50, 55),
        m(`other_qm1`, [1], [2], 999, 0),     // other event, out of scope
      ],
      teamMatches: [{ team: 1, k: `${EV}_qm1`, e: [45, 10, 25, 10] }],
      submissions: [sub(1, 1, 4), sub(1, 1, 2), sub(1, 2, 5), sub(1, 1, 3, "elim")],
      fieldColumns: [driver],
    })[1];

    expect(out.map((p) => p.label)).toEqual(["Q1", "Q2", "E1", "E2"]);
    expect(out.map((p) => p.order)).toEqual([1, 2, 100_001, 100_002]);
    expect(out[0].values).toEqual({ avgScore: 70, epaEvent: 45, epaAuto: 10, epaTeleop: 25, epaEndgame: 10, "f:tpl:driver": 3 });
    expect(out[1].values.avgScore).toBe(60);
    // Scout-entered E1 = the first playoff match in bracket order (sf2 before f1).
    expect(out[2]).toMatchObject({ key: `${EV}_sf2m1`, values: { avgScore: 55, "f:tpl:driver": 3 } });
    expect(out[3].values.avgScore).toBe(90);
  });

  it("keeps scouted matches TBA doesn't know about yet (offline)", () => {
    const out = buildTimelines({
      teams: [1], scope: "event", eventKey: EV, matches: [], teamMatches: [],
      submissions: [sub(1, 7, 4)], fieldColumns: [driver],
    })[1];
    expect(out).toEqual([{ key: `${EV}_qm7`, event: EV, label: "Q7", order: 7, values: { "f:tpl:driver": 4 } }]);
  });

  it("season scope: events in time order, 1-based index per team, other events' playoffs keep their names", () => {
    const out = buildTimelines({
      teams: [1],
      scope: "season",
      eventKey: EV,
      matches: [
        m(`${EV}_qm1`, [1], [2], 70, 30, 3000),
        m(`early_qm1`, [1], [2], 40, 30, 1000),
        m(`early_f1m2`, [1], [2], 55, 30, 1500),
      ],
      teamMatches: [],
      submissions: [],
      fieldColumns: [],
    })[1];
    expect(out.map((p) => [p.order, p.event, p.label])).toEqual([
      [1, "early", "Q1"], [2, "early", "F2"], [3, EV, "Q1"],
    ]);
  });

  it("season index counts only matches with the plotted metric", () => {
    const out = buildTimelines({
      teams: [1], scope: "season", eventKey: EV, metric: "epaEvent",
      matches: [m(`early_qm1`, [1], [2], 40, 30, 1000), m(`${EV}_qm1`, [1], [2], 70, 30, 3000)],
      teamMatches: [{ team: 1, k: `early_qm1`, e: [20, 5, 10, 5] }, { team: 1, k: `${EV}_qm1`, e: [25, 5, 15, 5] }],
      // A scouting entry for a match team 1 didn't play has no EPA: no slot.
      submissions: [sub(1, 9, 4)],
      fieldColumns: [driver],
    })[1];
    expect(out.map((p) => [p.order, p.key, p.values.epaEvent])).toEqual([
      [1, "early_qm1", 20], [2, `${EV}_qm1`, 25],
    ]);
  });
});

describe("seasonTrend", () => {
  const pts = buildTimelines({
    teams: [1], scope: "season", eventKey: EV,
    matches: [
      m(`${EV}_qm1`, [1], [2], 90, 30, 3000),
      m(`early_qm1`, [1], [2], 40, 30, 1000),
      m(`early_qm2`, [2], [1], 30, 60, 1100),
      m(`early_qm3`, [1], [2], null, null, 1200), // unplayed: no slot
    ],
    teamMatches: [{ team: 1, k: `early_qm2`, e: [20, 5, 10, 5] }, { team: 1, k: `${EV}_qm1`, e: [25, 5, 15, 5] }],
    submissions: [], fieldColumns: [],
  })[1];

  it("marks where each event starts, in play order", () => {
    const t = seasonTrend(pts, "avgScore");
    expect(t.rows.map((r) => [r.i, r.event, r.label, r.value])).toEqual([
      [1, "early", "Q1", 40], [2, "early", "Q2", 60], [3, EV, "Q1", 90],
    ]);
    expect(t.events).toEqual([{ event: "early", start: 1 }, { event: EV, start: 3 }]);
  });

  it("running average keeps each match's own score", () => {
    const t = seasonTrend(pts, "avgScore", true);
    expect(t.rows.map((r) => [r.value, r.score])).toEqual([[40, 40], [50, 60], [190 / 3, 90]]);
  });

  it("indexes only matches that have the metric", () => {
    const t = seasonTrend(pts, "epaEvent");
    expect(t.rows.map((r) => [r.i, r.value])).toEqual([[1, 20], [2, 25]]);
    expect(t.events).toEqual([{ event: "early", start: 2 - 1 }, { event: EV, start: 2 }]);
  });
});
