import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getApprovedUserId, isSignedIn, requireAdmin, requireUser } from "./adminAuth";
import { planMove } from "./kanbanOrder";

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
    const userId = await getApprovedUserId(ctx);
    if (!userId) return null;
    const boards = await ctx.db
      .query("kanbanBoards")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    return boards.find((b) => b.eventKey === eventKey) ?? null;
  },
});

/**
 * The one write gate for picklist boards. The shared (central) board is a team
 * artefact that only admins may change — scouts can view it but not move,
 * annotate or remove cards, nor edit its columns. A personal board is writable
 * by its owner only.
 */
async function requireBoardWrite(ctx: MutationCtx, board: Doc<"kanbanBoards">) {
  if (board.type === "central") return await requireAdmin(ctx);
  const userId = await requireUser(ctx);
  if (board.ownerId !== userId) throw new Error("That is someone else's board.");
  return userId;
}

async function getBoardForWrite(ctx: MutationCtx, boardId: Id<"kanbanBoards">) {
  const board = await ctx.db.get(boardId);
  if (!board) throw new Error("Board not found");
  await requireBoardWrite(ctx, board);
  return board;
}

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
    if (args.type === "central") {
      await requireAdmin(ctx);
      // Two admins opening the page at once would otherwise both create one.
      const existing = await ctx.db
        .query("kanbanBoards")
        .withIndex("by_type_event", (q) => q.eq("type", "central").eq("eventKey", args.eventKey))
        .first();
      if (existing) return existing._id;
      return await ctx.db.insert("kanbanBoards", { ...args, ownerId: undefined });
    }
    const userId = await requireUser(ctx);
    return await ctx.db.insert("kanbanBoards", { ...args, ownerId: userId });
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
  handler: async (ctx, { boardId, columns }) => {
    await getBoardForWrite(ctx, boardId);
    await ctx.db.patch(boardId, { columns });
    // Deleting a column used to orphan its cards (invisible, and re-sync skips
    // them as already present). Send them back to Unsorted instead.
    if (!columns.some((c) => c.id === "unsorted")) return;
    const kept = new Set(columns.map((c) => c.id));
    const cards = await ctx.db
      .query("kanbanCards")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .collect();
    let position = cards.filter((c) => c.columnId === "unsorted").length;
    for (const card of cards) {
      if (!kept.has(card.columnId)) {
        await ctx.db.patch(card._id, { columnId: "unsorted", position: position++ });
      }
    }
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
    await getBoardForWrite(ctx, args.boardId);
    return await ctx.db.insert("kanbanCards", args);
  },
});

/** Confirm the caller may write to the board a card sits on, and return the card. */
async function requireCardAccess(ctx: MutationCtx, cardId: Id<"kanbanCards">) {
  const card = await ctx.db.get(cardId);
  if (!card) throw new Error("Card not found");
  await getBoardForWrite(ctx, card.boardId);
  return card;
}

export const moveCard = mutation({
  args: {
    cardId: v.id("kanbanCards"),
    columnId: v.string(),
    position: v.number(),
  },
  handler: async (ctx, { cardId, columnId, position }) => {
    const card = await requireCardAccess(ctx, cardId);
    const cards = await ctx.db
      .query("kanbanCards")
      .withIndex("by_board", (q) => q.eq("boardId", card.boardId))
      .collect();
    for (const m of planMove(cards, cardId, columnId, position)) {
      await ctx.db.patch(m.card._id, { columnId: m.columnId, position: m.position });
    }
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
  handler: async (ctx, { boardId, eventKey, columnId, teamNumbers }) => {
    await getBoardForWrite(ctx, boardId);
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
