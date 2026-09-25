/**
 * Event roster: only admins manage it, it's per current event, adding by
 * email works before someone has signed in (and approves a guest), and
 * deactivation / sign-back-in interact with it as the Manage Scouts UI expects.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const GUEST_EMAIL = "guest@example.org";

async function setup({ event = "2026vabla" }: { event?: string | null } = {}) {
  const t = convexTest(schema, modules);
  const [chiefId, scoutId, guestId] = await t.run(async (ctx) => {
    if (event) {
      await ctx.db.insert("eventSettings", {
        key: "current_event", eventKey: event, eventName: "Test", updatedAt: 0,
      });
    }
    return [
      await ctx.db.insert("users", { name: "Chief", email: "czhao@team4099.com" }),
      await ctx.db.insert("users", { name: "Scout", email: "scout@team4099.com" }),
      await ctx.db.insert("users", { name: "Guest", email: GUEST_EMAIL }),
    ];
  });
  const admin = t.withIdentity({ subject: chiefId, issuer: "test", email: "czhao@team4099.com" });
  const scout = t.withIdentity({ subject: scoutId, issuer: "test", email: "scout@team4099.com" });
  const guest = t.withIdentity({ subject: guestId, issuer: "test", email: GUEST_EMAIL });
  const onRoster = async (id: string) =>
    (await admin.query(api.users.listUsers, {})).find((u) => u._id === id)?.onRoster;
  return { t, admin, scout, guest, chiefId, scoutId, guestId, onRoster };
}

describe("event roster", () => {
  test("signing in doesn't put anyone on the roster; an admin add does", async () => {
    const { admin, scoutId, onRoster } = await setup();
    expect(await onRoster(scoutId)).toBe(false);
    expect(await admin.mutation(api.roster.addToRoster, { userIds: [scoutId, scoutId] })).toBe(1);
    expect(await onRoster(scoutId)).toBe(true);
    // idempotent
    expect(await admin.mutation(api.roster.addToRoster, { userIds: [scoutId] })).toBe(0);
    await admin.mutation(api.roster.removeFromRoster, { userId: scoutId });
    expect(await onRoster(scoutId)).toBe(false);
  });

  test("non-admins can't touch the roster", async () => {
    const { scout, scoutId } = await setup();
    await expect(scout.mutation(api.roster.addToRoster, { userIds: [scoutId] })).rejects.toThrow(/Admin access/);
    await expect(scout.mutation(api.roster.addToRosterByEmail, { email: "x@team4099.com" })).rejects.toThrow(/Admin access/);
    await expect(scout.mutation(api.roster.removeFromRoster, { userId: scoutId })).rejects.toThrow(/Admin access/);
  });

  test("requires a current event", async () => {
    const { admin, scoutId } = await setup({ event: null });
    await expect(admin.mutation(api.roster.addToRoster, { userIds: [scoutId] })).rejects.toThrow(/current event/);
  });

  test("rosters are per event", async () => {
    const { t, admin, scoutId, onRoster } = await setup();
    await admin.mutation(api.roster.addToRoster, { userIds: [scoutId] });
    await admin.mutation(api.events.setCurrentEvent, { eventKey: "2026mdbet", eventName: "Next" });
    expect(await onRoster(scoutId)).toBe(false);
    await admin.mutation(api.events.setCurrentEvent, { eventKey: "2026vabla", eventName: "Test" });
    expect(await onRoster(scoutId)).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("eventRoster").collect())).toHaveLength(1);
  });

  test("an unapproved guest can't be added by id", async () => {
    const { admin, guest, guestId } = await setup();
    await guest.mutation(api.guests.requestAccess, { teamNumber: 254 });
    await expect(admin.mutation(api.roster.addToRoster, { userIds: [guestId] })).rejects.toThrow(/approved first/);
  });

  test("adding a never-signed-in team email creates a placeholder on the roster", async () => {
    const { t, admin } = await setup();
    const id = await admin.mutation(api.roster.addToRosterByEmail, { email: "  New@Team4099.com " });
    const user = await t.run((ctx) => ctx.db.get(id));
    expect(user).toMatchObject({ email: "new@team4099.com", name: "new" });
    expect(user?.emailVerificationTime).toBeTypeOf("number");
    const listed = (await admin.query(api.users.listUsers, {})).find((u) => u._id === id);
    expect(listed?.onRoster).toBe(true);
    await expect(admin.mutation(api.roster.addToRosterByEmail, { email: "new@team4099.com" })).rejects.toThrow(/already/);
  });

  test("adding a guest email approves them and puts them on the roster", async () => {
    const { admin, guest, guestId, onRoster } = await setup();
    await guest.mutation(api.guests.requestAccess, {});
    await admin.mutation(api.roster.addToRosterByEmail, { email: GUEST_EMAIL });
    expect(await guest.query(api.guests.myAccess, {})).toEqual({ status: "approved" });
    expect(await onRoster(guestId)).toBe(true);
    const row = (await admin.query(api.guests.listRequests, {})).find((r) => r.email === GUEST_EMAIL);
    expect(row).toMatchObject({ userId: guestId, onRoster: true });
  });

  test("rejects a malformed email", async () => {
    const { admin } = await setup();
    await expect(admin.mutation(api.roster.addToRosterByEmail, { email: "nope" })).rejects.toThrow(/valid email/);
  });

  test("deactivating drops them from the roster; signing back in lands them off-roster", async () => {
    const { admin, scout, scoutId, onRoster } = await setup();
    await admin.mutation(api.roster.addToRoster, { userIds: [scoutId] });
    await admin.mutation(api.admin.deactivateUser, { userId: scoutId });
    expect(await onRoster(scoutId)).toBeUndefined(); // hidden entirely
    await scout.mutation(api.users.reactivateSelf, {});
    expect(await onRoster(scoutId)).toBe(false);
  });
});

describe("guest panel", () => {
  test("pendingCount counts waiting guests for admins only, ignoring deactivated ones", async () => {
    const { admin, scout, guest, guestId } = await setup();
    expect(await admin.query(api.guests.pendingCount, {})).toBe(0);
    await guest.mutation(api.guests.requestAccess, {});
    expect(await admin.query(api.guests.pendingCount, {})).toBe(1);
    expect(await scout.query(api.guests.pendingCount, {})).toBe(0);
    await admin.mutation(api.admin.deactivateUser, { userId: guestId });
    expect(await admin.query(api.guests.pendingCount, {})).toBe(0);
  });

  test("a deactivated guest is hidden from the panel until they sign back in", async () => {
    const { admin, guest, guestId } = await setup();
    await guest.mutation(api.guests.requestAccess, {});
    await admin.mutation(api.admin.deactivateUser, { userId: guestId });
    expect(await admin.query(api.guests.listRequests, {})).toHaveLength(0);
    // a pending guest isn't approved, but can still clear their own deactivation
    await guest.mutation(api.users.reactivateSelf, {});
    expect(await admin.query(api.guests.listRequests, {})).toHaveLength(1);
  });
});
