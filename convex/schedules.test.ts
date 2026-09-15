/**
 * adminBulkSetPitScoutingPreference — added so the Pit Scouting tab's
 * Auto-Assign confirm step can write back the wantsPitScouting flag for
 * pairs generatePitScoutingTeams cuts or recruits, without touching a
 * scout's other stated preferences.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const EVENT = "2025chcmp";
const ADMIN_EMAIL = "czhao@team4099.com";

describe("adminBulkSetPitScoutingPreference", () => {
  test("a non-admin caller is rejected and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const scoutId = await t.run(async (ctx) => ctx.db.insert("users", { name: "Scout" }));
    const as = t.withIdentity({ subject: scoutId, issuer: "test" });

    await expect(
      as.mutation(api.schedules.adminBulkSetPitScoutingPreference, {
        eventKey: EVENT,
        changes: [{ scoutId, wantsPitScouting: true }],
      }),
    ).rejects.toThrow(/[Aa]dmin/);

    const rows = await t.run(async (ctx) => ctx.db.query("scoutPreferences").collect());
    expect(rows).toHaveLength(0);
  });

  test("patches only wantsPitScouting on an existing row, leaving other fields untouched", async () => {
    const t = convexTest(schema, modules);
    const { adminId, scoutId, partnerId } = await t.run(async (ctx) => ({
      adminId: await ctx.db.insert("users", { name: "Admin", email: ADMIN_EMAIL }),
      scoutId: await ctx.db.insert("users", { name: "Scout" }),
      partnerId: await ctx.db.insert("users", { name: "Partner" }),
    }));
    await t.run(async (ctx) =>
      ctx.db.insert("scoutPreferences", {
        scoutId, eventKey: EVENT,
        preferredPartners: [partnerId], wantsMoreMatches: true, wantsPitRotation: false,
        wantsPitScouting: true, updatedAt: 1,
      }),
    );
    const asAdmin = t.withIdentity({ subject: adminId, issuer: "test", email: ADMIN_EMAIL });

    await asAdmin.mutation(api.schedules.adminBulkSetPitScoutingPreference, {
      eventKey: EVENT,
      changes: [{ scoutId, wantsPitScouting: false }],
    });

    const row = await t.run(async (ctx) =>
      ctx.db.query("scoutPreferences")
        .withIndex("by_scout_event", (q) => q.eq("scoutId", scoutId).eq("eventKey", EVENT))
        .first(),
    );
    expect(row?.wantsPitScouting).toBe(false);
    expect(row?.preferredPartners).toEqual([partnerId]);
    expect(row?.wantsMoreMatches).toBe(true);
  });

  test("creates a defaulted row for a scout with no existing preferences", async () => {
    const t = convexTest(schema, modules);
    const { adminId, scoutId } = await t.run(async (ctx) => ({
      adminId: await ctx.db.insert("users", { name: "Admin", email: ADMIN_EMAIL }),
      scoutId: await ctx.db.insert("users", { name: "Scout" }),
    }));
    const asAdmin = t.withIdentity({ subject: adminId, issuer: "test", email: ADMIN_EMAIL });

    await asAdmin.mutation(api.schedules.adminBulkSetPitScoutingPreference, {
      eventKey: EVENT,
      changes: [{ scoutId, wantsPitScouting: true }],
    });

    const row = await t.run(async (ctx) =>
      ctx.db.query("scoutPreferences")
        .withIndex("by_scout_event", (q) => q.eq("scoutId", scoutId).eq("eventKey", EVENT))
        .first(),
    );
    expect(row?.wantsPitScouting).toBe(true);
    expect(row?.preferredPartners).toEqual([]);
    expect(row?.wantsMoreMatches).toBe(false);
    expect(row?.wantsPitRotation).toBe(false);
  });
});
