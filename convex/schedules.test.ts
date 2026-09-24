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
