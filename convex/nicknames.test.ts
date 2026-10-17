/**
 * Scout nicknames: admin-only, stored in scoutNicknames, surfaced on
 * users.listUsers so every screen that lists scouts can show them.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const [adminId, scoutId] = await t.run(async (ctx) => [
    await ctx.db.insert("users", { name: "Chief", email: "czhao@team4099.com" }),
    await ctx.db.insert("users", { name: "Charlie Zhao", email: "charlie.zhao@team4099.com" }),
  ]);
  const admin = t.withIdentity({ subject: adminId, issuer: "test", email: "czhao@team4099.com" });
  const scout = t.withIdentity({ subject: scoutId, issuer: "test", email: "charlie.zhao@team4099.com" });
  const listed = async (who: typeof admin, id: string) =>
    (await who.query(api.users.listUsers, {})).find((u) => u._id === id);
  return { t, admin, scout, adminId, scoutId, listed };
}

describe("scout nicknames", () => {
  test("an admin's nickname shows up on listUsers for everyone", async () => {
    const { admin, scout, scoutId, listed } = await setup();
    await admin.mutation(api.users.setScoutNickname, { userId: scoutId, nickname: "Charlie Z" });
    expect((await listed(admin, scoutId))?.nickname).toBe("Charlie Z");
    expect((await listed(scout, scoutId))?.nickname).toBe("Charlie Z");
    // The real name is untouched; the nickname is only a label.
    expect((await listed(admin, scoutId))?.name).toBe("Charlie Zhao");
  });

  test("trims, and an empty nickname clears it", async () => {
    const { admin, scoutId, listed } = await setup();
    await admin.mutation(api.users.setScoutNickname, { userId: scoutId, nickname: "  Z  " });
    expect((await listed(admin, scoutId))?.nickname).toBe("Z");
    await admin.mutation(api.users.setScoutNickname, { userId: scoutId, nickname: "   " });
    expect((await listed(admin, scoutId))?.nickname).toBeUndefined();
  });

  test("setting again replaces the one row rather than adding a second", async () => {
    const { t, admin, scoutId } = await setup();
    await admin.mutation(api.users.setScoutNickname, { userId: scoutId, nickname: "One" });
    await admin.mutation(api.users.setScoutNickname, { userId: scoutId, nickname: "Two" });
    const rows = await t.run((ctx) => ctx.db.query("scoutNicknames").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].nickname).toBe("Two");
  });

  test("non-admins can't set a nickname", async () => {
    const { scout, scoutId } = await setup();
    await expect(
      scout.mutation(api.users.setScoutNickname, { userId: scoutId, nickname: "Hacked" }),
    ).rejects.toThrow(/Admin access/);
  });

  test("rejects nicknames over 24 characters", async () => {
    const { admin, scoutId } = await setup();
    await expect(
      admin.mutation(api.users.setScoutNickname, { userId: scoutId, nickname: "x".repeat(25) }),
    ).rejects.toThrow(/24 characters/);
    // Exactly 24 is fine.
    await admin.mutation(api.users.setScoutNickname, { userId: scoutId, nickname: "x".repeat(24) });
  });

  test("rejects a user that doesn't exist", async () => {
    const { t, admin } = await setup();
    const goneId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { name: "Gone" });
      await ctx.db.delete(id);
      return id;
    });
    await expect(
      admin.mutation(api.users.setScoutNickname, { userId: goneId, nickname: "Ghost" }),
    ).rejects.toThrow(/doesn't exist/);
  });
});
