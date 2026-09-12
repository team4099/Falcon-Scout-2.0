/**
 * The JWT `customClaims` hook is what stamps a user's email onto their
 * session token — without it, `ctx.auth.getUserIdentity()?.email` is always
 * undefined in a real deployment, silently breaking the admin allowlist in
 * adminAuth.ts even though adminAuth's own tests pass (convex-test's
 * `withIdentity` lets you set `email` directly, bypassing real token
 * generation, so that bug had no coverage before this file). See
 * convex/auth.ts.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { authCustomClaims } from "./auth";

const modules = import.meta.glob("./**/*.ts");

describe("authCustomClaims", () => {
  test("stamps the user's stored email onto the token", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Chief", email: "czhao@team4099.com" }),
    );
    const claims = await t.run((ctx) => authCustomClaims(ctx, { userId }));
    expect(claims).toEqual({ email: "czhao@team4099.com" });
  });

  test("returns undefined email for a user with none set", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Scout" }));
    const claims = await t.run((ctx) => authCustomClaims(ctx, { userId }));
    expect(claims).toEqual({ email: undefined });
  });
});
