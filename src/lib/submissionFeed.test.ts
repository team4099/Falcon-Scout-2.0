import { describe, expect, it } from "vitest";
import { filterFeed } from "./submissionFeed";

const subs = [
  { templateId: "match", matchNumber: 4, teamNumber: 4099, scoutId: "u1", syncedAt: 100 },
  { templateId: "pit", teamNumber: 118, scoutId: "u2", syncedAt: 300 },
  { templateId: "match", matchNumber: 40, teamNumber: 254, scoutId: "u2", syncedAt: 200 },
];
const names: Record<string, string> = { u1: "Alice", u2: "Bob" };
const forms: Record<string, string> = { match: "Match Scouting", pit: "Pit Scouting" };
const run = (templateId: string | null, query: string) =>
  filterFeed(subs, {
    templateId,
    query,
    scoutName: (id) => (id ? names[id] : "Unknown"),
    formName: (id) => forms[id],
  }).map((s) => s.syncedAt);

describe("filterFeed", () => {
  it("returns everything newest first", () => {
    expect(run(null, "")).toEqual([300, 200, 100]);
  });
  it("filters by form", () => {
    expect(run("match", "")).toEqual([200, 100]);
  });
  it("matches team/match numbers exactly, not as substrings", () => {
    expect(run(null, "4")).toEqual([100]);
    expect(run(null, "4099")).toEqual([100]);
  });
  it("matches scout and form names case-insensitively", () => {
    expect(run(null, "bob")).toEqual([300, 200]);
    expect(run(null, "PIT")).toEqual([300]);
  });
  it("combines form and query filters", () => {
    expect(run("match", "bob")).toEqual([200]);
  });
});
