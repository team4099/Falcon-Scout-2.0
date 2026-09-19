// Statbotics host failover: official API first, community mirror as standby.
//
// These assert on which host each call actually hits, because a silent failover
// is indistinguishable from normal operation until the mirror dies too — the
// whole reason the active host is surfaced in admin Settings.

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  fetchStatboticsTeamYear,
  getStatboticsHealth,
  checkStatboticsHosts,
  subscribeStatboticsHealth,
} from "./api";

const PRIMARY = "https://api.statbotics.io/v3";
const MIRROR = "https://statbotics-production.up.railway.app/v3";

/** Records every URL fetched, replying per a host→handler map. */
function mockHosts(handlers: { primary?: () => Response; mirror?: () => Response }) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const handler = url.startsWith(PRIMARY) ? handlers.primary : handlers.mirror;
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
  it("uses the official API when it is healthy, never touching the mirror", async () => {
    const calls = mockHosts({ primary: ok({ team: 4099, epa: {} }) });

    const data = await fetchStatboticsTeamYear(4099, 2026);

    expect(data).toEqual({ team: 4099, epa: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(PRIMARY);
    expect(getStatboticsHealth().active).toBe("primary");
  });

  it("falls back to the mirror when the official API errors", async () => {
    const calls = mockHosts({ primary: fail(503), mirror: ok({ team: 4099, epa: {} }) });

    const data = await fetchStatboticsTeamYear(4099, 2026);

    expect(data).toEqual({ team: 4099, epa: {} });
    expect(calls[0]).toContain(PRIMARY);
    expect(calls[1]).toContain(MIRROR);

    const health = getStatboticsHealth();
    expect(health.active).toBe("mirror");
    expect(health.lastError).toMatchObject({ source: "primary", status: 503 });
  });

  it("falls back when the official API is unreachable entirely", async () => {
    const calls = mockHosts({ primary: unreachable, mirror: ok({ team: 4099, epa: {} }) });

    await fetchStatboticsTeamYear(4099, 2026);

    expect(calls[1]).toContain(MIRROR);
    // status 0 distinguishes a network/CORS failure from an HTTP error.
    expect(getStatboticsHealth().lastError).toMatchObject({ source: "primary", status: 0 });
  });

  it("sticks to the mirror for follow-up calls instead of retrying a dead host", async () => {
    mockHosts({ primary: fail(503), mirror: ok({ team: 4099, epa: {} }) });
    await fetchStatboticsTeamYear(4099, 2026);

    // Different team → different cache key, so this is a real second request.
    const calls = mockHosts({ primary: fail(503), mirror: ok({ team: 254, epa: {} }) });
    await fetchStatboticsTeamYear(254, 2026);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(MIRROR);
  });

  it("retries the official API once the stickiness window lapses", async () => {
    mockHosts({ primary: fail(503), mirror: ok({ team: 4099, epa: {} }) });
    await fetchStatboticsTeamYear(4099, 2026);
    expect(getStatboticsHealth().active).toBe("mirror");

    // Six minutes later — past the 5-minute window.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);

    const calls = mockHosts({ primary: ok({ team: 254, epa: {} }), mirror: ok({}) });
    await fetchStatboticsTeamYear(254, 2026);

    expect(calls[0]).toContain(PRIMARY);
    expect(getStatboticsHealth().active).toBe("primary");
  });

  it("does not write an error-backoff entry until every host has failed", async () => {
    // A backoff written on the first failure would return stale data and the
    // mirror would never be reached at all.
    mockHosts({ primary: fail(500), mirror: ok({ team: 4099, epa: {} }) });
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

    mockHosts({ primary: fail(503), mirror: ok({ team: 4099, epa: {} }) });
    await fetchStatboticsTeamYear(4099, 2026);

    expect(seen).toContain("mirror");
    unsubscribe();
  });
});

describe("checkStatboticsHosts", () => {
  it("switches back to the official API when it has recovered", async () => {
    mockHosts({ primary: fail(503), mirror: ok({}) });
    await fetchStatboticsTeamYear(4099, 2026);
    expect(getStatboticsHealth().active).toBe("mirror");

    mockHosts({ primary: ok({}), mirror: ok({}) });
    const result = await checkStatboticsHosts();

    expect(result).toEqual({ primary: true, mirror: true });
    expect(getStatboticsHealth().active).toBe("primary");
  });

  it("reports both hosts down without claiming a healthy source", async () => {
    mockHosts({ primary: fail(500), mirror: unreachable });

    const result = await checkStatboticsHosts();

    expect(result).toEqual({ primary: false, mirror: false });
  });
});
