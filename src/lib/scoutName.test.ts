import { describe, expect, it } from "vitest";
import { scoutLabel } from "./scoutName";

describe("scoutLabel", () => {
  it("prefers the nickname over the real name", () => {
    expect(scoutLabel({ nickname: "Charlie Z", name: "Charlie Zhao" })).toBe("Charlie Z");
  });

  it("falls back to the name, then the email, then the fallback", () => {
    expect(scoutLabel({ name: "Charlie Zhao", email: "c@team4099.com" })).toBe("Charlie Zhao");
    expect(scoutLabel({ email: "c@team4099.com" })).toBe("c@team4099.com");
    expect(scoutLabel({}, "Unknown Scout")).toBe("Unknown Scout");
    expect(scoutLabel({})).toBe("Scout");
  });

  it("treats an empty nickname as unset", () => {
    expect(scoutLabel({ nickname: "", name: "Charlie Zhao" })).toBe("Charlie Zhao");
  });
});
