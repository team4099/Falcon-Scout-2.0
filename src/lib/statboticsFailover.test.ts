// Statbotics host failover: community mirror first, official API as standby.
//
// These assert on which host each call actually hits, because a silent failover
// is indistinguishable from normal operation until the mirror dies too — the
// whole reason the active host is surfaced in admin Settings.

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  fetchStatboticsTeamYear,
  fetchStatboticsEventTeams,
  getStatboticsHealth,
  checkStatboticsHosts,
  subscribeStatboticsHealth,
} from "./api";

const PRIMARY = "https://api.statbotics.io/v3";
const MIRROR = "https://statbotics-production.up.railway.app/v3";
const POPCORN = "https://api-statbotics.popcornpenguins.com/v3";

/** Records every URL fetched, replying per a host→handler map. */
function mockHosts(handlers: { primary?: () => Response; mirror?: () => Response; popcorn?: () => Response }) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const handler = url.startsWith(PRIMARY) ? handlers.primary
      : url.startsWith(POPCORN) ? handlers.popcorn : handlers.mirror;
    if (!handler) throw new TypeError("Failed to fetch");
    return handler();
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const ok = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number) => () => new Response("nope", { status });
const unreachable = undefined;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("statbotics host failover", () => {
  it("uses the mirror first, never touching the official API while it is healthy", async () => {
    const calls = mockHosts({ mirror: ok({ team: 4099, epa: {} }) });

    const data = await fetchStatboticsTeamYear(4099, 2026);

    expect(data).toEqual({ team: 4099, epa: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(MIRROR);
    expect(getStatboticsHealth().active).toBe("mirror");
  });

  it("falls back to the official API when the mirror errors", async () => {
    const calls = mockHosts({ mirror: fail(503), primary: ok({ team: 4099, epa: {} }) });

    const data = await fetchStatboticsTeamYear(4099, 2026);

    expect(data).toEqual({ team: 4099, epa: {} });
    expect(calls[0]).toContain(MIRROR);
    expect(calls[1]).toContain(PRIMARY);

    const health = getStatboticsHealth();
    expect(health.active).toBe("primary");
    expect(health.lastError).toMatchObject({ source: "mirror", status: 503 });
  });

  it("falls back when the mirror is unreachable entirely", async () => {
    const calls = mockHosts({ mirror: unreachable, primary: ok({ team: 4099, epa: {} }) });

    await fetchStatboticsTeamYear(4099, 2026);

    expect(calls[1]).toContain(PRIMARY);
    // status 0 distinguishes a network/CORS failure from an HTTP error.
    expect(getStatboticsHealth().lastError).toMatchObject({ source: "mirror", status: 0 });
  });

  it("stays on the official API for follow-up calls instead of retrying a dead mirror", async () => {
    mockHosts({ mirror: fail(503), primary: ok({ team: 4099, epa: {} }) });
    await fetchStatboticsTeamYear(4099, 2026);

    // Different team → different cache key, so this is a real second request.
    const calls = mockHosts({ mirror: fail(503), primary: ok({ team: 254, epa: {} }) });
    await fetchStatboticsTeamYear(254, 2026);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(PRIMARY);
  });

  it("retries the mirror once the stickiness window lapses", async () => {
    mockHosts({ mirror: fail(503), primary: ok({ team: 4099, epa: {} }) });
    await fetchStatboticsTeamYear(4099, 2026);
    expect(getStatboticsHealth().active).toBe("primary");

    // Six minutes later — past the 5-minute window.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);

    const calls = mockHosts({ mirror: ok({ team: 254, epa: {} }), primary: ok({}) });
    await fetchStatboticsTeamYear(254, 2026);

    expect(calls[0]).toContain(MIRROR);
    expect(getStatboticsHealth().active).toBe("mirror");
  });

  it("does not write an error-backoff entry until every host has failed", async () => {
    // A backoff written on the first failure would return stale data and the
    // second host would never be reached at all.
    mockHosts({ mirror: fail(500), primary: ok({ team: 4099, epa: {} }) });
    await fetchStatboticsTeamYear(4099, 2026);

    const backoff = Object.keys(localStorage).filter((k) => k.endsWith("__err"));
    expect(backoff).toEqual([]);
  });

  it("returns null and backs off when both hosts are down", async () => {
    mockHosts({ primary: fail(500), mirror: fail(502) });

    const data = await fetchStatboticsTeamYear(4099, 2026);

    expect(data).toBeNull();
    const backoff = Object.keys(localStorage).filter((k) => k.endsWith("__err"));
    expect(backoff).toHaveLength(1);
  });

  it("notifies subscribers when the active host changes", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeStatboticsHealth((h) => seen.push(h.active));

    mockHosts({ mirror: fail(503), primary: ok({ team: 4099, epa: {} }) });
    await fetchStatboticsTeamYear(4099, 2026);

    expect(seen).toContain("primary");
    unsubscribe();
  });
});

describe("popcornpenguins fallback", () => {
  it("is used when the mirror and the official API are both down", async () => {
    const calls = mockHosts({ mirror: fail(502), primary: fail(503), popcorn: ok({ team: 4099, epa: {} }) });

    const data = await fetchStatboticsTeamYear(4099, 2026);

    expect(data).toEqual({ team: 4099, epa: {} });
    expect(calls.map((c) => c.split("/v3")[0])).toEqual([
      MIRROR.split("/v3")[0], PRIMARY.split("/v3")[0], POPCORN.split("/v3")[0],
    ]);
    expect(getStatboticsHealth().active).toBe("popcorn");
  });

  it("is asked when the mirror answers with an empty list (event not synced)", async () => {
    mockHosts({ mirror: ok([]), primary: fail(500), popcorn: ok([{ team: 4099 }]) });

    const data = await fetchStatboticsEventTeams("2026vaale1");

    expect(data).toEqual([{ team: 4099 }]);
  });

  it("returns [] without an error-backoff when every host that answers is empty", async () => {
    mockHosts({ mirror: ok([]), primary: fail(500), popcorn: ok([]) });

    const data = await fetchStatboticsEventTeams("2026vaale1");

    expect(data).toEqual([]);
    expect(Object.keys(localStorage).filter((k) => k.endsWith("__err"))).toEqual([]);
  });
});

describe("checkStatboticsHosts", () => {
  it("switches back to the mirror when it has recovered", async () => {
    mockHosts({ mirror: fail(503), primary: ok({}) });
    await fetchStatboticsTeamYear(4099, 2026);
    expect(getStatboticsHealth().active).toBe("primary");

    mockHosts({ primary: ok({}), mirror: ok({}), popcorn: ok({}) });
    const result = await checkStatboticsHosts();

    expect(result).toEqual({ primary: true, mirror: true, popcorn: true });
    expect(getStatboticsHealth().active).toBe("mirror");
    expect(getStatboticsHealth().lastError).toBeNull();
  });

  it("reports both hosts down without claiming a healthy source", async () => {
    mockHosts({ primary: fail(500), mirror: unreachable });

    const result = await checkStatboticsHosts();

    expect(result).toEqual({ primary: false, mirror: false, popcorn: false });
  });
});
