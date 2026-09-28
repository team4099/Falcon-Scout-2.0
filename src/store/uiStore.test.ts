import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "./uiStore";

const hidden = (eventKey: string) => useUIStore.getState().hiddenTeams[eventKey] ?? [];

describe("dashboard hidden teams", () => {
  beforeEach(() => useUIStore.setState({ hiddenTeams: {} }));

  it("hides and unhides a team per event without duplicates", () => {
    const { setTeamHidden } = useUIStore.getState();
    setTeamHidden("2026a", 254, true);
    setTeamHidden("2026a", 254, true);
    setTeamHidden("2026a", 1678, true);
    setTeamHidden("2026b", 254, true);
    expect(hidden("2026a")).toEqual([254, 1678]);
    setTeamHidden("2026a", 254, false);
    expect(hidden("2026a")).toEqual([1678]);
    expect(hidden("2026b")).toEqual([254]);
  });

  it("unhide all only clears the given event and is persisted", () => {
    const { setTeamHidden, unhideAllTeams } = useUIStore.getState();
    setTeamHidden("2026a", 254, true);
    setTeamHidden("2026b", 118, true);
    unhideAllTeams("2026a");
    expect(hidden("2026a")).toEqual([]);
    expect(hidden("2026b")).toEqual([118]);
    const stored = JSON.parse(localStorage.getItem("falconscout_ui") ?? "{}");
    expect(stored.state.hiddenTeams).toEqual({ "2026b": [118] });
  });
});
