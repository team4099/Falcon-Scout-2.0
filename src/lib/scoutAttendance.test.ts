import { describe, expect, it } from "vitest";
import { buildAttendance, teamAtPosition } from "./scoutAttendance";

const asg = (matchNumber: number, scoutId: string, position: "red1" | "blue2" = "red1") => ({
  matchNumber, matchLabel: `Q${matchNumber}`, position, scoutId,
});
const base = { matchTemplateIds: new Set(["m"]), playedQuals: new Set([1, 2]) };

describe("buildAttendance", () => {
  it("splits played assignments into submitted and missed", () => {
    const r = buildAttendance({
      ...base,
      assignments: [asg(1, "a"), asg(2, "a"), asg(3, "a")],
      submissions: [{ templateId: "m", matchNumber: 1, teamNumber: 254, scoutId: "a" }],
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ submitted: 1, missed: 1 });
    expect(r[0].matches.map((m) => m.matchNumber)).toEqual([1, 2]); // Q3 unplayed
  });

  it("ignores other scouts, non-match forms and elims", () => {
    const r = buildAttendance({
      ...base,
      assignments: [asg(1, "a")],
      submissions: [
        { templateId: "m", matchNumber: 1, teamNumber: 1, scoutId: "b" },
        { templateId: "pit", matchNumber: 1, teamNumber: 1, scoutId: "a" },
        { templateId: "m", matchNumber: 1, teamNumber: 1, scoutId: "a", compLevel: "elim" },
      ],
    });
    expect(r[0].missed).toBe(1);
  });

  it("matches on the assigned team when known", () => {
    const run = (team: number) =>
      buildAttendance({
        ...base,
        assignments: [asg(1, "a")],
        submissions: [{ templateId: "m", matchNumber: 1, teamNumber: team, scoutId: "a" }],
        teamFor: () => 254,
      })[0];
    expect(run(254).submitted).toBe(1);
    expect(run(118).missed).toBe(1);
  });
});

describe("teamAtPosition", () => {
  const al = { red: { team_keys: ["frc1", "frc2", "frc3"] }, blue: { team_keys: ["frc4", "frc5", "frc6"] } };
  it("maps positions", () => {
    expect(teamAtPosition(al, "red1")).toBe(1);
    expect(teamAtPosition(al, "blue2")).toBe(5);
    expect(teamAtPosition(undefined, "red1")).toBeNull();
  });
});
