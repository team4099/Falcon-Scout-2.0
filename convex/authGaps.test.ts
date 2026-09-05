/**
 * Authorization gaps found in the full-app audit.
 *
 *  - submitChecklist read getAuthUserId but never enforced it, so an anonymous
 *    caller could insert checklist rows.
 *  - Every read query except the ones in users.ts was ungated, so the whole
 *    dataset was readable by anyone with the deployment URL.
 *  - The kanban card mutations took a bare cardId and only checked sign-in, so
 *    any scout could mutate another scout's personal board.
 *  - submitForm paid the scouting reward on every call, not once per match.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const EVENT = "2025chcmp";

describe("checklist submission requires a signed-in caller", () => {
  test("an anonymous caller is rejected", async () => {
    const t = convexTest(schema, modules);
    const { scoutId, templateId } = await t.run(async (ctx) => ({
      scoutId: await ctx.db.insert("users", { name: "Scout" }),
      templateId: await ctx.db.insert("formTemplates", {
        name: "CL", formType: "checklist", fields: [], isActive: true,
      }),
    }));

    await expect(
      t.mutation(api.checklists.submitChecklist, {
        templateId, eventKey: EVENT, matchNumber: 1,
        assignedScoutId: scoutId, data: "{}",
      }),
    ).rejects.toThrow(/signed in/);

    const rows = await t.run(async (ctx) => ctx.db.query("checklistSubmissions").collect());
    expect(rows).toHaveLength(0);
  });
});

describe("read queries are gated", () => {
  test("an anonymous caller sees no scouting data, schedules or leaderboard", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const templateId = await ctx.db.insert("formTemplates", {
        name: "Match", fields: [], isActive: true,
      });
      await ctx.db.insert("formSubmissions", {
        templateId, eventKey: EVENT, matchNumber: 1, teamNumber: 4099,
        data: "{}", syncedAt: Date.now(),
      });
      const userId = await ctx.db.insert("users", { name: "Scout" });
      await ctx.db.insert("userBalances", {
        userId, eventKey: EVENT, balance: 5000,
        totalWon: 0, totalLost: 0, totalBet: 0, totalBegs: 0,
      });
      await ctx.db.insert("matchAssignments", {
        eventKey: EVENT, matchNumber: 1, matchLabel: "Q1",
        position: "red1", scoutId: userId,
      });
    });

    expect(await t.query(api.forms.listSubmissions, { eventKey: EVENT })).toEqual([]);
    expect(await t.query(api.forms.listTemplates, {})).toEqual([]);
    expect(await t.query(api.betting.getLeaderboard, { eventKey: EVENT })).toEqual([]);
    expect(await t.query(api.schedules.listMatchAssignments, { eventKey: EVENT })).toEqual([]);
    expect(await t.query(api.events.getCurrentEvent, {})).toBeNull();
  });

  test("a signed-in scout still sees everything", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const templateId = await ctx.db.insert("formTemplates", {
        name: "Match", fields: [], isActive: true,
      });
      await ctx.db.insert("formSubmissions", {
        templateId, eventKey: EVENT, matchNumber: 1, teamNumber: 4099,
        data: "{}", syncedAt: Date.now(),
      });
      return ctx.db.insert("users", { name: "Scout" });
    });
    const as = t.withIdentity({ subject: userId, issuer: "test" });
    expect(await as.query(api.forms.listSubmissions, { eventKey: EVENT })).toHaveLength(1);
    expect(await as.query(api.forms.listTemplates, {})).toHaveLength(1);
  });
});

describe("personal kanban boards are private", () => {
  async function setupBoards(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const owner    = await ctx.db.insert("users", { name: "Owner" });
      const intruder = await ctx.db.insert("users", { name: "Intruder" });
      const boardId = await ctx.db.insert("kanbanBoards", {
        name: "My picks", type: "personal", ownerId: owner,
        eventKey: EVENT, columns: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
      });
      const cardId = await ctx.db.insert("kanbanCards", {
        boardId, columnId: "a", teamNumber: 4099, eventKey: EVENT, position: 0,
      });
      return { owner, intruder, boardId, cardId };
    });
  }

  test("another scout cannot move, edit or delete a card", async () => {
    const t = convexTest(schema, modules);
    const { intruder, cardId } = await setupBoards(t);
    const as = t.withIdentity({ subject: intruder, issuer: "test" });

    await expect(as.mutation(api.kanban.moveCard, { cardId, columnId: "b", position: 0 }))
      .rejects.toThrow(/someone else's board/);
    await expect(as.mutation(api.kanban.updateCard, { cardId, notes: "hi" }))
      .rejects.toThrow(/someone else's board/);
    await expect(as.mutation(api.kanban.removeCard, { cardId }))
      .rejects.toThrow(/someone else's board/);

    const card = await t.run(async (ctx) => await ctx.db.get(cardId));
    expect(card?.columnId).toBe("a");
  });

  test("the owner still can", async () => {
    const t = convexTest(schema, modules);
    const { owner, cardId } = await setupBoards(t);
    const as = t.withIdentity({ subject: owner, issuer: "test" });
    await as.mutation(api.kanban.moveCard, { cardId, columnId: "b", position: 0 });
    const card = await t.run(async (ctx) => await ctx.db.get(cardId));
    expect(card?.columnId).toBe("b");
  });

  test("the central board stays shared", async () => {
    const t = convexTest(schema, modules);
    const { cardId } = await t.run(async (ctx) => {
      await ctx.db.insert("users", { name: "Owner" });
      const boardId = await ctx.db.insert("kanbanBoards", {
        name: "Picklist", type: "central", eventKey: EVENT,
        columns: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
      });
      return { cardId: await ctx.db.insert("kanbanCards", {
        boardId, columnId: "a", teamNumber: 4099, eventKey: EVENT, position: 0,
      }) };
    });
    const other = await t.run(async (ctx) => ctx.db.insert("users", { name: "Other" }));
    const as = t.withIdentity({ subject: other, issuer: "test" });
    await as.mutation(api.kanban.moveCard, { cardId, columnId: "b", position: 0 });
    const card = await t.run(async (ctx) => await ctx.db.get(cardId));
    expect(card?.columnId).toBe("b");
  });
});

describe("scouting pays once per match", () => {
  async function scout(t: ReturnType<typeof convexTest>) {
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "Scout" }));
    const templateId = await t.run(async (ctx) => ctx.db.insert("formTemplates", {
      name: "Match", fields: [], isActive: true, coinReward: 50,
    }));
    const as = t.withIdentity({ subject: userId, issuer: "test" });
    const bal = () => t.run(async (ctx) =>
      (await ctx.db.query("userBalances")
        .withIndex("by_user_event", (q) => q.eq("userId", userId).eq("eventKey", EVENT))
        .first())?.balance ?? 0);
    return { as, templateId, bal };
  }

  test("re-submitting the same match does not pay again", async () => {
    const t = convexTest(schema, modules);
    const { as, templateId, bal } = await scout(t);
    for (let i = 0; i < 5; i++) {
      await as.mutation(api.forms.submitForm, {
        templateId, eventKey: EVENT, matchNumber: 1,
        compLevel: "qm", teamNumber: 4099, data: "{}",
      });
    }
    expect(await bal()).toBe(1050); // 1000 start + one 50-coin reward
    const rows = await t.run(async (ctx) => ctx.db.query("formSubmissions").collect());
    expect(rows).toHaveLength(5); // corrections are still accepted
  });

  test("a different match, team or comp level each pays", async () => {
    const t = convexTest(schema, modules);
    const { as, templateId, bal } = await scout(t);
    const base = { templateId, eventKey: EVENT, data: "{}" } as const;
    await as.mutation(api.forms.submitForm, { ...base, matchNumber: 1, compLevel: "qm", teamNumber: 4099 });
    await as.mutation(api.forms.submitForm, { ...base, matchNumber: 2, compLevel: "qm", teamNumber: 4099 });
    await as.mutation(api.forms.submitForm, { ...base, matchNumber: 1, compLevel: "qm", teamNumber: 254 });
    await as.mutation(api.forms.submitForm, { ...base, matchNumber: 1, compLevel: "elim", teamNumber: 4099 });
    expect(await bal()).toBe(1200); // 1000 + 4 × 50
  });

  test("two scouts covering the same team both get paid", async () => {
    const t = convexTest(schema, modules);
    const a = await scout(t);
    const b = await scout(t);
    const args = { eventKey: EVENT, matchNumber: 1, compLevel: "qm", teamNumber: 4099, data: "{}" } as const;
    await a.as.mutation(api.forms.submitForm, { ...args, templateId: a.templateId });
    await b.as.mutation(api.forms.submitForm, { ...args, templateId: b.templateId });
    expect(await a.bal()).toBe(1050);
    expect(await b.bal()).toBe(1050);
  });
});
