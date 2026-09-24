/**
 * The TBA proxy (convex/tba.ts) is the only place the TBA key exists. These
 * cover: who may call it, that it can't be aimed at arbitrary TBA paths, that
 * the key is sent upstream but never returned, and that the legacy per-user
 * key stored in userSettings is no longer readable by clients.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "test-tba-secret-key";

async function setup() {
  const t = convexTest(schema, modules);
  const [scoutId, guestId] = await t.run(async (ctx) => [
    await ctx.db.insert("users", { name: "Scout", email: "scout@team4099.com" }),
    await ctx.db.insert("users", { name: "Guest", email: "guest@example.org" }),
  ]);
  return {
    t,
    scoutId,
    scout: t.withIdentity({ subject: scoutId, issuer: "test", email: "scout@team4099.com" }),
    guest: t.withIdentity({ subject: guestId, issuer: "test", email: "guest@example.org" }),
  };
}

describe("tba.fetchTba", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.TBA_API_KEY = SECRET;
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([{ team_number: 4099 }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    delete process.env.TBA_API_KEY;
    vi.unstubAllGlobals();
  });

  test("approved scout gets data; key goes upstream in a header, never in the result", async () => {
    const { scout } = await setup();
    const res = await scout.action(api.tba.fetchTba, { path: "/event/2026vaale1/teams" });
    expect(res).toEqual({ status: 200, data: [{ team_number: 4099 }] });
    expect(JSON.stringify(res)).not.toContain(SECRET);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.thebluealliance.com/api/v3/event/2026vaale1/teams");
    expect(init.headers["X-TBA-Auth-Key"]).toBe(SECRET);
  });

  test("signed-out and unapproved-guest callers get 401 and never reach TBA", async () => {
    const { t, guest } = await setup();
    expect(await t.action(api.tba.fetchTba, { path: "/team/frc4099" })).toEqual({ status: 401, data: null });
    expect(await guest.action(api.tba.fetchTba, { path: "/team/frc4099" })).toEqual({ status: 401, data: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    "/status",
    "/team/frc4099/../../account",
    "/event/2026vaale1/teams/simple/../../..",
    "/team/frc4099?x=1",
    "//evil.example/team/frc4099",
    "https://evil.example/team/frc4099",
    "/event/2026vaale1/alliances",
  ])("path %s is rejected with 400 and not forwarded", async (path) => {
    const { scout } = await setup();
    expect(await scout.action(api.tba.fetchTba, { path })).toEqual({ status: 400, data: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("every path src/lib/api.ts uses is allowed", async () => {
    const { scout } = await setup();
    for (const path of [
      "/event/2026vaale1/teams",
      "/event/2026vaale1/rankings",
      "/event/2026vaale1/matches",
      "/event/2026vaale1/insights",
      "/team/frc4099",
      "/team/frc4099/media/2026",
    ]) {
      expect((await scout.action(api.tba.fetchTba, { path })).status).toBe(200);
    }
  });

  test("503 when the deployment has no key; upstream failures pass their status through", async () => {
    const { scout } = await setup();
    delete process.env.TBA_API_KEY;
    expect(await scout.action(api.tba.fetchTba, { path: "/team/frc4099" })).toEqual({ status: 503, data: null });

    process.env.TBA_API_KEY = SECRET;
    fetchMock.mockImplementationOnce(async () => new Response("nope", { status: 401 }));
    // TBA rejecting our key must not look like the caller being signed out (401).
    expect((await scout.action(api.tba.fetchTba, { path: "/team/frc4099" })).status).toBe(503);
    fetchMock.mockImplementationOnce(async () => new Response("gone", { status: 404 }));
    expect((await scout.action(api.tba.fetchTba, { path: "/team/frc4099" })).status).toBe(404);
    fetchMock.mockImplementationOnce(async () => { throw new Error("network"); });
    expect((await scout.action(api.tba.fetchTba, { path: "/team/frc4099" })).status).toBe(502);
  });
});

describe("legacy per-user TBA key", () => {
  test("getUserSettings never returns a stored tbaApiKey", async () => {
    const { t, scout, scoutId } = await setup();
    await t.run((ctx) => ctx.db.insert("userSettings", { userId: scoutId, tbaApiKey: SECRET }));
    const settings = await scout.query(api.users.getUserSettings, {});
    expect(settings).not.toBeNull();
    expect(JSON.stringify(settings)).not.toContain(SECRET);
    expect(settings).not.toHaveProperty("tbaApiKey");
  });

  test("setTbaApiKey is a no-op that stores nothing", async () => {
    const { t, scout } = await setup();
    await scout.mutation(api.users.setTbaApiKey, { key: SECRET });
    expect(await t.run((ctx) => ctx.db.query("userSettings").collect())).toEqual([]);
  });

  test("scrubStoredTbaKeys erases stored keys and reports the count", async () => {
    const { t, scoutId } = await setup();
    await t.run((ctx) => ctx.db.insert("userSettings", { userId: scoutId, tbaApiKey: SECRET }));
    expect(await t.mutation(internal.users.scrubStoredTbaKeys, {})).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query("userSettings").collect());
    expect(rows.every((r) => r.tbaApiKey === undefined)).toBe(true);
  });
});
