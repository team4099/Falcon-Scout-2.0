/**
 * Guest access: a non-@team4099.com account can sign in and apply, sees no
 * team data until an admin approves, and loses it again if revoked. The
 * gate lives in requireUser / getApprovedUserId (adminAuth.ts), so these
 * tests exercise it through ordinary scout-facing functions too.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const GUEST_EMAIL = "guest@example.org";

async function setup() {
  const t = convexTest(schema, modules);
  const [chiefId, guestId, scoutId] = await t.run(async (ctx) => [
    await ctx.db.insert("users", { name: "Chief", email: "czhao@team4099.com" }),
    await ctx.db.insert("users", { name: "Guest", email: GUEST_EMAIL }),
    await ctx.db.insert("users", { name: "Scout", email: "scout@team4099.com" }),
  ]);
  return {
    t,
    admin: t.withIdentity({ subject: chiefId, issuer: "test", email: "czhao@team4099.com" }),
    guest: t.withIdentity({ subject: guestId, issuer: "test", email: GUEST_EMAIL }),
    scout: t.withIdentity({ subject: scoutId, issuer: "test", email: "scout@team4099.com" }),
  };
}

describe("guest access", () => {
  test("a guest who hasn't applied has status none and is locked out", async () => {
    const { guest } = await setup();
    expect(await guest.query(api.guests.myAccess, {})).toEqual({ status: "none" });
    await expect(guest.query(api.users.listUsers, {})).rejects.toThrow(/approved/i);
    expect(await guest.query(api.users.getUserSettings, {})).toBeNull();
  });

  test("team members are never asked to apply", async () => {
    const { scout } = await setup();
    expect(await scout.query(api.guests.myAccess, {})).toEqual({ status: "team" });
    await expect(scout.mutation(api.guests.requestAccess, {})).rejects.toThrow(/don't need/i);
  });

  test("applying is idempotent and stays pending, still locked out", async () => {
    const { guest } = await setup();
    await guest.mutation(api.guests.requestAccess, { message: "  FRC alum  " });
    await guest.mutation(api.guests.requestAccess, { message: "again" });
    expect(await guest.query(api.guests.myAccess, {})).toEqual({ status: "pending" });
    await expect(guest.query(api.users.listUsers, {})).rejects.toThrow(/approved/i);
  });

  test("only an admin can see or decide requests", async () => {
    const { t, guest, scout, admin } = await setup();
    await guest.mutation(api.guests.requestAccess, {});
    const [row] = await admin.query(api.guests.listRequests, {});
    expect(row).toMatchObject({ email: GUEST_EMAIL, status: "pending", name: "Guest" });

    expect(await scout.query(api.guests.listRequests, {})).toEqual([]);
    expect(await guest.query(api.guests.listRequests, {})).toEqual([]);
    await expect(
      scout.mutation(api.guests.decideRequest, { id: row._id, decision: "approved" }),
    ).rejects.toThrow(/Admin access required/i);
    await expect(
      guest.mutation(api.guests.decideRequest, { id: row._id, decision: "approved" }),
    ).rejects.toThrow();

    const after = await t.run((ctx) => ctx.db.get(row._id));
    expect(after?.status).toBe("pending");
  });

  test("approval grants access immediately; revoking removes it", async () => {
    const { guest, admin } = await setup();
    await guest.mutation(api.guests.requestAccess, {});
    const [row] = await admin.query(api.guests.listRequests, {});

    await admin.mutation(api.guests.decideRequest, { id: row._id, decision: "approved" });
    expect(await guest.query(api.guests.myAccess, {})).toEqual({ status: "approved" });
    const users = await guest.query(api.users.listUsers, {});
    expect(users.map((u) => u.email)).toContain(GUEST_EMAIL);

    await admin.mutation(api.guests.decideRequest, { id: row._id, decision: "denied" });
    expect(await guest.query(api.guests.myAccess, {})).toEqual({ status: "denied" });
    await expect(guest.query(api.users.listUsers, {})).rejects.toThrow(/approved/i);
  });

  test("a denied guest cannot re-apply their way back in", async () => {
    const { guest, admin } = await setup();
    await guest.mutation(api.guests.requestAccess, {});
    const [row] = await admin.query(api.guests.listRequests, {});
    await admin.mutation(api.guests.decideRequest, { id: row._id, decision: "denied" });
    await guest.mutation(api.guests.requestAccess, {});
    expect(await guest.query(api.guests.myAccess, {})).toEqual({ status: "denied" });
  });

  test("unapproved guests are hidden from the scout pool and admin list; approved ones appear", async () => {
    const { guest, admin, scout } = await setup();
    await guest.mutation(api.guests.requestAccess, {});
    const emails = async () => (await scout.query(api.users.listUsers, {})).map((u) => u.email);
    expect(await emails()).not.toContain(GUEST_EMAIL);
    expect((await admin.query(api.admin.listAdminStatuses, {})).map((u) => u.email)).not.toContain(
      GUEST_EMAIL,
    );

    const [row] = await admin.query(api.guests.listRequests, {});
    await admin.mutation(api.guests.decideRequest, { id: row._id, decision: "approved" });
    expect(await emails()).toContain(GUEST_EMAIL);
  });

  test("approval matches the email case-insensitively", async () => {
    const { t, admin } = await setup();
    const mixedId = await t.run((ctx) => ctx.db.insert("users", { name: "M", email: "Mixed@Example.org" }));
    const mixed = t.withIdentity({ subject: mixedId, issuer: "test", email: "Mixed@Example.org" });
    await mixed.mutation(api.guests.requestAccess, {});
    const row = (await admin.query(api.guests.listRequests, {})).find((r) => r.email === "mixed@example.org");
    expect(row).toBeDefined();
    await admin.mutation(api.guests.decideRequest, { id: row!._id, decision: "approved" });
    expect(await mixed.query(api.users.listUsers, {})).toBeTruthy();
  });

  test("the guest's team number is stored and tags them in listUsers once approved", async () => {
    const { guest, admin, scout } = await setup();
    await expect(guest.mutation(api.guests.requestAccess, { teamNumber: 0 })).rejects.toThrow(/team number/i);
    await expect(guest.mutation(api.guests.requestAccess, { teamNumber: 25.4 })).rejects.toThrow(/team number/i);
    await guest.mutation(api.guests.requestAccess, { teamNumber: 254 });
    const [row] = await admin.query(api.guests.listRequests, {});
    expect(row.teamNumber).toBe(254);

    await admin.mutation(api.guests.decideRequest, { id: row._id, decision: "approved" });
    const users = await scout.query(api.users.listUsers, {});
    expect(users.find((u) => u.email === GUEST_EMAIL)).toMatchObject({ guestTeamNumber: 254 });
    // Team members never get a guest tag.
    expect(users.find((u) => u.email === "scout@team4099.com")).not.toHaveProperty("guestTeamNumber");
  });

  test("only an admin can set or clear an already-approved guest's team", async () => {
    const { guest, admin, scout } = await setup();
    await guest.mutation(api.guests.requestAccess, {}); // older client: no team
    const [row] = await admin.query(api.guests.listRequests, {});
    await admin.mutation(api.guests.decideRequest, { id: row._id, decision: "approved" });

    await expect(
      scout.mutation(api.guests.setTeamNumber, { id: row._id, teamNumber: 1678 }),
    ).rejects.toThrow(/Admin access required/i);
    await expect(
      admin.mutation(api.guests.setTeamNumber, { id: row._id, teamNumber: -5 }),
    ).rejects.toThrow(/team number/i);

    await admin.mutation(api.guests.setTeamNumber, { id: row._id, teamNumber: 1678 });
    const tagged = async () =>
      (await scout.query(api.users.listUsers, {})).find((u) => u.email === GUEST_EMAIL);
    expect(await tagged()).toMatchObject({ guestTeamNumber: 1678 });

    await admin.mutation(api.guests.setTeamNumber, { id: row._id, teamNumber: null });
    expect(await tagged()).not.toHaveProperty("guestTeamNumber");
  });
});
