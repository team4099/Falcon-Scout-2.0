import { describe, test, expect } from "vitest";
import { buildCompletion, isMatchDone, resolvePitDutyDone, EMPTY_COMPLETION } from "./scheduleCompletion";
import type { SubmissionKey } from "./scheduleCompletion";

function sub(p: Partial<SubmissionKey>): SubmissionKey {
  return {
    formType: "default",
    matchNumber: 1,
    compLevel: "qm",
    teamNumber: 4099,
    templateId: "tpl1",
    ...p,
  };
}

describe("buildCompletion", () => {
  test("a match submission marks that comp level + match + team done", () => {
    const c = buildCompletion([sub({ matchNumber: 26, teamNumber: 1731 })]);
    expect(isMatchDone(c, 26, "qm", 1731)).toBe(true);
  });

  test("scouting a different team in the same match does not tick the assignment", () => {
    const c = buildCompletion([sub({ matchNumber: 26, teamNumber: 1731 })]);
    expect(isMatchDone(c, 26, "qm", 9072)).toBe(false);
  });

  test("a qual submission does not tick the same-numbered elim match", () => {
    const c = buildCompletion([sub({ matchNumber: 5, compLevel: "qm", teamNumber: 449 })]);
    expect(isMatchDone(c, 5, "elim", 449)).toBe(false);
  });

  test("falls back to match-level matching when TBA has not given us a team yet", () => {
    const c = buildCompletion([sub({ matchNumber: 12, teamNumber: 449 })]);
    expect(isMatchDone(c, 12, "qm", null)).toBe(true);
    expect(isMatchDone(c, 13, "qm", null)).toBe(false);
  });

  test("legacy rows with no compLevel count as quals", () => {
    const c = buildCompletion([sub({ matchNumber: 7, compLevel: undefined, teamNumber: 449 })]);
    expect(isMatchDone(c, 7, "qm", 449)).toBe(true);
  });

  test("checklists are keyed by match and template, not by team", () => {
    const c = buildCompletion([
      sub({ formType: "checklist", matchNumber: 3, templateId: "cl1", teamNumber: 0 }),
    ]);
    expect(c.checklists.has("3-cl1")).toBe(true);
    expect(c.checklists.has("3-cl2")).toBe(false);
    expect(c.checklists.has("4-cl1")).toBe(false);
  });

  test("pit submissions are keyed by team only — they are not tied to a match", () => {
    const c = buildCompletion([
      sub({ formType: "pit", teamNumber: 9072, matchNumber: 0, templateId: "pit1" }),
    ]);
    expect(c.pitTeams.has(9072)).toBe(true);
    expect(c.pitTeams.has(449)).toBe(false);
  });

  test("a pit or checklist submission never ticks off a match assignment", () => {
    const c = buildCompletion([
      sub({ formType: "pit", matchNumber: 8, teamNumber: 449 }),
      sub({ formType: "checklist", matchNumber: 8, teamNumber: 449 }),
    ]);
    expect(isMatchDone(c, 8, "qm", 449)).toBe(false);
  });

  test("super scouting does not tick off a match scouting assignment", () => {
    const c = buildCompletion([sub({ formType: "super", matchNumber: 8, teamNumber: 449 })]);
    expect(isMatchDone(c, 8, "qm", 449)).toBe(false);
  });

  test("server and local rows merge, so an offline submit still counts", () => {
    const c = buildCompletion([
      sub({ matchNumber: 1, teamNumber: 449 }),   // synced from the server
      sub({ matchNumber: 2, teamNumber: 1731 }),  // still only in localStorage
    ]);
    expect(isMatchDone(c, 1, "qm", 449)).toBe(true);
    expect(isMatchDone(c, 2, "qm", 1731)).toBe(true);
  });

  test("nothing submitted means nothing is done", () => {
    expect(isMatchDone(EMPTY_COMPLETION, 1, "qm", 449)).toBe(false);
    expect(buildCompletion([]).pitTeams.size).toBe(0);
  });
});

describe("resolvePitDutyDone", () => {
  test("a synced check-in marks the rotation done", () => {
    expect(resolvePitDutyDone(["rot1"], []).has("rot1")).toBe(true);
  });

  test("a check-in still in the queue counts immediately, so offline works", () => {
    const done = resolvePitDutyDone([], [{ rotationId: "rot1", reported: true }]);
    expect(done.has("rot1")).toBe(true);
  });

  test("a queued undo beats the server row it has not yet deleted", () => {
    const done = resolvePitDutyDone(["rot1"], [{ rotationId: "rot1", reported: false }]);
    expect(done.has("rot1")).toBe(false);
  });

  test("rotations are independent of each other", () => {
    const done = resolvePitDutyDone(["rot1"], [{ rotationId: "rot2", reported: true }]);
    expect(done.has("rot1")).toBe(true);
    expect(done.has("rot2")).toBe(true);
    expect(done.has("rot3")).toBe(false);
  });

  test("nothing reported means nothing done", () => {
    expect(resolvePitDutyDone([], []).size).toBe(0);
  });
});
