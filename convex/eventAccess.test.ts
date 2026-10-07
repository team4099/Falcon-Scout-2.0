/**
 * Event scoping.
 *
 *  - Scouting reports belong to the event they were filed under: switching the
 *    current event hides them, switching back shows them again.
 *  - Team accounts can read any event by key.
 *  - A guest reads (and writes) only the events an admin added them to.
 *  - Setting a new event adds nobody to it.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OLD = "2025chcmp";
const NEW = "2026vaale";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const adminId = await ctx.db.insert("users", { name: "Admin", email: "admin@team4099.com" });
    const scoutId = await ctx.db.insert("users", { name: "Scout", email: "scout@team4099.com" });
    const guestId = await ctx.db.insert("users", { name: "Guest", email: "guest@example.org" });
    await ctx.db.insert("guestAccess", {
      email: "guest@example.org", status: "approved", requestedAt: 1,
    });
    const templateId = await ctx.db.insert("formTemplates", { name: "Match", fields: [], isActive: true });
    return { adminId, scoutId, guestId, templateId };
  });
  const admin = t.withIdentity({ subject: ids.adminId, issuer: "test", email: "czhao@team4099.com" });
  const scout = t.withIdentity({ subject: ids.scoutId, issuer: "test" });
  const guest = t.withIdentity({ subject: ids.guestId, issuer: "test" });
  const report = (eventKey: string, matchNumber: number) =>
    scout.mutation(api.forms.submitForm, {
      templateId: ids.templateId, eventKey, matchNumber, compLevel: "qm", teamNumber: 4099, data: "{}",
    });
  const addGuestTo = (eventKey: string) =>
    t.run(async (ctx) => ctx.db.insert("eventRoster", {
      eventKey, userId: ids.guestId, addedAt: 1, addedBy: ids.adminId,
    }));
  return { t, ...ids, admin, scout, guest, report, addGuestTo };
}

describe("reports are tied to their event", () => {
  test("switching the current event hides them; switching back restores them", async () => {
    const { admin, scout, report } = await setup();
    const current = async () => (await scout.query(api.events.getCurrentEvent, {}))!.eventKey;
    const shown = async () =>
      (await scout.query(api.forms.listSubmissions, { eventKey: await current() })).map((s) => s.matchNumber);

    await admin.mutation(api.events.setCurrentEvent, { eventKey: OLD, eventName: "Champs" });
    await report(OLD, 1);
    await report(OLD, 2);
    expect(await shown()).toEqual([1, 2]);

    await admin.mutation(api.events.setCurrentEvent, { eventKey: NEW, eventName: "Alexandria" });
    expect(await shown()).toEqual([]);
    await report(NEW, 7);
    expect(await shown()).toEqual([7]);

    await admin.mutation(api.events.setCurrentEvent, { eventKey: OLD, eventName: "Champs" });
    expect(await shown()).toEqual([1, 2]);
  });

  test("setting a new event adds nobody to it, and every past event stays listed", async () => {
    const { t, admin, scout } = await setup();
    await admin.mutation(api.events.setCurrentEvent, { eventKey: OLD, eventName: "Champs" });
    await admin.mutation(api.events.setCurrentEvent, { eventKey: NEW, eventName: "Alexandria" });

    expect(await t.run(async (ctx) => ctx.db.query("eventRoster").collect())).toHaveLength(0);
    const mine = await scout.query(api.events.listEvents, {});
    expect(mine?.isGuest).toBe(false);
    expect(mine?.events).toEqual([
      { eventKey: NEW, eventName: "Alexandria", isCurrent: true, onRoster: false },
      { eventKey: OLD, eventName: "Champs", isCurrent: false, onRoster: false },
    ]);
  });
});

describe("who can open an event", () => {
  test("a team account reads any event by key, roster or not", async () => {
    const { scout, report } = await setup();
    await report(OLD, 1);
    expect(await scout.query(api.forms.listSubmissions, { eventKey: OLD })).toHaveLength(1);
    expect(await scout.query(api.forms.listSubmissionSummaries, { eventKey: OLD })).toHaveLength(1);
  });

  test("an approved guest sees nothing until they are added to that event", async () => {
    const { guest, report, addGuestTo } = await setup();
    const id = await report(OLD, 1);
    await report(NEW, 2);

    expect(await guest.query(api.forms.listSubmissions, { eventKey: OLD })).toEqual([]);
    expect(await guest.query(api.forms.getTeamSubmissions, { eventKey: OLD, teamNumber: 4099 })).toEqual([]);
    expect(await guest.query(api.forms.getSubmission, { id })).toBeNull();
    expect(await guest.query(api.schedules.listMatchAssignments, { eventKey: OLD })).toEqual([]);
    expect(await guest.query(api.betting.getLeaderboard, { eventKey: OLD })).toEqual([]);
    expect(await guest.query(api.kanban.getCentralBoard, { eventKey: OLD })).toBeNull();
    expect((await guest.query(api.events.listEvents, {}))).toEqual({ isGuest: true, events: [] });

    await addGuestTo(OLD);
    expect(await guest.query(api.forms.listSubmissions, { eventKey: OLD })).toHaveLength(1);
    expect(await guest.query(api.forms.getSubmission, { id })).not.toBeNull();
    // Still only that event.
    expect(await guest.query(api.forms.listSubmissions, { eventKey: NEW })).toEqual([]);
    expect((await guest.query(api.events.listEvents, {}))?.events.map((e) => e.eventKey)).toEqual([OLD]);
  });

  test("a guest cannot file a report for an event they are not on", async () => {
    const { t, guest, templateId, addGuestTo } = await setup();
    const args = { templateId, matchNumber: 1, compLevel: "qm", teamNumber: 4099, data: "{}" } as const;
    await expect(
      guest.mutation(api.forms.submitForm, { ...args, eventKey: NEW }),
    ).rejects.toThrow(/haven't been added/);

    await addGuestTo(NEW);
    await guest.mutation(api.forms.submitForm, { ...args, eventKey: NEW });
    await expect(
      guest.mutation(api.forms.submitForm, { ...args, eventKey: OLD }),
    ).rejects.toThrow(/haven't been added/);
    expect(await t.run(async (ctx) => ctx.db.query("formSubmissions").collect())).toHaveLength(1);
  });
});
