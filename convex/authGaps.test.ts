/**
 * Authorization gaps found in the full-app audit.
 *
 *  - submitChecklist read getAuthUserId but never enforced it, so an anonymous
 *    caller could insert checklist rows. Checklists are now ordinary form
 *    submissions, so the same guarantee is asserted against submitForm with a
 *    checklist template.
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
    const templateId = await t.run(async (ctx) =>
      ctx.db.insert("formTemplates", {
        name: "CL", formType: "checklist", fields: [], isActive: true,
      }),
    );

    // Checklists go through submitForm now. teamNumber 0 is what a checklist
    // carries (no teamNumber field), which must not become an auth bypass.
    await expect(
      t.mutation(api.forms.submitForm, {
        templateId, eventKey: EVENT, matchNumber: 1,
        compLevel: "qm", teamNumber: 0, data: "{}",
      }),
    ).rejects.toThrow(/signed in/);

    const rows = await t.run(async (ctx) => ctx.db.query("formSubmissions").collect());
    expect(rows).toHaveLength(0);
  });

  test("a signed-in scout's checklist lands in formSubmissions", async () => {
    const t = convexTest(schema, modules);
    const { userId, templateId } = await t.run(async (ctx) => ({
      userId: await ctx.db.insert("users", { name: "Scout" }),
      templateId: await ctx.db.insert("formTemplates", {
        name: "CL", formType: "checklist", fields: [], isActive: true,
      }),
    }));
    const as = t.withIdentity({ subject: userId, issuer: "test" });
    await as.mutation(api.forms.submitForm, {
      templateId, eventKey: EVENT, matchNumber: 7,
      compLevel: "qm", teamNumber: 0, data: "{}",
    });

    // getMySubmissions is what My Schedule uses to tick a checklist off.
    const mine = await as.query(api.forms.getMySubmissions, { eventKey: EVENT });
    expect(mine).toHaveLength(1);
    expect(mine[0].matchNumber).toBe(7);
    expect(mine[0].templateId).toBe(templateId);
    // teamNumber 0 keeps it out of the Dashboard/Data Viewer team rollups.
    expect(mine[0].teamNumber).toBe(0);
    // formType is resolved from the template so My Schedule can tell a
    // checklist apart from a match or pit submission when marking it complete.
    expect(mine[0].formType).toBe("checklist");
  });

  test("getMySubmissions reports formType even for a deactivated template", async () => {
    const t = convexTest(schema, modules);
    const { userId, templateId } = await t.run(async (ctx) => ({
      userId: await ctx.db.insert("users", { name: "Scout" }),
      templateId: await ctx.db.insert("formTemplates", {
        name: "Pit", formType: "pit", fields: [], isActive: true,
      }),
    }));
    const as = t.withIdentity({ subject: userId, issuer: "test" });
    await as.mutation(api.forms.submitForm, {
      templateId, eventKey: EVENT, matchNumber: 0,
      compLevel: "qm", teamNumber: 9072, data: "{}",
    });
    // An admin swapping the active pit form mid-event must not un-tick work
    // the scout already did — the client's active-template list would lose it.
    await t.run(async (ctx) => ctx.db.patch(templateId, { isActive: false }));

    const mine = await as.query(api.forms.getMySubmissions, { eventKey: EVENT });
    expect(mine).toHaveLength(1);
    expect(mine[0].formType).toBe("pit");
    expect(mine[0].teamNumber).toBe(9072);
  });

  test("a scout cannot report for a pit rotation they are not rostered on", async () => {
    const t = convexTest(schema, modules);
    const { outsiderId, rotationId } = await t.run(async (ctx) => {
      const rosteredId = await ctx.db.insert("users", { name: "Rostered" });
      return {
        outsiderId: await ctx.db.insert("users", { name: "Outsider" }),
        rotationId: await ctx.db.insert("pitRotations", {
          eventKey: EVENT, startMatch: 1, endMatch: 10, scoutIds: [rosteredId],
        }),
      };
    });
    // The roster is read from the rotation row server-side — hiding the button
    // on the client is not the gate.
    const as = t.withIdentity({ subject: outsiderId, issuer: "test" });
    await expect(
      as.mutation(api.schedules.reportPitDuty, { eventKey: EVENT, rotationId }),
    ).rejects.toThrow(/not assigned/);
    expect(await t.run(async (ctx) => ctx.db.query("pitDutyCheckIns").collect())).toHaveLength(0);
  });

  test("an anonymous caller cannot report for pit duty", async () => {
    const t = convexTest(schema, modules);
    const rotationId = await t.run(async (ctx) => {
      const scoutId = await ctx.db.insert("users", { name: "Scout" });
      return await ctx.db.insert("pitRotations", {
        eventKey: EVENT, startMatch: 1, endMatch: 10, scoutIds: [scoutId],
      });
    });
    await expect(
      t.mutation(api.schedules.reportPitDuty, { eventKey: EVENT, rotationId }),
    ).rejects.toThrow(/authenticated/);
  });

  test("reporting twice is idempotent, and undo only removes your own row", async () => {
    const t = convexTest(schema, modules);
    const { scoutId, otherId, rotationId } = await t.run(async (ctx) => {
      const scoutId = await ctx.db.insert("users", { name: "Scout" });
      const otherId = await ctx.db.insert("users", { name: "Other" });
      return {
        scoutId, otherId,
        rotationId: await ctx.db.insert("pitRotations", {
          eventKey: EVENT, startMatch: 1, endMatch: 10, scoutIds: [scoutId, otherId],
        }),
      };
    });
    const as = t.withIdentity({ subject: scoutId, issuer: "test" });
    const asOther = t.withIdentity({ subject: otherId, issuer: "test" });

    await as.mutation(api.schedules.reportPitDuty, { eventKey: EVENT, rotationId });
    await as.mutation(api.schedules.reportPitDuty, { eventKey: EVENT, rotationId });
    await asOther.mutation(api.schedules.reportPitDuty, { eventKey: EVENT, rotationId });
    // A double tap (or an offline retry) must not stack up rows.
    expect(await t.run(async (ctx) => ctx.db.query("pitDutyCheckIns").collect())).toHaveLength(2);

    await as.mutation(api.schedules.unreportPitDuty, { rotationId });
    expect(await as.query(api.schedules.getMyPitDutyCheckIns, { eventKey: EVENT })).toEqual([]);
    // The other scout's check-in survives.
    expect(await asOther.query(api.schedules.getMyPitDutyCheckIns, { eventKey: EVENT }))
      .toHaveLength(1);
  });

  test("pit duty pays once, double-report doesn't stack, and undo claws it back", async () => {
    const t = convexTest(schema, modules);
    const { scoutId, rotationId } = await t.run(async (ctx) => {
      const scoutId = await ctx.db.insert("users", { name: "Scout" });
      return {
        scoutId,
        rotationId: await ctx.db.insert("pitRotations", {
          eventKey: EVENT, startMatch: 1, endMatch: 10, scoutIds: [scoutId],
        }),
      };
    });
    const as = t.withIdentity({ subject: scoutId, issuer: "test" });
    const bal = () => t.run(async (ctx) =>
      (await ctx.db.query("userBalances")
        .withIndex("by_user_event", (q) => q.eq("userId", scoutId).eq("eventKey", EVENT))
        .first())?.balance ?? 0);

    await as.mutation(api.schedules.reportPitDuty, { eventKey: EVENT, rotationId });
    await as.mutation(api.schedules.reportPitDuty, { eventKey: EVENT, rotationId }); // repeat tap
    expect(await bal()).toBe(1025); // 1000 + one 25-coin reward, not two

    await as.mutation(api.schedules.unreportPitDuty, { rotationId });
    expect(await bal()).toBe(1000); // undo claws the reward back

    // Reporting again after a genuine undo pays again — this isn't the farming
    // loop (report→undo→report repeated forever); it's the same "assigned work,
    // done once at a time" rule submitForm already follows for form submissions.
    await as.mutation(api.schedules.reportPitDuty, { eventKey: EVENT, rotationId });
    expect(await bal()).toBe(1025);
  });

  test("getMyPitDutyCheckIns returns nothing to an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.schedules.getMyPitDutyCheckIns, { eventKey: EVENT })).toEqual([]);
  });

  test("getMySubmissions returns nothing to an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.forms.getMySubmissions, { eventKey: EVENT })).toEqual([]);
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
    // Coins now require an assignment — seed a matchAssignments row for a
    // given match number so these tests exercise the payout path, not the
    // assignment gate (that gate has its own tests below).
    const assign = (matchNumber: number) => t.run(async (ctx) => ctx.db.insert("matchAssignments", {
      eventKey: EVENT, matchNumber, matchLabel: `Q${matchNumber}`, position: "red1", scoutId: userId,
    }));
    return { as, templateId, bal, assign, userId };
  }

  test("re-submitting the same match does not pay again", async () => {
    const t = convexTest(schema, modules);
    const { as, templateId, bal, assign } = await scout(t);
    await assign(1);
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
    const { as, templateId, bal, assign } = await scout(t);
    await assign(1);
    await assign(2);
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
    await a.assign(1);
    await b.assign(1);
    const args = { eventKey: EVENT, matchNumber: 1, compLevel: "qm", teamNumber: 4099, data: "{}" } as const;
    await a.as.mutation(api.forms.submitForm, { ...args, templateId: a.templateId });
    await b.as.mutation(api.forms.submitForm, { ...args, templateId: b.templateId });
    expect(await a.bal()).toBe(1050);
    expect(await b.bal()).toBe(1050);
  });

  test("submitting an unassigned match does not pay", async () => {
    const t = convexTest(schema, modules);
    const { as, templateId, bal } = await scout(t);
    await as.mutation(api.forms.submitForm, {
      templateId, eventKey: EVENT, matchNumber: 9,
      compLevel: "qm", teamNumber: 4099, data: "{}",
    });
    expect(await bal()).toBe(0); // no balance row created — submission is accepted, just unpaid
  });

  test("super scouting never pays, even with a match assignment", async () => {
    const t = convexTest(schema, modules);
    const { as, bal, assign } = await scout(t);
    await assign(1);
    const superTemplateId = await t.run(async (ctx) => ctx.db.insert("formTemplates", {
      name: "Super", formType: "super", fields: [], isActive: true, coinReward: 50,
    }));
    await as.mutation(api.forms.submitForm, {
      templateId: superTemplateId, eventKey: EVENT, matchNumber: 1,
      compLevel: "qm", teamNumber: 4099, data: "{}",
    });
    expect(await bal()).toBe(0);
  });

  test("pit scouting pays only when on that team's pit roster", async () => {
    const t = convexTest(schema, modules);
    const { as, bal, userId } = await scout(t);
    const pitTemplateId = await t.run(async (ctx) => ctx.db.insert("formTemplates", {
      name: "Pit", formType: "pit", fields: [], isActive: true, coinReward: 50,
    }));
    // Not on the roster yet — should not pay.
    await as.mutation(api.forms.submitForm, {
      templateId: pitTemplateId, eventKey: EVENT, matchNumber: 0, teamNumber: 254, data: "{}",
    });
    expect(await bal()).toBe(0);

    // Add to the roster, then re-submit (a correction — still allowed, still unpaid a second time).
    await t.run(async (ctx) => ctx.db.insert("pitScoutingTeams", {
      eventKey: EVENT, teamNumber: 254, scoutIds: [userId],
    }));
    await as.mutation(api.forms.submitForm, {
      templateId: pitTemplateId, eventKey: EVENT, matchNumber: 0, teamNumber: 254, data: "{}",
    });
    expect(await bal()).toBe(0); // still not paid — first accepted submission for this team wasn't eligible

    // A fresh team this scout IS rostered for pays.
    await t.run(async (ctx) => ctx.db.insert("pitScoutingTeams", {
      eventKey: EVENT, teamNumber: 1114, scoutIds: [userId],
    }));
    await as.mutation(api.forms.submitForm, {
      templateId: pitTemplateId, eventKey: EVENT, matchNumber: 0, teamNumber: 1114, data: "{}",
    });
    expect(await bal()).toBe(1050);
  });

  test("checklist pays only when on a qual pit rotation covering the match", async () => {
    const t = convexTest(schema, modules);
    const { as, bal, userId } = await scout(t);
    const checklistTemplateId = await t.run(async (ctx) => ctx.db.insert("formTemplates", {
      name: "Checklist", formType: "checklist", fields: [], isActive: true, coinReward: 25,
    }));
    // No rotation yet — should not pay.
    await as.mutation(api.forms.submitForm, {
      templateId: checklistTemplateId, eventKey: EVENT, matchNumber: 5, teamNumber: 0, data: "{}",
    });
    expect(await bal()).toBe(0);

    await t.run(async (ctx) => ctx.db.insert("pitRotations", {
      eventKey: EVENT, startMatch: 1, endMatch: 10, isElims: false, scoutIds: [userId],
    }));
    // Same match+template is already recorded as submitted (offline retries aside, this is
    // a correction) — the offlineId-less path always inserts a new row, so this pays once,
    // matched by the alreadyScouted-equivalent identity for checklists: matchNumber+teamNumber.
    // Use a different match number covered by the rotation to get a clean "first submission" case.
    await as.mutation(api.forms.submitForm, {
      templateId: checklistTemplateId, eventKey: EVENT, matchNumber: 6, teamNumber: 0, data: "{}",
    });
    expect(await bal()).toBe(1025);
  });
});
