/**
 * Picklist ordering. moveCard used to patch only the moved card's position, so
 * a column accumulated duplicate positions and a within-tier reorder could
 * land in a tie and appear not to move.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { byPosition, planMove } from "./kanbanOrder";

const modules = import.meta.glob("./**/*.ts");
const EVENT = "2025chcmp";

const card = (_id: string, columnId: string, position: number, _creationTime = 0) =>
  ({ _id, columnId, position, _creationTime });

function order(cards: ReturnType<typeof card>[], col: string) {
  return cards.filter((c) => c.columnId === col).sort(byPosition).map((c) => c._id);
}

function apply(cards: ReturnType<typeof card>[], id: string, col: string, pos: number) {
  const moves = new Map(planMove(cards, id, col, pos).map((m) => [m.card._id, m]));
  return cards.map((c) => {
    const m = moves.get(c._id);
    return m ? { ...c, columnId: m.columnId, position: m.position } : c;
  });
}

describe("planMove", () => {
  test("moving to the top of a column with duplicate positions sticks", () => {
    // Legacy data: every card claims position 0.
    const cards = [card("a", "t", 0, 1), card("b", "t", 0, 2), card("c", "t", 0, 3)];
    expect(order(apply(cards, "c", "t", 0), "t")).toEqual(["c", "a", "b"]);
  });

  test("reorders within a column and renumbers 0..n-1", () => {
    const cards = [card("a", "t", 0), card("b", "t", 1), card("c", "t", 2), card("d", "t", 3)];
    const next = apply(cards, "a", "t", 2);
    expect(order(next, "t")).toEqual(["b", "c", "a", "d"]);
    expect(next.map((c) => c.position).sort()).toEqual([0, 1, 2, 3]);
  });

  test("cross-column move closes the gap it leaves", () => {
    const cards = [card("a", "x", 0), card("b", "x", 1), card("c", "x", 2), card("d", "y", 0)];
    const next = apply(cards, "b", "y", 0);
    expect(order(next, "y")).toEqual(["b", "d"]);
    expect(next.filter((c) => c.columnId === "x").map((c) => c.position)).toEqual([0, 1]);
  });

  test("out-of-range positions clamp, unknown card is a no-op", () => {
    const cards = [card("a", "t", 0), card("b", "t", 1)];
    expect(order(apply(cards, "a", "t", 99), "t")).toEqual(["b", "a"]);
    expect(planMove(cards, "zzz", "t", 0)).toEqual([]);
  });
});

describe("moveCard mutation", () => {
  test("a within-tier reorder persists even when positions were tied", async () => {
    const t = convexTest(schema, modules);
    const { owner, ids } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { name: "Owner", email: "owner@team4099.com" });
      const boardId = await ctx.db.insert("kanbanBoards", {
        name: "My picks", type: "personal", ownerId: owner,
        eventKey: EVENT, columns: [{ id: "t", title: "Tier 1" }],
      });
      const ids = [];
      for (const teamNumber of [4099, 254, 1678]) {
        ids.push(await ctx.db.insert("kanbanCards", {
          boardId, columnId: "t", teamNumber, eventKey: EVENT, position: 0,
        }));
      }
      return { owner, ids };
    });
    const as = t.withIdentity({ subject: owner, issuer: "test" });
    await as.mutation(api.kanban.moveCard, { cardId: ids[2], columnId: "t", position: 0 });

    const stored = await t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
    const teams = stored.sort((a, b) => byPosition(a!, b!)).map((c) => c!.teamNumber);
    expect(teams).toEqual([1678, 4099, 254]);
    expect(stored.map((c) => c!.position).sort()).toEqual([0, 1, 2]);
  });
});
