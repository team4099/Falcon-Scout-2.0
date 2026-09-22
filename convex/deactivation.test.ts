/**
 * Manage Scouts admin actions added alongside the drive-team feature:
 * soft-deleting (deactivating) a user, renaming a user, and setting the
 * admin-status label. Deactivation is the highest-stakes one — it must be
 * admin-gated, hide the user everywhere users.listUsers is the source of
 * truth, and self-heal the moment the user signs back in.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function realAdmin(t: ReturnType<typeof convexTest>) {
  const chiefId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Chief", email: "czhao@team4099.com" }),
  );
  return { chiefId, as: t.withIdentity({ subject: chiefId, issuer: "test", email: "czhao@team4099.com" }) };
}

describe("deactivateUser / reactivateUser", () => {
  test("a non-admin cannot deactivate anyone", async () => {
    const t = convexTest(schema, modules);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const otherId = await t.run((ctx) => ctx.db.insert("users", { name: "Other" }));
    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });
    await expect(
      scoutAs.mutation(api.admin.deactivateUser, { userId: otherId }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("deactivating a user hides them from listUsers; reactivating restores them", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });

    expect((await scoutAs.query(api.users.listUsers, {})).some((u) => u._id === scoutId)).toBe(true);

    await chiefAs.mutation(api.admin.deactivateUser, { userId: scoutId });
    expect((await chiefAs.query(api.users.listUsers, {})).some((u) => u._id === scoutId)).toBe(false);

    await chiefAs.mutation(api.admin.reactivateUser, { userId: scoutId });
    expect((await chiefAs.query(api.users.listUsers, {})).some((u) => u._id === scoutId)).toBe(true);
  });

  test("signing back in (reactivateSelf) clears a deactivation", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });

    await chiefAs.mutation(api.admin.deactivateUser, { userId: scoutId });
    expect((await chiefAs.query(api.users.listUsers, {})).some((u) => u._id === scoutId)).toBe(false);

    await scoutAs.mutation(api.users.reactivateSelf, {});
    expect((await chiefAs.query(api.users.listUsers, {})).some((u) => u._id === scoutId)).toBe(true);
  });

  test("an inherent admin's account can't be deactivated", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const otherChiefId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Yusuf", email: "yabdulkadir@team4099.com" }),
    );
    await expect(
      chiefAs.mutation(api.admin.deactivateUser, { userId: otherChiefId }),
    ).rejects.toThrow(/designated team lead/i);
  });
});

describe("setUserName", () => {
  test("a non-admin cannot rename anyone", async () => {
    const t = convexTest(schema, modules);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });
    await expect(
      scoutAs.mutation(api.users.setUserName, { userId: scoutId, name: "New Name" }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("an admin can rename a scout", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    await chiefAs.mutation(api.users.setUserName, { userId: scoutId, name: "Renamed Scout" });
    const users = await chiefAs.query(api.users.listUsers, {});
    expect(users.find((u) => u._id === scoutId)?.name).toBe("Renamed Scout");
  });
});

describe("addScoutByEmail", () => {
  test("a non-admin cannot add a scout", async () => {
    const t = convexTest(schema, modules);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });
    await expect(
      scoutAs.mutation(api.users.addScoutByEmail, { email: "new@team4099.com" }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("an admin can add a scout by email, and it's visible in listUsers", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const newId = await chiefAs.mutation(api.users.addScoutByEmail, {
      email: "New.Scout@Team4099.com",
    });
    const users = await chiefAs.query(api.users.listUsers, {});
    const added = users.find((u) => u._id === newId);
    expect(added?.email).toBe("new.scout@team4099.com");
    expect(added?.name).toBe("new.scout");
  });

  test("rejects a non-team4099.com email", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    await expect(
      chiefAs.mutation(api.users.addScoutByEmail, { email: "outsider@gmail.com" }),
    ).rejects.toThrow(/team4099\.com/i);
  });

  test("rejects a duplicate email", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    await chiefAs.mutation(api.users.addScoutByEmail, { email: "dup@team4099.com" });
    await expect(
      chiefAs.mutation(api.users.addScoutByEmail, { email: "dup@team4099.com" }),
    ).rejects.toThrow(/already exists/i);
  });

  test("the added placeholder's verified email lets a later Google sign-in claim it instead of creating a duplicate", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const placeholderId = await chiefAs.mutation(api.users.addScoutByEmail, {
      email: "future.scout@team4099.com",
    });
    // Mirrors @convex-dev/auth's own linking check (uniqueUserWithVerifiedEmail):
    // a verified-email match on `users` is what account linking keys off of.
    const linked = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", "future.scout@team4099.com"))
        .filter((q) => q.neq(q.field("emailVerificationTime"), undefined))
        .first(),
    );
    expect(linked?._id).toBe(placeholderId);
  });
});

describe("setAdminLabel", () => {
  test("a non-admin cannot set a label", async () => {
    const t = convexTest(schema, modules);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });
    await expect(
      scoutAs.mutation(api.admin.setAdminLabel, { userId: scoutId, label: "Whatever" }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("granting temporary admin seeds the label to 'Temporary Admin' only on a fresh grant", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));

    await chiefAs.mutation(api.admin.grantTemporaryAdmin, { userId: scoutId });
    let statuses = await chiefAs.query(api.admin.listAdminStatuses, {});
    expect(statuses.find((s) => s.userId === scoutId)?.label).toBe("Temporary Admin");

    // Custom label set by the admin ...
    await chiefAs.mutation(api.admin.setAdminLabel, { userId: scoutId, label: "Pit Boss" });
    // ... survives a renewal of the same active grant.
    await chiefAs.mutation(api.admin.grantTemporaryAdmin, { userId: scoutId });
    statuses = await chiefAs.query(api.admin.listAdminStatuses, {});
    expect(statuses.find((s) => s.userId === scoutId)?.label).toBe("Pit Boss");
  });
});
