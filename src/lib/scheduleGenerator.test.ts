import { describe, test, expect } from "vitest";
import { runTests } from "./scheduleGenerator";

describe("scheduleGenerator", () => {
  for (const result of runTests()) {
    test(result.name, () => {
      expect(result.passed, result.message).toBe(true);
    });
  }
});
