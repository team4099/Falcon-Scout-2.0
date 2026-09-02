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

const DEFAULT_HASH =
  "8f0e2f76e22b43e2855189877e7dc1e1e7d98c226c95db247cd1d547928334a9";
const modules = import.meta.glob("./**/*.ts");
const admin = { subject: "admin|1", issuer: "test" };

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
    await expect(
      t.withIdentity(admin).mutation(api.forms.backfillCompLevel, {}),
    ).rejects.toThrow(/Admin access required/i);
  });

  test("recovers what it can and leaves orphans unset", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const result = await t
      .withIdentity(admin)
      .mutation(api.forms.backfillCompLevel, { adminKey: DEFAULT_HASH });

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
    await as.mutation(api.forms.backfillCompLevel, { adminKey: DEFAULT_HASH });
    const second = await as.mutation(api.forms.backfillCompLevel, { adminKey: DEFAULT_HASH });
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
      .mutation(api.forms.backfillCompLevel, { adminKey: DEFAULT_HASH });
    expect(r.unrecoverable).toBe(1);
  });
});

describe("submitForm", () => {
  test("persists compLevel so qual N and elim N stay distinct", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "S" }));
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
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "S" }));
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
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "S" }));
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
});
