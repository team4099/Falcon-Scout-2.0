import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

const fieldTypeValidator = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("checkbox"),
  v.literal("select"),
  v.literal("counter"),
  v.literal("textarea"),
  v.literal("teamNumber"),
  v.literal("rating")
);

export default defineSchema({
  ...authTables,
  
  formTemplates: defineTable({
    name: v.string(),
    description: v.optional(v.string()),
    // "default" = match scouting (all field types, auto team# pinned at top)
    // "super"   = super scout (text + rating only)
    // "pit"     = pit scouting (all field types, team# pinned, no match number)
    // optional for backwards compat with existing records
    formType: v.optional(v.union(v.literal("default"), v.literal("super"), v.literal("pit"), v.literal("checklist"))),
    fields: v.array(v.object({
      id: v.string(),
      type: fieldTypeValidator,
      label: v.string(),
      required: v.boolean(),
      options: v.optional(v.array(v.string())),
      section: v.optional(v.string()),
    })),
    isActive: v.boolean(),
  }),

  formSubmissions: defineTable({
    templateId: v.id("formTemplates"),
    eventKey: v.string(),
    matchNumber: v.number(),
    teamNumber: v.number(),
    scoutId: v.optional(v.id("users")),
    data: v.string(), // JSON stringified response map
    syncedAt: v.number(),
    offlineId: v.optional(v.string()), // idempotency key from offline queue
  })
    .index("by_event_team", ["eventKey", "teamNumber"])
    .index("by_offline_id", ["offlineId"]),

  // Checklist submissions — one per checklist template per match
  checklistSubmissions: defineTable({
    templateId: v.id("formTemplates"),
    eventKey: v.string(),
    matchNumber: v.number(),          // the match this checklist is for
    assignedScoutId: v.id("users"),   // pit scout assigned to fill it out
    completedById: v.optional(v.id("users")),
    data: v.string(),                 // JSON stringified response map
    completedAt: v.optional(v.number()),
    offlineId: v.optional(v.string()), // idempotency key
  })
    .index("by_event_match", ["eventKey", "matchNumber"])
    .index("by_assigned_event", ["assignedScoutId", "eventKey"])
    .index("by_offline_id", ["offlineId"]),

  // Kanban boards
  kanbanBoards: defineTable({
    name: v.string(),
    type: v.union(v.literal("personal"), v.literal("central")),
    ownerId: v.optional(v.id("users")), // only set for personal boards
    eventKey: v.string(),
    columns: v.array(v.object({
      id: v.string(),
      title: v.string(),
      color: v.optional(v.string()),
    })),
  })
    .index("by_type_event", ["type", "eventKey"])
    .index("by_owner", ["ownerId"]),

  kanbanCards: defineTable({
    boardId: v.id("kanbanBoards"),
    columnId: v.string(),
    teamNumber: v.number(),
    eventKey: v.string(),
    notes: v.optional(v.string()),
    position: v.number(),
  })
    .index("by_board", ["boardId"])
    .index("by_board_column", ["boardId", "columnId"])
    .index("by_event_team", ["eventKey", "teamNumber"]),

  // Global event selection
  eventSettings: defineTable({
    key: v.string(), // "current_event"
    eventKey: v.string(),
    eventName: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Per-match scouting slots — 6 positions per match (red1-3, blue1-3)
  matchAssignments: defineTable({
    eventKey: v.string(),
    matchNumber: v.number(),
    matchLabel: v.string(), // e.g. "Q42", "SF1M2"
    position: v.union(
      v.literal("red1"), v.literal("red2"), v.literal("red3"),
      v.literal("blue1"), v.literal("blue2"), v.literal("blue3")
    ),
    scoutId: v.id("users"),
  })
    .index("by_event", ["eventKey"])
    .index("by_event_match", ["eventKey", "matchNumber"])
    .index("by_scout_event", ["scoutId", "eventKey"]),

  // Pit rotation ranges — scouts assigned to pit duty for a span of matches
  pitRotations: defineTable({
    eventKey: v.string(),
    label: v.optional(v.string()),   // e.g. "Morning shift"
    // Qual rotation: both required. Elims rotation: both omitted.
    startMatch: v.optional(v.number()),
    endMatch: v.optional(v.number()),
    // When true, this row represents the single elims pit rotation and
    // startMatch/endMatch are ignored (it covers all playoff matches).
    isElims: v.optional(v.boolean()),
    scoutIds: v.array(v.id("users")),
  })
    .index("by_event", ["eventKey"]),

  // Per-user settings (API keys, preferences) — synced across devices
  userSettings: defineTable({
    userId:    v.id("users"),
    tbaApiKey: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  // Scout self-reported scheduling preferences (shown when no schedule assigned)
  scoutPreferences: defineTable({
    scoutId:             v.id("users"),
    eventKey:            v.string(),
    preferredPartners:   v.array(v.id("users")),
    wantsMoreMatches:    v.boolean(),
    wantsPitRotation:    v.boolean(),
    wantsPitScouting:    v.optional(v.boolean()), // pre-competition pit scouting
    updatedAt:           v.number(),
  })
    .index("by_scout_event", ["scoutId", "eventKey"])
    .index("by_event",       ["eventKey"]),
  // Pre-competition pit scouting teams — groups of scouts assigned to
  // scout specific teams' pits before quals start.
  pitScoutingTeams: defineTable({
    eventKey:   v.string(),
    teamNumber: v.number(),            // FRC team number from TBA
    scoutIds:   v.array(v.id("users")),
  })
    .index("by_event", ["eventKey"])
    .index("by_event_team", ["eventKey", "teamNumber"]),
});

