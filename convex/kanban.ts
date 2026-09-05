import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isSignedIn, requireAdmin, requireUser } from "./adminAuth";

// ──────────────────────────────────────────────
// Kanban Boards
// ──────────────────────────────────────────────

export const getCentralBoard = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    if (!(await isSignedIn(ctx))) return null;
    return await ctx.db
      .query("kanbanBoards")
      .withIndex("by_type_event", (q) =>
        q.eq("type", "central").eq("eventKey", eventKey)
      )
      .first();
  },
});

export const getPersonalBoard = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const boards = await ctx.db
      .query("kanbanBoards")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    return boards.find((b) => b.eventKey === eventKey) ?? null;
  },
});

export const createBoard = mutation({
  args: {
    name: v.string(),
    type: v.union(v.literal("personal"), v.literal("central")),
    eventKey: v.string(),
    columns: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        color: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return await ctx.db.insert("kanbanBoards", {
      ...args,
      ownerId: args.type === "personal" && userId ? userId : undefined,
    });
  },
});

export const updateBoardColumns = mutation({
  args: {
    boardId: v.id("kanbanBoards"),
    columns: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        color: v.optional(v.string()),
      })
    ),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { boardId, columns, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    await ctx.db.patch(boardId, { columns });
  },
});

// ──────────────────────────────────────────────
// Kanban Cards
// ──────────────────────────────────────────────

export const getBoardCards = query({
  args: { boardId: v.id("kanbanBoards") },
  handler: async (ctx, { boardId }) => {
    if (!(await isSignedIn(ctx))) return [];
    return await ctx.db
      .query("kanbanCards")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .collect();
  },
});

export const addCard = mutation({
  args: {
    boardId: v.id("kanbanBoards"),
    columnId: v.string(),
    teamNumber: v.number(),
    eventKey: v.string(),
    notes: v.optional(v.string()),
    position: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");
    if (board.type === "personal" && board.ownerId !== userId) {
      throw new Error("That is someone else's board.");
    }
    return await ctx.db.insert("kanbanCards", args);
  },
});

/**
 * Confirm the caller may write to the board a card sits on, and return the card.
 *
 * Personal boards carry an ownerId and getPersonalBoard filters on it, but the
 * card mutations took a bare cardId and only checked that the caller was signed
 * in — so any scout could move, edit or delete cards on someone else's personal
 * board. Central boards stay shared: the picklist is a team artefact.
 */
async function requireCardAccess(ctx: MutationCtx, cardId: Id<"kanbanCards">) {
  const userId = await requireUser(ctx);
  const card = await ctx.db.get(cardId);
  if (!card) throw new Error("Card not found");
  const board = await ctx.db.get(card.boardId);
  if (!board) throw new Error("Board not found");
  if (board.type === "personal" && board.ownerId !== userId) {
    throw new Error("That card is on someone else's board.");
  }
  return card;
}

export const moveCard = mutation({
  args: {
    cardId: v.id("kanbanCards"),
    columnId: v.string(),
    position: v.number(),
  },
  handler: async (ctx, { cardId, columnId, position }) => {
    await requireCardAccess(ctx, cardId);
    await ctx.db.patch(cardId, { columnId, position });
  },
});

export const updateCard = mutation({
  args: {
    cardId: v.id("kanbanCards"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { cardId, notes }) => {
    await requireCardAccess(ctx, cardId);
    await ctx.db.patch(cardId, { notes });
  },
});

export const removeCard = mutation({
  args: { cardId: v.id("kanbanCards") },
  handler: async (ctx, { cardId }) => {
    await requireCardAccess(ctx, cardId);
    await ctx.db.delete(cardId);
  },
});

// ──────────────────────────────────────────────
// Seed all event teams into unsorted column
// ──────────────────────────────────────────────

export const seedTeams = mutation({
  args: {
    boardId: v.id("kanbanBoards"),
    eventKey: v.string(),
    columnId: v.string(),       // id of the "unsorted" / first column
    teamNumbers: v.array(v.number()),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, { boardId, eventKey, columnId, teamNumbers, adminKey }) => {
    await requireAdmin(ctx, adminKey);
    // Fetch all existing cards on this board to avoid duplicates
    const existing = await ctx.db
      .query("kanbanCards")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .collect();
    const existingNums = new Set(existing.map((c) => c.teamNumber));

    const toAdd = teamNumbers.filter((n) => !existingNums.has(n));
    let position = existing.filter((c) => c.columnId === columnId).length;

    for (const teamNumber of toAdd) {
      await ctx.db.insert("kanbanCards", {
        boardId,
        columnId,
        teamNumber,
        eventKey,
        position: position++,
      });
    }
    return toAdd.length;
  },
});
