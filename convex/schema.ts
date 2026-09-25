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
  v.literal("rating"),
  v.literal("photo")
);

export default defineSchema({
  ...authTables,

  // Non-@team4099.com accounts may sign in with Google, but hold no data access
  // until an admin flips their row to "approved" (see convex/guests.ts and
  // adminAuth.ts's isCallerApproved). Keyed by lowercased email so approval
  // survives the user row being recreated.
  guestAccess: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    message: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
    requestedAt: v.number(),
    decidedAt: v.optional(v.number()),
    decidedBy: v.optional(v.id("users")),
  })
    .index("by_email", ["email"])
    .index("by_status", ["status"]),

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
    // Coins paid to the scout for each accepted submission of this form.
    // Optional: templates created before this field pay DEFAULT_SCOUT_REWARD.
    coinReward: v.optional(v.number()),
  }),

  formSubmissions: defineTable({
    templateId: v.id("formTemplates"),
    eventKey: v.string(),
    matchNumber: v.number(),
    // Qualification vs elimination. Optional because rows written before this
    // field existed have no value — backfillCompLevel recovers what it can from
    // data._matchPrefix. Treat undefined as "unknown", not as "qm".
    compLevel: v.optional(v.union(v.literal("qm"), v.literal("elim"))),
    teamNumber: v.number(),
    scoutId: v.optional(v.id("users")),
    data: v.string(), // JSON stringified response map
    syncedAt: v.number(),
    offlineId: v.optional(v.string()), // idempotency key from offline queue
  })
    .index("by_event_team", ["eventKey", "teamNumber"])
    .index("by_offline_id", ["offlineId"])
    // Used to tell a scout's first submission for a match apart from a repeat,
    // so only the first one pays out. See awardOncePerMatch in forms.ts.
    .index("by_scout_event_match", ["scoutId", "eventKey", "matchNumber"]),

  // DEPRECATED — checklists are now ordinary form submissions (formType
  // "checklist" templates submitted through forms.submitForm), so nothing
  // writes here any more. The table is kept, not dropped, because rows written
  // before the merge still exist and `convex deploy` rejects a schema that
  // omits a populated table. Safe to delete once the historical rows are no
  // longer wanted.
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

  // Cached event team rosters — populated by the frontend when TBA data is
  // fetched, used by the backend to validate team numbers on form submission.
  eventTeamRosters: defineTable({
    eventKey: v.string(),
    teamNumbers: v.array(v.number()),
    updatedAt: v.number(),
  }).index("by_event", ["eventKey"]),

  // Admin-entered qual match count, used to build the scheduling grid before
  // TBA publishes the real schedule (which often lands only hours before the
  // event starts). Assignments key on match number, so once TBA does publish,
  // the real matches simply take over the grid and everything already
  // assigned resolves against them — nothing is migrated.
  eventMatchPlans: defineTable({
    eventKey:       v.string(),
    qualMatchCount: v.number(),
    updatedAt:      v.number(),
  }).index("by_event", ["eventKey"]),

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
    // Per-rotation drive team — always a subset of scoutIds. Distinct from the
    // team-wide driveTeamMembers table (which drives auto-generation): the
    // people actually driving can differ from one rotation to the next, so the
    // roster is recorded on the rotation itself. Optional for rows written
    // before the field existed — treat undefined as "none flagged".
    driveTeamScoutIds: v.optional(v.array(v.id("users"))),
  })
    .index("by_event", ["eventKey"]),

  // A scout reporting for a pit-duty shift. Pit duty produces no form
  // submission, so there is nothing else to tell a finished shift from an
  // upcoming one — this row is the whole record. One row per scout per
  // rotation; reporting twice is a no-op.
  pitDutyCheckIns: defineTable({
    scoutId:    v.id("users"),
    eventKey:   v.string(),
    rotationId: v.id("pitRotations"),
    reportedAt: v.number(),
  })
    .index("by_scout_event", ["scoutId", "eventKey"])
    .index("by_scout_rotation", ["scoutId", "rotationId"])
    .index("by_event_rotation", ["eventKey", "rotationId"]),

  // Per-user settings — synced across devices
  userSettings: defineTable({
    userId:    v.id("users"),
    // DEPRECATED: the TBA key is now the server env var TBA_API_KEY. Field kept
    // optional so old rows still validate; never returned to clients and erased
    // by users:scrubStoredTbaKeys.
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
  // Admin-set schedule exclusions — scouts permanently excluded from
  // auto-generated schedules for a given event.
  scheduleExclusions: defineTable({
    eventKey: v.string(),
    excludedScoutIds: v.array(v.id("users")),
    updatedAt: v.number(),
  }).index("by_event", ["eventKey"]),

  // Pre-competition pit scouting teams — groups of scouts assigned to
  // scout specific teams' pits before quals start.
  pitScoutingTeams: defineTable({
    eventKey:   v.string(),
    teamNumber: v.number(),            // FRC team number from TBA
    scoutIds:   v.array(v.id("users")),
  })
    .index("by_event", ["eventKey"])
    .index("by_event_team", ["eventKey", "teamNumber"]),

  // ── FalconBet ──────────────────────────────────────────────────────────────

  // Betting markets — one per "question" users can bet on
  bettingMarkets: defineTable({
    eventKey:    v.string(),
    title:       v.string(),
    description: v.optional(v.string()),
    // Market category. FalconBet was simplified (2026-09-24) to a single type:
    // match_winner. The other ten literals are LEGACY ONLY — nothing creates
    // them, listMarkets filters them out of the UI, and they stay in this union
    // because `convex deploy` rejects a schema that existing rows violate.
    // Delete them only after clearing those rows via the Convex dashboard.
    type: v.union(
      v.literal("match_winner"),       // red or blue alliance wins
      v.literal("alliance_score_ou"),  // alliance score over/under threshold
      v.literal("point_differential"), // |red - blue| over/under
      v.literal("team_field_bool"),    // checkbox field → yes/no for team+match
      v.literal("team_field_numeric"), // number/counter field → over/under for team+match
      v.literal("team_field_select"),  // select field → equals a specific value
      v.literal("multi_match_numeric"), // combined numeric stat O/U across N matches
      v.literal("multi_match_count"),   // count of boolean condition met across N matches (O/U)
      v.literal("team_top_rank"),       // will team finish quals ranked in the top N?
      v.literal("alliance_selection"),  // will team get picked for an alliance in eliminations?
      v.literal("elimination_advance"), // will team's alliance reach a given playoff stage?
    ),
    // Match context
    matchNumber:  v.optional(v.number()),
    matchNumbers: v.optional(v.array(v.number())), // multi-match markets
    teamNumber:   v.optional(v.number()),
    alliance:     v.optional(v.union(v.literal("red"), v.literal("blue"))),
    // Scouting-field context (for team_field_* and multi_match_*)
    templateId: v.optional(v.id("formTemplates")),
    fieldId:    v.optional(v.string()),
    fieldLabel: v.optional(v.string()),
    // Threshold for over/under markets
    threshold:   v.optional(v.number()),
    // Target value for select markets
    targetValue: v.optional(v.string()),
    // Minimum occurrences for multi_match_count (e.g. "at least 3 of 5 matches")
    minCount: v.optional(v.number()),
    // Who the bet targets
    targetScope: v.optional(v.union(
      v.literal("team"),      // specific team number
      v.literal("alliance"),  // red or blue alliance in each match
      v.literal("match"),     // anyone in the match (no team/alliance filter)
    )),
    // Outcome options. For match_winner (the only type created now) there are
    // exactly two: "red" and "blue".
    options: v.array(v.object({
      id:       v.string(),   // "red" | "blue" (legacy rows: over/under/yes/no/select value)
      label:    v.string(),
      // Statbotics-derived win probability, 1-99, summing to 100 across options.
      // This is what fixes the payout multiplier (100 / winProb) at bet time.
      // Optional only because legacy rows predate it — they carry the same
      // number in seedPool, which is why placeBet falls back to it.
      winProb:  v.optional(v.number()),
      // DEPRECATED. Was the house seed pool for the old parimutuel payout.
      // For match_winner it always held the win-probability percentage, so it
      // doubles as the winProb fallback. Do not read it for anything else.
      seedPool: v.number(),
    })),
    // Lifecycle
    status: v.union(
      v.literal("open"),      // accepting bets
      v.literal("locked"),    // no new bets (match imminent)
      v.literal("resolved"),  // outcome known, payouts issued
      v.literal("cancelled"), // voided — all bets refunded
    ),
    resolvedOptionId: v.optional(v.string()),
    createdAt:        v.number(),
    resolvedAt:       v.optional(v.number()),
    createdBy:        v.optional(v.id("users")),
  })
    .index("by_event",       ["eventKey"])
    .index("by_event_match", ["eventKey", "matchNumber"])
    .index("by_status",      ["status"]),

  // Individual bets placed by users. One per user per market, enforced in
  // placeBet via the by_market_user index — a bet cannot be raised or retracted.
  bets: defineTable({
    marketId: v.id("bettingMarkets"),
    userId:   v.id("users"),
    optionId: v.string(),
    amount:   v.number(),
    eventKey: v.string(),
    placedAt: v.number(),
    // Payout multiplier locked in at placement from the market's Statbotics
    // win probability, so later bets never move what this bet pays. Optional
    // because rows predate fixed odds; resolveMarket documents the fallback.
    multiplier: v.optional(v.number()),
    payout:   v.optional(v.number()),  // set on resolution
    settled:  v.optional(v.boolean()),
  })
    .index("by_market",      ["marketId"])
    .index("by_market_user", ["marketId", "userId"])
    .index("by_user_event",  ["userId", "eventKey"])
    .index("by_user",        ["userId"]),

  // Per-user per-event coin balance
  userBalances: defineTable({
    userId:         v.id("users"),
    eventKey:       v.string(),
    balance:        v.number(),
    totalWon:       v.number(),
    totalLost:      v.number(),
    totalBet:       v.number(),
    totalBegs:      v.number(), // leaderboard of shame
    // Coins earned by scouting (as opposed to won gambling). Optional because
    // rows predate the payout; treat undefined as 0.
    totalEarned:    v.optional(v.number()),
    lastBegAt:      v.optional(v.number()), // server-enforced beg cooldown
    totalPenalties: v.optional(v.number()), // coins lost for skipping markets
  })
    .index("by_user_event", ["userId", "eventKey"]),

  // DEPRECATED — the casino minigames (Slot, Plinko, Chicken Cross, Mines)
  // and the odds-manipulation "retention" system built on top of them were
  // removed (2026-09-14): nothing writes to either table any more. Kept, not
  // dropped, because rows written before removal still exist and `convex
  // deploy` rejects a schema that omits a populated table. Do not delete
  // these definitions again without first clearing the historical rows via
  // the Convex dashboard — that's what broke deploy three pushes in a row.
  casinoGames: defineTable({
    userId:    v.id("users"),
    eventKey:  v.string(),
    game:      v.union(v.literal("crossy"), v.literal("mines")),
    betAmount: v.number(),
    multiplier: v.number(),
    mineCount:     v.optional(v.number()),
    minePositions: v.optional(v.array(v.number())),
    revealed:      v.optional(v.array(v.number())),
    difficulty: v.optional(v.string()),
    rowsCleared: v.optional(v.number()),
    startedAt: v.number(),
  })
    .index("by_user_event_game", ["userId", "eventKey", "game"]),

  retentionProfiles: defineTable({
    userId:              v.id("users"),
    eventKey:            v.string(),
    abandonHistory:      v.array(v.number()),
    threshold:           v.number(),
    sessionStartBalance: v.number(),
    sessionStartTime:    v.number(),
    updatedAt:           v.number(),
  })
    .index("by_user_event", ["userId", "eventKey"]),

  // Per-user, per-event money ledger. One row per balance-affecting event —
  // scouting rewards, pit duty, begging, and every bet placed/won/refunded —
  // so a scout can see exactly where every coin came from, not just lifetime
  // totals on `userBalances`. Forward-only: added when this table was
  // introduced, not backfilled from prior activity.
  coinTransactions: defineTable({
    userId:   v.id("users"),
    eventKey: v.string(),
    type: v.union(
      v.literal("scouting_reward"),
      v.literal("pit_duty_reward"),
      v.literal("pit_duty_revoked"),
      v.literal("admin_award"),
      v.literal("beg"),
      v.literal("bet_placed"),
      v.literal("bet_won"),
      v.literal("bet_refunded"),
    ),
    amount:       v.number(), // signed: positive = gained, negative = spent
    balanceAfter: v.number(),
    note:         v.optional(v.string()),   // e.g. market title, form template name
    relatedId:    v.optional(v.string()),   // marketId / submissionId / rotationId
    createdAt:    v.number(),
  })
    .index("by_user_event", ["userId", "eventKey"]),

  // ── Temporary admin grants ────────────────────────────────────────────────
  // Lets an inherent admin (see ADMIN_EMAILS in convex/adminAuth.ts) hand a
  // scout time-boxed admin privileges. One row per user; re-granting patches
  // expiresAt rather than inserting a duplicate.
  temporaryAdminGrants: defineTable({
    userId:     v.id("users"),
    grantedBy:  v.id("users"),
    expiresAt:  v.number(),
  })
    .index("by_user", ["userId"]),

  // ── Drive team tag ────────────────────────────────────────────────────────
  // Admin-assigned, team-wide (not per-event): a drive team member is
  // excluded from match-scouting auto-generation entirely and placed on
  // every auto-generated qual pit-rotation window instead. One row per
  // tagged user.
  driveTeamMembers: defineTable({
    userId: v.id("users"),
  })
    .index("by_user", ["userId"]),

  // ── Admin status label ───────────────────────────────────────────────────
  // Free-text label admins can set to override the default admin-status
  // wording shown in Manage Scouts (e.g. "Permanent team lead — always has
  // admin access"). Seeded to "Temporary Admin" the first time a fresh
  // temporary grant is created; editable after that.
  adminLabels: defineTable({
    userId: v.id("users"),
    label:  v.string(),
  })
    .index("by_user", ["userId"]),

  // ── Deactivated users (soft delete) ──────────────────────────────────────
  // Admin-set: hides a user from Manage Scouts and every scout-picking
  // process (schedule generation, pit assignment, etc. all source scouts
  // from users.listUsers, which filters these out) without deleting their
  // account or historical data. Cleared automatically the next time the user
  // signs back in (see users.reactivateSelf, called from App.tsx on auth).
  deactivatedUsers: defineTable({
    userId:        v.id("users"),
    deactivatedAt: v.number(),
    deactivatedBy: v.id("users"),
  })
    .index("by_user", ["userId"]),
});
