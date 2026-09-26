/**
 * Scout preferences are only ever written by the scout themself
 * (upsertMyPreferences) or an admin (adminSetPreferences) — scheduling
 * never changes them. These tests pin the admin gate on the override path.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const EVENT = "2025chcmp";
const ADMIN_EMAIL = "czhao@team4099.com";
const PREFS = { preferredPartners: [], wantsMoreMatches: false, wantsPitRotation: false, wantsPitScouting: true };

describe("adminSetPreferences", () => {
  test("a non-admin caller cannot change another scout's preferences", async () => {
    const t = convexTest(schema, modules);
    const { callerId, scoutId } = await t.run(async (ctx) => ({
      callerId: await ctx.db.insert("users", { name: "Caller", email: "caller@team4099.com" }),
      scoutId: await ctx.db.insert("users", { name: "Scout", email: "scout@team4099.com" }),
    }));
    const as = t.withIdentity({ subject: callerId, issuer: "test" });

    await expect(
      as.mutation(api.schedules.adminSetPreferences, { scoutId, eventKey: EVENT, ...PREFS }),
    ).rejects.toThrow(/[Aa]dmin/);

    const rows = await t.run(async (ctx) => ctx.db.query("scoutPreferences").collect());
    expect(rows).toHaveLength(0);
  });

  test("an admin can set another scout's preferences", async () => {
    const t = convexTest(schema, modules);
    const { adminId, scoutId } = await t.run(async (ctx) => ({
      adminId: await ctx.db.insert("users", { name: "Admin", email: ADMIN_EMAIL }),
      scoutId: await ctx.db.insert("users", { name: "Scout", email: "scout@team4099.com" }),
    }));
    const asAdmin = t.withIdentity({ subject: adminId, issuer: "test", email: ADMIN_EMAIL });

    await asAdmin.mutation(api.schedules.adminSetPreferences, { scoutId, eventKey: EVENT, ...PREFS });

    const row = await t.run(async (ctx) =>
      ctx.db.query("scoutPreferences")
        .withIndex("by_scout_event", (q) => q.eq("scoutId", scoutId).eq("eventKey", EVENT))
        .first(),
    );
    expect(row?.wantsPitScouting).toBe(true);
  });
});

describe("match assignment vs pit rotation", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => ({
      adminId: await ctx.db.insert("users", { name: "Admin", email: ADMIN_EMAIL }),
      onPit: await ctx.db.insert("users", { name: "Pitty", email: "pit@team4099.com" }),
      free: await ctx.db.insert("users", { name: "Free", email: "free@team4099.com" }),
    }));
    await t.run(async (ctx) => {
      await ctx.db.insert("pitRotations", {
        eventKey: EVENT, startMatch: 10, endMatch: 19, scoutIds: [ids.onPit], driveTeamScoutIds: [],
      });
    });
    const asAdmin = t.withIdentity({ subject: ids.adminId, issuer: "test", email: ADMIN_EMAIL });
    return { t, asAdmin, ...ids };
  }
  const slot = (matchNumber: number, scoutId: any) => ({
    eventKey: EVENT, matchNumber, matchLabel: `Q${matchNumber}`, position: "red1" as const, scoutId,
  });

  test("refuses a single assignment inside the scout's pit rotation", async () => {
    const { t, asAdmin, onPit } = await setup();
    await expect(asAdmin.mutation(api.schedules.setMatchAssignment, slot(12, onPit))).rejects.toThrow(/Pitty.*Q10–Q19/);
    expect(await t.run(async (ctx) => ctx.db.query("matchAssignments").collect())).toHaveLength(0);
  });

  test("a batch with any conflicting slot is refused entirely", async () => {
    const { t, asAdmin, onPit, free } = await setup();
    const { eventKey: _e, ...a } = slot(5, onPit);
    const { eventKey: _f, ...b } = slot(15, onPit);
    const { eventKey: _g, ...c } = slot(15, free);
    await expect(
      asAdmin.mutation(api.schedules.batchSetMatchAssignments, { eventKey: EVENT, assignments: [a, { ...c, position: "red2" }, b] }),
    ).rejects.toThrow(/pit rotation/);
    expect(await t.run(async (ctx) => ctx.db.query("matchAssignments").collect())).toHaveLength(0);
  });

  test("allows the scout outside the window and other scouts inside it", async () => {
    const { t, asAdmin, onPit, free } = await setup();
    await asAdmin.mutation(api.schedules.setMatchAssignment, slot(9, onPit));
    await asAdmin.mutation(api.schedules.setMatchAssignment, slot(20, onPit));
    await asAdmin.mutation(api.schedules.setMatchAssignment, slot(12, free));
    expect(await t.run(async (ctx) => ctx.db.query("matchAssignments").collect())).toHaveLength(3);
  });
});
