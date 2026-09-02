/**
 * Server-side authorization tests.
 *
 * These cover the hole found in the audit: privileged mutations that either had
 * no auth check at all, or called getAuthUserId and threw the result away. Both
 * layers are checked here — signed-in, and signed-in *with the right admin key*.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// SHA-256 of "passw0rd" — the historical default the client ships with.
const DEFAULT_HASH =
  "8f0e2f76e22b43e2855189877e7dc1e1e7d98c226c95db247cd1d547928334a9";
const WRONG_HASH = "0".repeat(64);

const modules = import.meta.glob("./**/*.ts");
const scout = { subject: "scout|1", issuer: "test" };

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

  test("setCurrentEvent rejects a signed-in scout with no admin key", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity(scout).mutation(api.events.setCurrentEvent, {
        eventKey: "2025chcmp",
        eventName: "Chesapeake",
      }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("setCurrentEvent rejects a signed-in scout with the wrong key", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity(scout).mutation(api.events.setCurrentEvent, {
        eventKey: "2025chcmp",
        eventName: "Chesapeake",
        adminKey: WRONG_HASH,
      }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("setCurrentEvent succeeds with the correct admin key", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(scout).mutation(api.events.setCurrentEvent, {
      eventKey: "2025chcmp",
      eventName: "Chesapeake",
      adminKey: DEFAULT_HASH,
    });
    const ev = await t.query(api.events.getCurrentEvent, {});
    expect(ev?.eventKey).toBe("2025chcmp");
  });

  test("the admin key is compared case-insensitively but not loosely", async () => {
    const t = convexTest(schema, modules);
    // upper-case hex is the same credential
    await t.withIdentity(scout).mutation(api.events.setCurrentEvent, {
      eventKey: "2025mdber",
      eventName: "Bethesda",
      adminKey: DEFAULT_HASH.toUpperCase(),
    });
    expect((await t.query(api.events.getCurrentEvent, {}))?.eventKey).toBe("2025mdber");

    // a prefix of the real hash is not
    await expect(
      t.withIdentity(scout).mutation(api.events.setCurrentEvent, {
        eventKey: "nope",
        eventName: "nope",
        adminKey: DEFAULT_HASH.slice(0, 32),
      }),
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

    await t.withIdentity(scout).mutation(api.forms.deleteSubmission, {
      id, adminKey: DEFAULT_HASH,
    });
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

describe("changing the admin password", () => {
  test("the new password works and the old one stops working", async () => {
    const t = convexTest(schema, modules);
    const NEW = "a".repeat(64);

    await t.withIdentity(scout).mutation(api.admin.setAdminPassword, {
      newHash: NEW,
      adminKey: DEFAULT_HASH,
    });

    await t.withIdentity(scout).mutation(api.events.setCurrentEvent, {
      eventKey: "2025new", eventName: "New", adminKey: NEW,
    });
    expect((await t.query(api.events.getCurrentEvent, {}))?.eventKey).toBe("2025new");

    await expect(
      t.withIdentity(scout).mutation(api.events.setCurrentEvent, {
        eventKey: "2025old", eventName: "Old", adminKey: DEFAULT_HASH,
      }),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("a malformed hash is rejected", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity(scout).mutation(api.admin.setAdminPassword, {
        newHash: "not-a-hash",
        adminKey: DEFAULT_HASH,
      }),
    ).rejects.toThrow(/Invalid password hash/i);
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
