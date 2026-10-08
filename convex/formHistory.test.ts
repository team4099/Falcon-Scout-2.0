/**
 * An event keeps the form it was scouted with.
 *
 *  - Changing a form's format (or deleting the form) freezes a copy for every
 *    earlier event that has reports on it; those events keep reading that copy.
 *  - The current event follows the edit unless the admin asks to keep it.
 *  - Activating a different form for the next game doesn't change which form an
 *    old event counts as "its" form.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OLD = "2025chcmp";
const NEW = "2026vaale";

const field = (id: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: "counter" as const, label, required: false, ...extra });
const GAME_2025 = [field("f1", "Coral scored"), field("f2", "Algae scored")];
const GAME_2026 = [field("f1", "Fuel scored"), field("f3", "Climb level")];

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const adminId = await ctx.db.insert("users", { name: "Admin", email: "admin@team4099.com" });
    const scoutId = await ctx.db.insert("users", { name: "Scout", email: "scout@team4099.com" });
    const guestId = await ctx.db.insert("users", { name: "Guest", email: "guest@example.org" });
    await ctx.db.insert("guestAccess", { email: "guest@example.org", status: "approved", requestedAt: 1 });
    const templateId = await ctx.db.insert("formTemplates", { name: "Match 2025", fields: GAME_2025, isActive: true });
    return { adminId, scoutId, guestId, templateId };
  });
  const admin = t.withIdentity({ subject: ids.adminId, issuer: "test", email: "czhao@team4099.com" });
  const scout = t.withIdentity({ subject: ids.scoutId, issuer: "test" });
  const guest = t.withIdentity({ subject: ids.guestId, issuer: "test" });
  const report = (eventKey: string, templateId = ids.templateId) =>
    scout.mutation(api.forms.submitForm, {
      templateId, eventKey, matchNumber: 1, compLevel: "qm", teamNumber: 4099, data: JSON.stringify({ f1: 3, f2: 1 }),
    });
  const setEvent = (eventKey: string) =>
    admin.mutation(api.events.setCurrentEvent, { eventKey, eventName: eventKey });
  /** The form as `eventKey` sees it: its name and field labels. */
  const formAt = async (eventKey: string, templateId = ids.templateId) => {
    const form = (await scout.query(api.forms.listEventTemplates, { eventKey })).find((f) => f._id === templateId);
    return form && { name: form.name, labels: form.fields.map((f) => f.label), isActive: form.isActive };
  };
  return { t, ...ids, admin, scout, guest, report, setEvent, formAt };
}

describe("editing a form", () => {
  test("an earlier event keeps the old format; the new event gets the new one", async () => {
    const { admin, templateId, report, setEvent, formAt } = await setup();
    await setEvent(OLD);
    await report(OLD);
    await setEvent(NEW);

    await admin.mutation(api.forms.updateTemplate, { id: templateId, name: "Match 2026", fields: GAME_2026 });
    // …and again: the frozen copy must not be overwritten by a later edit.
    await admin.mutation(api.forms.updateTemplate, { id: templateId, fields: [field("f9", "Something else")] });

    expect(await formAt(OLD)).toMatchObject({ name: "Match 2025", labels: ["Coral scored", "Algae scored"] });
    expect(await formAt(NEW)).toMatchObject({ name: "Match 2026", labels: ["Something else"] });
  });

  test("the current event follows the edit by default", async () => {
    const { t, admin, templateId, report, setEvent, formAt } = await setup();
    await setEvent(OLD);
    await report(OLD);

    await admin.mutation(api.forms.updateTemplate, { id: templateId, fields: [field("f1", "Coral scored (total)")] });

    expect((await formAt(OLD))?.labels).toEqual(["Coral scored (total)"]);
    expect(await t.run((ctx) => ctx.db.query("formTemplateSnapshots").collect())).toHaveLength(0);
  });

  test("keepCurrentEvent pins the current event too, and stops the builder asking", async () => {
    const { admin, scout, templateId, report, setEvent, formAt } = await setup();
    await setEvent(OLD);
    await report(OLD);
    expect(await scout.query(api.forms.currentEventReports, { id: templateId })).toMatchObject({ eventKey: OLD });

    await admin.mutation(api.forms.updateTemplate, {
      id: templateId, name: "Match 2026", fields: GAME_2026, keepCurrentEvent: true,
    });

    expect(await formAt(OLD)).toMatchObject({ name: "Match 2025", labels: ["Coral scored", "Algae scored"] });
    expect(await scout.query(api.forms.currentEventReports, { id: templateId })).toBeNull();
    await setEvent(NEW);
    expect(await formAt(NEW)).toMatchObject({ name: "Match 2026", labels: ["Fuel scored", "Climb level"] });
  });

  test("settings that aren't format freeze nothing", async () => {
    const { t, admin, templateId, report, setEvent } = await setup();
    await setEvent(OLD);
    await report(OLD);
    await setEvent(NEW);

    await admin.mutation(api.forms.updateTemplate, {
      id: templateId, description: "notes", coinReward: 75,
      fields: GAME_2025.map((f) => ({ ...f, showInRankings: true })),
    });

    expect(await t.run((ctx) => ctx.db.query("formTemplateSnapshots").collect())).toHaveLength(0);
  });

  test("a Rankings-column tag still reaches a frozen event's surviving fields", async () => {
    const { admin, scout, templateId, report, setEvent } = await setup();
    await setEvent(OLD);
    await report(OLD);
    await setEvent(NEW);
    // f1 survives (same id and type, tagged); f2 is dropped.
    await admin.mutation(api.forms.updateTemplate, {
      id: templateId, fields: [field("f1", "Fuel scored", { showInRankings: true })],
    });

    const old = (await scout.query(api.forms.listEventTemplates, { eventKey: OLD }))[0];
    expect(old.fields.map((f) => [f.label, f.showInRankings ?? false])).toEqual([
      ["Coral scored", true],
      ["Algae scored", false],
    ]);
  });

  test("only an admin can change a form", async () => {
    const { scout, templateId } = await setup();
    await expect(
      scout.mutation(api.forms.updateTemplate, { id: templateId, fields: GAME_2026, keepCurrentEvent: true }),
    ).rejects.toThrow(/Admin access required/i);
  });
});

describe("deleting or replacing a form", () => {
  test("a deleted form's reports keep their form", async () => {
    const { admin, scout, templateId, report, setEvent, formAt } = await setup();
    await setEvent(OLD);
    await report(OLD);

    await admin.mutation(api.forms.deleteTemplate, { id: templateId });

    expect(await scout.query(api.forms.listTemplates, {})).toEqual([]);
    expect(await formAt(OLD)).toMatchObject({ name: "Match 2025", labels: ["Coral scored", "Algae scored"] });
    // An event that never used it doesn't get it back.
    expect(await formAt(NEW)).toBeUndefined();
  });

  test("an old event's match form stays its own after a new one is activated", async () => {
    const { t, admin, report, setEvent, formAt } = await setup();
    await setEvent(OLD);
    await report(OLD);
    await setEvent(NEW);
    const nextId = await t.run((ctx) =>
      ctx.db.insert("formTemplates", { name: "Match 2026", fields: GAME_2026, isActive: false }));
    await admin.mutation(api.forms.activateTemplate, { id: nextId });

    expect((await formAt(OLD))?.isActive).toBe(true);
    expect((await formAt(OLD, nextId))?.isActive).toBe(false);
    // Nothing filed at the new event yet: it uses the live active form.
    expect((await formAt(NEW, nextId))?.isActive).toBe(true);
    expect((await formAt(NEW))?.isActive).toBe(false);
  });
});

describe("access", () => {
  test("a guest only gets the forms of an event they are on", async () => {
    const { t, guest, guestId, adminId, report, setEvent } = await setup();
    await setEvent(OLD);
    await report(OLD);
    expect(await guest.query(api.forms.listEventTemplates, { eventKey: OLD })).toEqual([]);

    await t.run((ctx) => ctx.db.insert("eventRoster", { eventKey: OLD, userId: guestId, addedAt: 1, addedBy: adminId }));
    expect(await guest.query(api.forms.listEventTemplates, { eventKey: OLD })).toHaveLength(1);
  });
});
