import { describe, test, expect } from "vitest";
import { runTests, pitBlockedMatches } from "./scheduleGenerator";

describe("pitBlockedMatches", () => {
  const rots = [
    { startMatch: 6, endMatch: 8, scoutIds: ["a", "b"] },
    { startMatch: 20, endMatch: 21, scoutIds: ["c"] },
    { isElims: true, scoutIds: ["a"] },
  ];
  test("returns only the pinned scout's qual rotation matches", () => {
    expect([...pitBlockedMatches(rots, "a").entries()]).toEqual([[6, "Q6–Q8"], [7, "Q6–Q8"], [8, "Q6–Q8"]]);
  });
  test("no scout pinned blocks nothing", () => {
    expect(pitBlockedMatches(rots, null).size).toBe(0);
  });
});

describe("scheduleGenerator", () => {
  for (const result of runTests()) {
    test(result.name, () => {
      expect(result.passed, result.message).toBe(true);
    });
  }
});
