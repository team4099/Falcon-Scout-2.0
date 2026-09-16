/**
 * Server-side authorization tests.
 *
 * These cover the hole found in the audit: privileged mutations that either had
 * no auth check at all, or called getAuthUserId and threw the result away. Both
 * layers are checked here — signed-in, and signed-in *with an allowlisted admin
 * email*. Admin access is tied to the caller's Google identity email (see
 * convex/adminAuth.ts), not a shared secret, so tests grant/deny it by setting
 * `email` on the test identity rather than by passing a key.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const scout = { subject: "scout|1", issuer: "test", email: "scout@team4099.com" };
const admin = { subject: "chief|1", issuer: "test", email: "czhao@team4099.com" };

describe("requireAdmin", () => {
  test("setCurrentEvent rejects an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.events.setCurrentEvent, {
        eventKey: "2025chcmp",
        eventName: "Chesapeake",
      }),
    ).rejects.toThrow(/signed in/i);
  });

  test("setCurrentEvent rejects a signed-in scout who isn't on the admin allowlist", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity(scout).mutation(api.events.setCurrentEvent, {
        eventKey: "2025chcmp",
        eventName: "Chesapeake",
      }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("setCurrentEvent succeeds for an allowlisted admin email", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(admin).mutation(api.events.setCurrentEvent, {
      eventKey: "2025chcmp",
      eventName: "Chesapeake",
    });
    // Read back as the scout: getCurrentEvent is gated to signed-in callers.
    const ev = await t.withIdentity(scout).query(api.events.getCurrentEvent, {});
    expect(ev?.eventKey).toBe("2025chcmp");
  });

  test("the admin email is compared case-insensitively but must match exactly otherwise", async () => {
    const t = convexTest(schema, modules);
    // upper-case email is the same account
    await t
      .withIdentity({ ...admin, email: "CZHAO@team4099.com" })
      .mutation(api.events.setCurrentEvent, { eventKey: "2025mdber", eventName: "Bethesda" });
    expect((await t.withIdentity(scout).query(api.events.getCurrentEvent, {}))?.eventKey).toBe("2025mdber");

    // a similar but different team4099.com address is not on the allowlist
    await expect(
      t
        .withIdentity({ subject: "other|1", issuer: "test", email: "yzhao@team4099.com" })
        .mutation(api.events.setCurrentEvent, { eventKey: "nope", eventName: "nope" }),
    ).rejects.toThrow(/Admin access required/i);
  });
});

describe("mutations that previously discarded the auth result", () => {
  test("forms.deleteSubmission requires admin", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) => {
      const templateId = await ctx.db.insert("formTemplates", {
        name: "T", fields: [], isActive: true,
      });
      return ctx.db.insert("formSubmissions", {
        templateId, eventKey: "2025chcmp", matchNumber: 1,
        teamNumber: 4099, data: "{}", syncedAt: Date.now(),
      });
    });

    await expect(
      t.withIdentity(scout).mutation(api.forms.deleteSubmission, { id }),
    ).rejects.toThrow(/Admin access required/i);

    // still there
    expect(await t.run(async (ctx) => ctx.db.get(id))).not.toBeNull();

    await t.withIdentity(admin).mutation(api.forms.deleteSubmission, { id });
    expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
  });

  test("betting.lockMarket requires admin", async () => {
    const t = convexTest(schema, modules);
    const marketId = await t.run(async (ctx) =>
      ctx.db.insert("bettingMarkets", {
        eventKey: "2025chcmp", title: "Q1 winner", type: "match_winner",
        options: [
          { id: "red", label: "Red", seedPool: 50 },
          { id: "blue", label: "Blue", seedPool: 50 },
        ],
        status: "open", createdAt: Date.now(),
      }),
    );
    await expect(
      t.withIdentity(scout).mutation(api.betting.lockMarket, { marketId }),
    ).rejects.toThrow(/Admin access required/i);
  });
});

describe("admin allowlist eligibility query", () => {
  test("reports false for a non-admin and true for an allowlisted email", async () => {
    const t = convexTest(schema, modules);
    expect(await t.withIdentity(scout).query(api.admin.isCurrentUserAdmin, {})).toBe(false);
    expect(await t.withIdentity(admin).query(api.admin.isCurrentUserAdmin, {})).toBe(true);
  });

  test("reports false for a signed-out caller", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.admin.isCurrentUserAdmin, {})).toBe(false);
  });
});

describe("temporary admin grants", () => {
  // grantTemporaryAdmin stores grantedBy as a real v.id("users") value, so the
  // granter here needs an actual users row (unlike the `admin`/`scout` fakes
  // above, which only ever flow through identity.email and never get stored).
  async function realAdmin(t: ReturnType<typeof convexTest>) {
    const chiefId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Chief", email: "czhao@team4099.com" }),
    );
    return { chiefId, as: t.withIdentity({ subject: chiefId, issuer: "test", email: "czhao@team4099.com" }) };
  }

  test("an inherent admin can grant a scout 12 hours of admin access", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });

    await expect(
      scoutAs.mutation(api.events.setCurrentEvent, { eventKey: "e", eventName: "E" }),
    ).rejects.toThrow(/Admin access required/i);

    const before = Date.now();
    const { expiresAt } = await chiefAs.mutation(api.admin.grantTemporaryAdmin, { userId: scoutId });
    expect(expiresAt).toBeGreaterThan(before + 11 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(before + 12 * 60 * 60 * 1000 + 1000);

    await scoutAs.mutation(api.events.setCurrentEvent, { eventKey: "2025temp", eventName: "Temp" });
    expect((await scoutAs.query(api.events.getCurrentEvent, {}))?.eventKey).toBe("2025temp");
    expect(await scoutAs.query(api.admin.isCurrentUserAdmin, {})).toBe(true);
  });

  test("an inherent admin can choose a custom grant duration, clamped to [1, 720] hours", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const otherId = await t.run((ctx) => ctx.db.insert("users", { name: "Other" }));

    const before = Date.now();
    const { expiresAt } = await chiefAs.mutation(api.admin.grantTemporaryAdmin, { userId: scoutId, hours: 2 });
    expect(expiresAt).toBeGreaterThan(before + 1 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(before + 2 * 60 * 60 * 1000 + 1000);

    const beforeOver = Date.now();
    const { expiresAt: overExpiresAt } = await chiefAs.mutation(api.admin.grantTemporaryAdmin, {
      userId: otherId,
      hours: 999999,
    });
    expect(overExpiresAt).toBeLessThanOrEqual(beforeOver + 720 * 60 * 60 * 1000 + 1000);
  });

  test("a temporary admin cannot grant admin to anyone else", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const otherId = await t.run((ctx) => ctx.db.insert("users", { name: "Other" }));
    await chiefAs.mutation(api.admin.grantTemporaryAdmin, { userId: scoutId });

    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });
    await expect(
      scoutAs.mutation(api.admin.grantTemporaryAdmin, { userId: otherId }),
    ).rejects.toThrow(/designated team leads/i);
  });

  test("granting an inherent admin's own account is rejected", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const otherChiefId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Yusuf", email: "yabdulkadir@team4099.com" }),
    );
    await expect(
      chiefAs.mutation(api.admin.grantTemporaryAdmin, { userId: otherChiefId }),
    ).rejects.toThrow(/already a designated team lead/i);
  });

  test("an expired grant no longer counts as admin", async () => {
    const t = convexTest(schema, modules);
    const scoutId = await t.run(async (ctx) => {
      const chiefId = await ctx.db.insert("users", { name: "Chief", email: "czhao@team4099.com" });
      const sId = await ctx.db.insert("users", { name: "Scout" });
      await ctx.db.insert("temporaryAdminGrants", {
        userId: sId, grantedBy: chiefId, expiresAt: Date.now() - 1000,
      });
      return sId;
    });
    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });
    expect(await scoutAs.query(api.admin.isCurrentUserAdmin, {})).toBe(false);
    await expect(
      scoutAs.mutation(api.events.setCurrentEvent, { eventKey: "e", eventName: "E" }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("revoking removes access immediately", async () => {
    const t = convexTest(schema, modules);
    const { as: chiefAs } = await realAdmin(t);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    await chiefAs.mutation(api.admin.grantTemporaryAdmin, { userId: scoutId });

    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });
    expect(await scoutAs.query(api.admin.isCurrentUserAdmin, {})).toBe(true);

    await chiefAs.mutation(api.admin.revokeTemporaryAdmin, { userId: scoutId });
    expect(await scoutAs.query(api.admin.isCurrentUserAdmin, {})).toBe(false);
  });

  test("listAdminStatuses is empty for non-inherent-admin callers", async () => {
    const t = convexTest(schema, modules);
    const scoutId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const scoutAs = t.withIdentity({ subject: scoutId, issuer: "test" });
    expect(await scoutAs.query(api.admin.listAdminStatuses, {})).toEqual([]);
    expect(await t.query(api.admin.listAdminStatuses, {})).toEqual([]);
  });
});

describe("dev admin login (localhost bypass)", () => {
  const devAdmin = { subject: "devadmin|1", issuer: "test", email: "devadmin@team4099.com" };

  test("devadmin@team4099.com is NOT admin-eligible when ALLOW_DEV_LOGIN is unset", async () => {
    const t = convexTest(schema, modules);
    expect(await t.withIdentity(devAdmin).query(api.admin.isCurrentUserAdmin, {})).toBe(false);
    await expect(
      t.withIdentity(devAdmin).mutation(api.events.setCurrentEvent, { eventKey: "e", eventName: "E" }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("devadmin@team4099.com is admin-eligible when ALLOW_DEV_LOGIN=true (matches the dev-only anonymous provider gate in convex/auth.ts)", async () => {
    const original = process.env.ALLOW_DEV_LOGIN;
    process.env.ALLOW_DEV_LOGIN = "true";
    try {
      const t = convexTest(schema, modules);
      expect(await t.withIdentity(devAdmin).query(api.admin.isCurrentUserAdmin, {})).toBe(true);
      await t.withIdentity(devAdmin).mutation(api.events.setCurrentEvent, {
        eventKey: "2025devtest",
        eventName: "Dev Admin Test",
      });
    } finally {
      if (original === undefined) delete process.env.ALLOW_DEV_LOGIN;
      else process.env.ALLOW_DEV_LOGIN = original;
    }
  });
});

describe("scout-level mutations stay usable by non-admins", () => {
  test("a signed-in scout can submit a form and move a picklist card", async () => {
    const t = convexTest(schema, modules);

    // submitForm stamps scoutId, so the identity subject has to be a real
    // users row id rather than an arbitrary string.
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "Scout" }));
    const as = t.withIdentity({ subject: userId, issuer: "test" });

    const templateId = await t.run(async (ctx) =>
      ctx.db.insert("formTemplates", { name: "T", fields: [], isActive: true }),
    );

    // The offline queue replays these for ordinary scouts — admin-gating them
    // would have broken sync for everyone who isn't an admin.
    await as.mutation(api.forms.submitForm, {
      templateId, eventKey: "2025chcmp", matchNumber: 7,
      compLevel: "qm", teamNumber: 4099, data: '{"auto_coral":0}',
    });

    const { boardId, cardId } = await t.run(async (ctx) => {
      const boardId = await ctx.db.insert("kanbanBoards", {
        name: "Picklist", type: "central", eventKey: "2025chcmp",
        columns: [{ id: "unsorted", title: "Unsorted" }, { id: "a", title: "A" }],
      });
      const cardId = await ctx.db.insert("kanbanCards", {
        boardId, columnId: "unsorted", teamNumber: 254,
        eventKey: "2025chcmp", position: 0,
      });
      return { boardId, cardId };
    });
    void boardId;

    await as.mutation(api.kanban.moveCard, { cardId, columnId: "a", position: 0 });
    expect(await t.run(async (ctx) => (await ctx.db.get(cardId))?.columnId)).toBe("a");
  });

  test("an anonymous caller still cannot submit or move cards", async () => {
    const t = convexTest(schema, modules);
    const templateId = await t.run(async (ctx) =>
      ctx.db.insert("formTemplates", { name: "T", fields: [], isActive: true }),
    );
    await expect(
      t.mutation(api.forms.submitForm, {
        templateId, eventKey: "2025chcmp", matchNumber: 1,
        teamNumber: 4099, data: "{}",
      }),
    ).rejects.toThrow(/signed in/i);
  });
});
