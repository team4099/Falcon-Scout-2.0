/**
 * Submission + backfill behaviour.
 *
 * The compLevel backfill is the one fix that touches historical data, so its
 * recovery rules are pinned down here: rows written by the online path carry
 * _matchPrefix and can be recovered; rows that synced through the old offline
 * queue never stored it and must be left unset rather than guessed.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
// Admin access is tied to the caller's Google identity email (see
// convex/adminAuth.ts), so this identity is only "admin" once it carries an
// allowlisted email.
const admin = { subject: "admin|1", issuer: "test", email: "czhao@team4099.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const templateId = await ctx.db.insert("formTemplates", {
      name: "Match", fields: [], isActive: true,
    });
    const row = (
      matchNumber: number,
      data: Record<string, unknown>,
      compLevel?: "qm" | "elim",
    ) =>
      ctx.db.insert("formSubmissions", {
        templateId, eventKey: "2025chcmp", matchNumber, teamNumber: 4099,
        data: JSON.stringify(data), syncedAt: Date.now(),
        ...(compLevel ? { compLevel } : {}),
      });

    return {
      templateId,
      // written by the online path before the column existed — recoverable
      legacyQual: await row(5, { _matchPrefix: "qm", _matchNumber: 5, x: 1 }),
      legacyElim: await row(5, { _matchPrefix: "elim", _matchNumber: 5, x: 2 }),
      // synced through the old offline queue — no prefix was ever stored
      orphan: await row(9, { x: 3 }),
      // already migrated
      modern: await row(12, { _matchPrefix: "qm", x: 4 }, "qm"),
    };
  });
}

describe("backfillCompLevel", () => {
  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    const nonAdmin = { subject: "scout|1", issuer: "test", email: "scout@team4099.com" };
    await expect(
      t.withIdentity(nonAdmin).mutation(api.forms.backfillCompLevel, {}),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("recovers what it can and leaves orphans unset", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const result = await t
      .withIdentity(admin)
      .mutation(api.forms.backfillCompLevel, {});

    expect(result).toEqual({
      total: 4,
      updated: 2,        // the two legacy rows
      alreadySet: 1,     // the modern row
      unrecoverable: 1,  // the orphan
    });

    const got = await t.run(async (ctx) => ({
      legacyQual: (await ctx.db.get(ids.legacyQual))?.compLevel,
      legacyElim: (await ctx.db.get(ids.legacyElim))?.compLevel,
      orphan: (await ctx.db.get(ids.orphan))?.compLevel,
      modern: (await ctx.db.get(ids.modern))?.compLevel,
    }));

    expect(got.legacyQual).toBe("qm");
    expect(got.legacyElim).toBe("elim");
    // Critically: NOT defaulted to "qm". A wrong comp level silently corrupts
    // averages; an unknown one is honest.
    expect(got.orphan).toBeUndefined();
    expect(got.modern).toBe("qm");
  });

  test("is safe to run twice", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const as = t.withIdentity(admin);
    await as.mutation(api.forms.backfillCompLevel, {});
    const second = await as.mutation(api.forms.backfillCompLevel, {});
    expect(second).toEqual({ total: 4, updated: 0, alreadySet: 3, unrecoverable: 1 });
  });

  test("survives a row whose data is not valid JSON", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const templateId = await ctx.db.insert("formTemplates", {
        name: "T", fields: [], isActive: true,
      });
      await ctx.db.insert("formSubmissions", {
        templateId, eventKey: "e", matchNumber: 1, teamNumber: 1,
        data: "{not json", syncedAt: Date.now(),
      });
    });
    const r = await t
      .withIdentity(admin)
      .mutation(api.forms.backfillCompLevel, {});
    expect(r.unrecoverable).toBe(1);
  });
});

describe("submitForm", () => {
  test("persists compLevel so qual N and elim N stay distinct", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "S", email: "s@team4099.com" }));
    const as = t.withIdentity({ subject: userId, issuer: "test" });
    const templateId = await t.run(async (ctx) =>
      ctx.db.insert("formTemplates", { name: "T", fields: [], isActive: true }),
    );

    await as.mutation(api.forms.submitForm, {
      templateId, eventKey: "2025chcmp", matchNumber: 5,
      compLevel: "qm", teamNumber: 4099, data: "{}",
    });
    await as.mutation(api.forms.submitForm, {
      templateId, eventKey: "2025chcmp", matchNumber: 5,
      compLevel: "elim", teamNumber: 4099, data: "{}",
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("formSubmissions").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.compLevel).sort()).toEqual(["elim", "qm"]);
  });

  test("offlineId makes a replayed submission idempotent", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "S", email: "s@team4099.com" }));
    const as = t.withIdentity({ subject: userId, issuer: "test" });
    const templateId = await t.run(async (ctx) =>
      ctx.db.insert("formTemplates", { name: "T", fields: [], isActive: true }),
    );

    const args = {
      templateId, eventKey: "2025chcmp", matchNumber: 3,
      compLevel: "qm" as const, teamNumber: 4099, data: "{}",
      offlineId: "fixed-uuid",
    };
    const a = await as.mutation(api.forms.submitForm, args);
    const b = await as.mutation(api.forms.submitForm, args);

    expect(a).toBe(b);
    expect(await t.run(async (ctx) =>
      (await ctx.db.query("formSubmissions").collect()).length,
    )).toBe(1);
  });

  test("rejects a team that is not on the event roster", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "S", email: "s@team4099.com" }));
    const as = t.withIdentity({ subject: userId, issuer: "test" });
    const templateId = await t.run(async (ctx) => {
      await ctx.db.insert("eventTeamRosters", {
        eventKey: "2025chcmp", teamNumbers: [4099, 254], updatedAt: Date.now(),
      });
      return ctx.db.insert("formTemplates", { name: "T", fields: [], isActive: true });
    });

    await expect(
      as.mutation(api.forms.submitForm, {
        templateId, eventKey: "2025chcmp", matchNumber: 1,
        teamNumber: 9999, data: "{}",
      }),
    ).rejects.toThrow(/not registered at this event/i);
  });

  test("an empty roster row means unknown, not empty — submission goes through", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "S", email: "s@team4099.com" }));
    const as = t.withIdentity({ subject: userId, issuer: "test" });
    const templateId = await t.run(async (ctx) => {
      await ctx.db.insert("eventTeamRosters", {
        eventKey: "2025chcmp", teamNumbers: [], updatedAt: Date.now(),
      });
      return ctx.db.insert("formTemplates", { name: "T", fields: [], isActive: true });
    });

    await as.mutation(api.forms.submitForm, {
      templateId, eventKey: "2025chcmp", matchNumber: 1,
      teamNumber: 9999, data: "{}",
    });

    expect(await t.run(async (ctx) =>
      (await ctx.db.query("formSubmissions").collect()).length,
    )).toBe(1);
  });
});

describe("updateTemplate description", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      ctx.db.insert("formTemplates", {
        name: "Pit", description: "old notes", fields: [], isActive: false,
      }),
    );
    return { t, id, as: t.withIdentity(admin) };
  }
  const desc = async ({ t, id }: Awaited<ReturnType<typeof setup>>) =>
    (await t.run((ctx) => ctx.db.get(id)))?.description;

  test("an emptied description is removed, not silently kept", async () => {
    const s = await setup();
    await s.as.mutation(api.forms.updateTemplate, { id: s.id, description: "  " });
    expect(await desc(s)).toBeUndefined();
  });

  test("edits are trimmed; omitting it leaves it alone", async () => {
    const s = await setup();
    await s.as.mutation(api.forms.updateTemplate, { id: s.id, name: "Pit 2" });
    expect(await desc(s)).toBe("old notes");
    await s.as.mutation(api.forms.updateTemplate, { id: s.id, description: " new " });
    expect(await desc(s)).toBe("new");
  });
});

describe("several forms per type, one active", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const as = t.withIdentity(admin);
    const create = (name: string, formType: "default" | "pit", isActive = false) =>
      as.mutation(api.forms.createTemplate, { name, formType, fields: [], isActive });
    /** Names of the active forms, sorted. */
    const active = async () =>
      (await as.query(api.forms.listActiveTemplates, {})).map((f) => f.name).sort();
    return { t, as, create, active };
  }

  test("activating a form deactivates the old one of its type, and only that", async () => {
    const { t, as, create, active } = await setup();
    const match25 = await create("Match 2025", "default", true);
    await create("Pit 2025", "pit", true);
    const match26 = await create("Match 2026", "default");

    const result = await as.mutation(api.forms.activateTemplate, { id: match26 });

    expect(result.deactivated).toEqual(["Match 2025"]);
    expect(await active()).toEqual(["Match 2026", "Pit 2025"]);
    // Deactivated, not deleted.
    expect(await t.run((ctx) => ctx.db.get(match25))).toMatchObject({ name: "Match 2025", isActive: false });
  });

  test("a form created active replaces the active one", async () => {
    const { create, active } = await setup();
    await create("Match 2025", "default", true);
    await create("Match 2026", "default", true);
    expect(await active()).toEqual(["Match 2026"]);
  });

  test("an active form moved to a type that already has one goes inactive", async () => {
    const { as, create, active } = await setup();
    await create("Match", "default", true);
    const pit = await create("Pit", "pit", true);

    expect(await as.mutation(api.forms.updateTemplate, { id: pit, formType: "default" })).toEqual({ isActive: false });
    expect(await active()).toEqual(["Match"]);
  });

  test("an active form moved to a free type stays active", async () => {
    const { as, create, active } = await setup();
    const match = await create("Match", "default", true);
    await as.mutation(api.forms.updateTemplate, { id: match, formType: "pit" });
    expect(await active()).toEqual(["Match"]);
  });

  test("the active forms carry over when a new event is set", async () => {
    const { as, create, active } = await setup();
    await as.mutation(api.events.setCurrentEvent, { eventKey: "2025chcmp", eventName: "Champs" });
    await create("Match 2025", "default", true);
    await create("Match draft", "default");
    await create("Pit 2025", "pit", true);

    await as.mutation(api.events.setCurrentEvent, { eventKey: "2026vaale", eventName: "Alexandria" });

    expect(await active()).toEqual(["Match 2025", "Pit 2025"]);
    const atNewEvent = await as.query(api.forms.listEventTemplates, { eventKey: "2026vaale" });
    expect(atNewEvent.filter((f) => f.isActive).map((f) => f.name).sort()).toEqual(["Match 2025", "Pit 2025"]);
  });

  test("reorderTemplates saves the sidebar order and is admin-only", async () => {
    const { t, as, create } = await setup();
    const a = await create("A", "default");
    const b = await create("B", "pit");
    const c = await create("C", "default");

    await as.mutation(api.forms.reorderTemplates, { ids: [c, a, b] });

    const order = (await as.query(api.forms.listTemplates, {}))
      .sort((x, y) => x.sortOrder! - y.sortOrder!)
      .map((f) => f.name);
    expect(order).toEqual(["C", "A", "B"]);
    await expect(
      t.withIdentity({ subject: "scout|1", issuer: "test", email: "scout@team4099.com" })
        .mutation(api.forms.reorderTemplates, { ids: [a, b, c] }),
    ).rejects.toThrow(/Admin access required/i);
  });
});
