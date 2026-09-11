import { describe, it, expect } from "vitest";
import { stripEmojis, matchKey, matchLabel, matchSortValue } from "@/lib/utils";

describe("stripEmojis", () => {
  // Regression: the character class used to end with the literal letters
  // `UPDOWN`, so every capital U/P/D/O/W/N was deleted from FalconBet market
  // titles, option labels and descriptions. These are the exact strings stored
  // in the dev deployment's bettingMarkets rows.
  it("keeps letters that share characters with the word UPDOWN", () => {
    expect(stripEmojis("⬆ Over 5 pts")).toBe("Over 5 pts");
    expect(stripEmojis("⬇ Under 5 pts")).toBe("Under 5 pts");
    expect(
      stripEmojis("Statbotics EPA predicts a ~5 pt margin. Will the final spread beat that?"),
    ).toBe("Statbotics EPA predicts a ~5 pt margin. Will the final spread beat that?");
    expect(stripEmojis("UPLOAD DOWNLOAD NOW")).toBe("UPLOAD DOWNLOAD NOW");
  });

  it("still strips the circle and arrow emojis it is meant to remove", () => {
    expect(stripEmojis("🔴 Red Alliance")).toBe("Red Alliance");
    expect(stripEmojis("🔵 Blue Alliance")).toBe("Blue Alliance");
    expect(stripEmojis("⚪ Tie")).toBe("Tie");
    expect(stripEmojis("🟢 Yes")).toBe("Yes");
  });

  it("collapses the whitespace a stripped emoji leaves behind", () => {
    expect(stripEmojis("Red 🔴 Alliance")).toBe("Red Alliance");
    expect(stripEmojis("  🔵  Blue  ")).toBe("Blue");
  });

  it("leaves text with no emojis untouched", () => {
    expect(stripEmojis("F1M1 — Match Winner")).toBe("F1M1 — Match Winner");
  });
});

describe("match identity helpers", () => {
  it("keeps quals and elims of the same number distinct", () => {
    expect(matchKey(5, "qm")).not.toBe(matchKey(5, "elim"));
    expect(matchSortValue(5, "elim")).toBeGreaterThan(matchSortValue(5, "qm"));
  });

  it("labels by comp level, falling back for legacy rows", () => {
    expect(matchLabel(12, "qm")).toBe("Q12");
    expect(matchLabel(3, "elim")).toBe("E3");
    expect(matchLabel(7, null)).toBe("7");
  });
});
