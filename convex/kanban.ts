import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// ──────────────────────────────────────────────
// Kanban Boards
// ──────────────────────────────────────────────

export const getCentralBoard = query({
  args: { eventKey: v.string() },
  handler: async (ctx, { eventKey }) => {
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
    const userId = await getAuthUserId(ctx);
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
  },
  handler: async (ctx, { boardId, columns }) => {
    await ctx.db.patch(boardId, { columns });
  },
});

// ──────────────────────────────────────────────
// Kanban Cards
// ──────────────────────────────────────────────

export const getBoardCards = query({
  args: { boardId: v.id("kanbanBoards") },
  handler: async (ctx, { boardId }) => {
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
    return await ctx.db.insert("kanbanCards", args);
  },
});

export const moveCard = mutation({
  args: {
    cardId: v.id("kanbanCards"),
    columnId: v.string(),
    position: v.number(),
  },
  handler: async (ctx, { cardId, columnId, position }) => {
    await ctx.db.patch(cardId, { columnId, position });
  },
});

export const updateCard = mutation({
  args: {
    cardId: v.id("kanbanCards"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { cardId, notes }) => {
    await ctx.db.patch(cardId, { notes });
  },
});

export const removeCard = mutation({
  args: { cardId: v.id("kanbanCards") },
  handler: async (ctx, { cardId }) => {
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
  },
  handler: async (ctx, { boardId, eventKey, columnId, teamNumbers }) => {
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
