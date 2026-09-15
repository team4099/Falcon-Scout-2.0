/**
 * scheduleGenerator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Auto-generate match assignments, pit rotations, and pre-competition pit
 * scouting pairs for a FRC scouting event.
 *
 * Rules enforced:
 *  - Qual matches only (no elims) — elims pit rotation is always manual
 *    (see the separate ElimsRotationPanel UI; this generator never touches it)
 *  - Matches organised in blocks of 5; same 6 scouts cover all 5 matches in a block
 *  - Each scout scouts at least 2 blocks (10 matches) minimum, except drive
 *    team scouts, who never scout matches at all (see below)
 *  - Scouts who opt into pit duty get one block of 10 consecutive qual matches
 *    on pit duty (2 consecutive 5-match blocks); aside from drive team (who
 *    ride every window), each window has at most PIT_ROTATION_OTHERS_PER_WINDOW
 *    (5) other scouts, and no non-drive-team scout rides more than ~70% of
 *    the event's pit rotation windows
 *  - Drive team scouts are excluded from match scouting entirely and are
 *    placed on every qual pit-rotation window for the whole event (a window
 *    every 10 matches, covering the full schedule) — they have nowhere else
 *    to be assigned, so pit duty must fully cover the event when any exist
 *  - Pit rotation is planned BEFORE match scouting and always wins: a scout
 *    on pit duty for a match cannot also scout that match. If that leaves too
 *    few scouts to fill a block, the leftover positions are reported as
 *    blank spaces rather than silently double-booking someone
 *  - wantsMoreMatches scouts are targeted for ~50% more blocks than everyone
 *    else (proportional target, not a flat bonus). Scouts with zero
 *    preferences selected at all get the same 1.5x target weight — with no
 *    preference expressed, they default to acting like they opted into more
 *    matches, unless generatePitScoutingTeams recruits them as fallback
 *    pit-scouting pairs first (that recruiting order is unaffected and still
 *    prefers zero-preference scouts; being recruited there doesn't reduce
 *    their match-block weight, since pit scouting happens pre-quals)
 *  - Preferred partner pairs/triplets are placed on the same alliance side
 *    within a scouting block (bitmask-optimised alliance splitting); a scout
 *    who lists 2-3 preferred partners is scored for co-placement with as many
 *    of them as possible, not just the first one satisfied
 *  - Existing pit rotations are honoured as-is
 *  - Existing match assignments are preserved; only empty slots are filled
 *  - generatePitScoutingTeams() (separate entry point) pairs up scouts for
 *    pre-competition pit scouting: wantsPitScouting opt-ins are paired first
 *    (preference-aware), each pair covers 6-8 TBA teams, and if more pairs
 *    are needed to keep every pair at <=8 teams, they're recruited from
 *    scouts with zero preferences selected first, then scouts with the
 *    fewest preferences selected — never from scouts who opted into pit
 *    rotation specifically, and existing manual team assignments are kept
 */

export type Position = "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";

export const POSITIONS: Position[] = [
  "red1", "red2", "red3", "blue1", "blue2", "blue3",
];
const RED_POS: Position[] = ["red1", "red2", "red3"];
const BLUE_POS: Position[] = ["blue1", "blue2", "blue3"];

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScoutInfo {
  _id: string;
  name?: string;
  email?: string;
}

export interface ScoutPref {
  scoutId: string;
  preferredPartners: string[];
  wantsMoreMatches: boolean;
  wantsPitRotation: boolean;
  /** Pre-competition pit scouting (distinct from wantsPitRotation, which is
   *  in-event pit duty during quals). Optional to match the schema field. */
  wantsPitScouting?: boolean;
}

/** True if a scout selected none of the four scheduling preferences at all. */
function hasNoPreferences(p: ScoutPref | undefined): boolean {
  if (!p) return true;
  return p.preferredPartners.length === 0 && !p.wantsMoreMatches && !p.wantsPitRotation && !p.wantsPitScouting;
}

/** How many distinct preferences a scout selected (0-4), for "fewest first"
 *  recruiting order when extra pit scouting pairs are needed. */
function preferenceCount(p: ScoutPref | undefined): number {
  if (!p) return 0;
  return (p.preferredPartners.length > 0 ? 1 : 0) + (p.wantsMoreMatches ? 1 : 0) +
    (p.wantsPitRotation ? 1 : 0) + (p.wantsPitScouting ? 1 : 0);
}

export interface QualMatch {
  matchNumber: number;
  matchLabel: string;
}

export interface ExistingPitRotation {
  _id?: string;
  startMatch?: number;
  endMatch?: number;
  isElims?: boolean;
  scoutIds: string[];
}

export interface ExistingMatchAssignment {
  matchNumber: number;
  position: Position;
  scoutId: string;
}

export interface SchedulerInput {
  qualMatches: QualMatch[];
  scouts: ScoutInfo[];
  preferences: ScoutPref[];
  existingPitRotations: ExistingPitRotation[];
  existingMatchAssignments: ExistingMatchAssignment[];
  /** Scout IDs to skip entirely — they receive no auto-generated assignments. */
  excludedScoutIds?: string[];
  /**
   * Drive team scout IDs. Excluded from match scouting entirely; placed on
   * every auto-generated qual pit-rotation window instead (a window every
   * 10 matches, covering the whole event), since they have no other duty.
   */
  driveTeamScoutIds?: string[];
}

export interface GeneratedPitRotation {
  label: string;
  startMatch: number;
  endMatch: number;
  scoutIds: string[];
}

export interface GeneratedMatchAssignment {
  matchNumber: number;
  matchLabel: string;
  position: Position;
  scoutId: string;
}

export interface SchedulerOutput {
  newPitRotations: GeneratedPitRotation[];
  matchAssignments: GeneratedMatchAssignment[];
  warnings: string[];
  stats: {
    totalBlocks: number;
    assignedSlots: number;
    newPitRotationCount: number;
    scoutBlockCounts: Record<string, number>;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

function displayName(s: ScoutInfo): string {
  return s.name ?? s.email ?? s._id.slice(0, 8);
}

function popcount(x: number): number {
  let n = 0;
  while (x) { n += x & 1; x >>= 1; }
  return n;
}

// ── Core: position assignment with preference-aware alliance grouping ──────────

function assignPositions(
  allSixIds: string[],
  openPositions: Position[],
  fixed: Map<Position, string>,
  prefScore: (a: string, b: string) => number,
): Map<Position, string> {
  const result = new Map<Position, string>(fixed);

  const fixedIds = new Set(fixed.values());
  const freeScouts = allSixIds.filter(id => !fixedIds.has(id));

  const redNeed = RED_POS.filter(p => !fixed.has(p) && openPositions.includes(p));
  const blueNeed = BLUE_POS.filter(p => !fixed.has(p) && openPositions.includes(p));

  if (freeScouts.length === 0) return result;

  const redFixed = RED_POS.map(p => fixed.get(p)).filter(Boolean) as string[];
  const blueFixed = BLUE_POS.map(p => fixed.get(p)).filter(Boolean) as string[];

  const n = freeScouts.length;
  const redSlots = redNeed.length;
  const blueSlots = blueNeed.length;

  if (redSlots + blueSlots !== n) {
    // Fallback: sequential assignment
    freeScouts.forEach((id, i) => { if (openPositions[i]) result.set(openPositions[i], id); });
    return result;
  }

  // Enumerate all partitions of freeScouts into redSlots + blueSlots,
  // picking the partition that maximises intra-alliance preference score.
  let bestMask = (1 << redSlots) - 1; // default: first redSlots scouts go red
  let bestScore = -1;
  for (let mask = 0; mask < (1 << n); mask++) {
    if (popcount(mask) !== redSlots) continue;
    const redGrp = freeScouts.filter((_, i) => (mask >> i) & 1);
    const blueGrp = freeScouts.filter((_, i) => !((mask >> i) & 1));
    const redAll = [...redFixed, ...redGrp];
    const blueAll = [...blueFixed, ...blueGrp];
    let score = 0;
    for (let i = 0; i < redAll.length; i++)
      for (let j = i + 1; j < redAll.length; j++)
        score += prefScore(redAll[i], redAll[j]);
    for (let i = 0; i < blueAll.length; i++)
      for (let j = i + 1; j < blueAll.length; j++)
        score += prefScore(blueAll[i], blueAll[j]);
    if (score > bestScore) { bestScore = score; bestMask = mask; }
  }

  const redGrp = freeScouts.filter((_, i) => (bestMask >> i) & 1);
  const blueGrp = freeScouts.filter((_, i) => !((bestMask >> i) & 1));
  redNeed.forEach((pos, i) => { if (redGrp[i]) result.set(pos, redGrp[i]); });
  blueNeed.forEach((pos, i) => { if (blueGrp[i]) result.set(pos, blueGrp[i]); });

  return result;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function generateSchedule(input: SchedulerInput): SchedulerOutput {
  const { qualMatches, preferences, existingPitRotations, existingMatchAssignments } = input;
  const excludedSet = new Set(input.excludedScoutIds ?? []);
  // Remove excluded scouts from the pool entirely before any scheduling logic
  const scouts = excludedSet.size > 0
    ? input.scouts.filter(s => !excludedSet.has(s._id))
    : input.scouts;
  const warnings: string[] = [];

  if (scouts.length === 0 || qualMatches.length === 0) {
    return {
      newPitRotations: [], matchAssignments: [], warnings: ["No scouts or matches."],
      stats: { totalBlocks: 0, assignedSlots: 0, newPitRotationCount: 0, scoutBlockCounts: {} },
    };
  }

  // Drive team scouts never scout matches — they're pit-only. Match-scouting
  // logic below uses `matchPool` (scouts minus drive team); pit-rotation
  // planning and preference lookups keep using the full `scouts` list.
  const driveTeamIds = new Set(
    (input.driveTeamScoutIds ?? []).filter(id => scouts.some(s => s._id === id))
  );
  const matchPool = scouts.filter(s => !driveTeamIds.has(s._id));

  // 1. Build 5-match blocks
  const sorted = [...qualMatches].sort((a, b) => a.matchNumber - b.matchNumber);
  const blocks = chunk(sorted, 5);
  const B = blocks.length;
  const blockStart = (bi: number) => blocks[bi][0].matchNumber;
  const blockEnd   = (bi: number) => blocks[bi][blocks[bi].length - 1].matchNumber;

  // 2. Preference helpers
  const prefMap = new Map<string, ScoutPref>();
  for (const p of preferences) prefMap.set(p.scoutId, p);

  function prefScore(a: string, b: string): number {
    let s = 0;
    if (prefMap.get(a)?.preferredPartners.includes(b)) s++;
    if (prefMap.get(b)?.preferredPartners.includes(a)) s++;
    return s;
  }

  // 3. Build pit-busy block sets
  const pitBusyBlocks = new Map<string, Set<number>>();
  function markPitBusy(scoutId: string, start: number, end: number) {
    if (!pitBusyBlocks.has(scoutId)) pitBusyBlocks.set(scoutId, new Set());
    for (let bi = 0; bi < B; bi++) {
      if (blocks[bi].some(m => m.matchNumber >= start && m.matchNumber <= end))
        pitBusyBlocks.get(scoutId)!.add(bi);
    }
  }

  const scoutsAlreadyInPit = new Set<string>();
  const existingQualPitRanges: { start: number; end: number }[] = [];
  for (const rot of existingPitRotations) {
    if (rot.isElims) continue;
    if (rot.startMatch != null && rot.endMatch != null) {
      for (const id of rot.scoutIds) {
        markPitBusy(id, rot.startMatch, rot.endMatch);
        scoutsAlreadyInPit.add(id);
      }
      existingQualPitRanges.push({ start: rot.startMatch, end: rot.endMatch });
    }
  }

  // A window that already overlaps an existing (saved) pit rotation must not
  // get a brand-new "Auto Pit" rotation generated on top of it — otherwise
  // every press of Auto-Generate piles another duplicate rotation onto the
  // same match range (this was silently happening: the drive-team branch
  // below regenerated a rotation for every window on every run, with no
  // memory of what had already been applied).
  function windowCovered(start: number, end: number): boolean {
    return existingQualPitRanges.some(r => start <= r.end && r.start <= end);
  }

  // 4. Plan new pit rotations.
  //  - No drive team: one window per up-to-PIT_ROTATION_OTHERS_PER_WINDOW
  //    opted-in wanters, spaced across the event, each wanter serves exactly
  //    one shift (so no scout ever nears the 60-70% cap under this branch).
  //  - With a drive team: pit must be staffed for the entire event (drive
  //    team scouts have nowhere else to go), so a window is generated for
  //    every consecutive 10-match chunk from the first to the last qual
  //    match. Drive team scouts go in every window (the one documented
  //    exception to the 60-70% cap, since they have nowhere else to be);
  //    wantsPitRotation scouts are folded in (one shift each) alongside them,
  //    up to PIT_ROTATION_OTHERS_PER_WINDOW others per window.
  const PIT_ROTATION_OTHERS_PER_WINDOW = 5;
  const driveTeamCapped = scouts.filter(s => driveTeamIds.has(s._id)).map(s => s._id).slice(0, 6);
  if (driveTeamIds.size > 6) {
    warnings.push(
      `${driveTeamIds.size} drive team scouts but a pit window can only seat 6 of them — ` +
      `only the first 6 will be placed in each auto-generated pit window.`
    );
  }

  const pitWanters = scouts.filter(s =>
    prefMap.get(s._id)?.wantsPitRotation && !driveTeamIds.has(s._id) && !scoutsAlreadyInPit.has(s._id)
  );
  const newPitRotations: GeneratedPitRotation[] = [];

  if (driveTeamCapped.length > 0 && B >= 1) {
    const remainingCap = PIT_ROTATION_OTHERS_PER_WINDOW;
    let wIdx = 0;
    let labelIdx = 0;
    for (let bi = 0; bi < B; bi += 2) {
      const endBi = Math.min(bi + 1, B - 1);
      const start = blockStart(bi);
      const end = blockEnd(endBi);
      // Already covered by a saved pit rotation from a prior run — skip
      // rather than generating a duplicate on top of it.
      if (windowCovered(start, end)) continue;
      labelIdx++;
      const grp = [...driveTeamCapped];
      for (let k = 0; k < remainingCap && wIdx < pitWanters.length; k++) {
        grp.push(pitWanters[wIdx]._id);
        wIdx++;
      }
      for (const id of grp) markPitBusy(id, start, end);
      newPitRotations.push({ label: `Auto Pit ${labelIdx}`, startMatch: start, endMatch: end, scoutIds: grp });
    }
    if (wIdx < pitWanters.length) {
      warnings.push(
        `${pitWanters.length - wIdx} scout(s) opted into pit rotation but there was no room left ` +
        `alongside the drive team's full-event pit schedule to give them a shift.`
      );
    }
    // Each wanter above gets exactly one shift (wIdx never repeats a scout),
    // so no non-drive-team scout ever exceeds the 60-70% cap here — except
    // the degenerate single-window case, where one shift is unavoidably 100%.
    const totalWindows = Math.ceil(B / 2);
    if (totalWindows === 1 && wIdx > 0) {
      warnings.push(
        `Only one pit rotation window exists for this schedule — any scout given a shift is on ` +
        `pit duty 100% of the event, above the usual 60-70% cap. Unavoidable with a single window.`
      );
    }
  } else if (pitWanters.length > 0 && B >= 2) {
    const numWindows = Math.ceil(pitWanters.length / PIT_ROTATION_OTHERS_PER_WINDOW);

    // Space windows evenly, each window = 2 consecutive blocks (10 matches)
    const windowStarts: number[] = [];
    for (let w = 0; w < numWindows; w++) {
      const ideal = Math.round((w / numWindows) * (B - 1));
      windowStarts.push(Math.max(0, Math.min(ideal, B - 2)));
    }
    // Prevent overlap: each window start must be >= previous + 2.
    // The clamp to B-2 means that when there are more windows than the schedule
    // can hold, several collapse onto the same start — stacking "Auto Pit"
    // rotations on the same blocks and putting more than the documented maximum
    // of PIT_ROTATION_OTHERS_PER_WINDOW scouts on pit at once. Detect that and
    // warn rather than emitting a schedule that quietly breaks its own rules.
    for (let i = 1; i < windowStarts.length; i++) {
      if (windowStarts[i] <= windowStarts[i - 1])
        windowStarts[i] = Math.min(windowStarts[i - 1] + 2, B - 2);
    }

    const distinctStarts = new Set(windowStarts).size;
    if (distinctStarts < numWindows) {
      const capacity = distinctStarts * PIT_ROTATION_OTHERS_PER_WINDOW;
      warnings.push(
        `${pitWanters.length} scouts asked for pit duty but this schedule only has room for ` +
        `about ${capacity} (${distinctStarts} non-overlapping window${distinctStarts === 1 ? "" : "s"} ` +
        `across ${B} blocks). Some pit rotations overlap, so more than ${PIT_ROTATION_OTHERS_PER_WINDOW} ` +
        `scouts may be on pit at the same time — review the pit rotations before publishing.`
      );
    }

    let pitIdx = 0;
    let labelIdx = 0;
    for (let w = 0; w < numWindows && pitIdx < pitWanters.length; w++) {
      const bi = windowStarts[w];
      const start = blockStart(bi);
      const end   = blockEnd(Math.min(bi + 1, B - 1));
      // Already covered by a saved pit rotation from a prior run — skip
      // rather than generating a duplicate on top of it; those wanters are
      // tried again against the next window instead of being dropped.
      if (windowCovered(start, end)) continue;
      labelIdx++;
      const grp: string[] = [];
      while (grp.length < PIT_ROTATION_OTHERS_PER_WINDOW && pitIdx < pitWanters.length) {
        const s = pitWanters[pitIdx++];
        grp.push(s._id);
        markPitBusy(s._id, start, end);
      }
      newPitRotations.push({ label: `Auto Pit ${labelIdx}`, startMatch: start, endMatch: end, scoutIds: grp });
    }
  }

  // 5. Existing assignment lookup
  const existingSlots = new Map<string, string>(); // "mn-pos" -> scoutId
  for (const a of existingMatchAssignments)
    existingSlots.set(`${a.matchNumber}-${a.position}`, a.scoutId);

  function blockFullyAssigned(bi: number): boolean {
    return blocks[bi].every(m => POSITIONS.every(p => existingSlots.has(`${m.matchNumber}-${p}`)));
  }

  // 6. Seed block counts from existing assignments (match-eligible scouts only)
  const scoutBlockCounts = new Map<string, number>();
  for (const s of matchPool) scoutBlockCounts.set(s._id, 0);
  for (let bi = 0; bi < B; bi++) {
    if (blockFullyAssigned(bi)) continue;
    const seen = new Set<string>();
    for (const m of blocks[bi])
      for (const p of POSITIONS) {
        const id = existingSlots.get(`${m.matchNumber}-${p}`);
        if (id) seen.add(id);
      }
    for (const id of seen) scoutBlockCounts.set(id, (scoutBlockCounts.get(id) ?? 0) + 1);
  }

  function isPitBusy(scoutId: string, bi: number): boolean {
    return pitBusyBlocks.get(scoutId)?.has(bi) ?? false;
  }

  // 6b. Proportional block targets — scouts who opted into wantsMoreMatches
  // should end up with ~50% more blocks than everyone else. Every block has
  // exactly 6 slots, so total block-assignments across all match-eligible
  // scouts always equals B * 6; targets are each scout's weighted share.
  // Scouts who selected zero preferences default to this same 1.5x weight —
  // with nothing else claimed, they act as if they opted into more matches.
  const MORE_MATCHES_WEIGHT = 1.5;
  const totalBlockSlots = B * 6;
  const weightOf = (id: string) => {
    const pref = prefMap.get(id);
    return (pref?.wantsMoreMatches || hasNoPreferences(pref)) ? MORE_MATCHES_WEIGHT : 1;
  };
  const sumWeights = matchPool.reduce((acc, s) => acc + weightOf(s._id), 0) || 1;
  const targetBlocks = new Map<string, number>();
  for (const s of matchPool)
    targetBlocks.set(s._id, (totalBlockSlots * weightOf(s._id)) / sumWeights);

  // 7. Assign scouts to blocks
  const newAssignments: GeneratedMatchAssignment[] = [];

  for (let bi = 0; bi < B; bi++) {
    if (blockFullyAssigned(bi)) continue;

    const avail = matchPool.filter(s => !isPitBusy(s._id, bi));
    if (avail.length === 0) {
      warnings.push(`Block ${bi + 1} (Q${blockStart(bi)}–Q${blockEnd(bi)}): no scouts available, skipping.`);
      continue;
    }

    // Which positions in this block already have assignments?
    const fixedPos = new Map<Position, string>();
    for (const m of blocks[bi])
      for (const p of POSITIONS) {
        const id = existingSlots.get(`${m.matchNumber}-${p}`);
        if (id && !fixedPos.has(p)) fixedPos.set(p, id);
      }

    const alreadyInBlock = new Set(fixedPos.values());
    const openPositions = POSITIONS.filter(p => !fixedPos.has(p));
    if (openPositions.length === 0) continue;

    // Score candidates: prioritise underserved scouts, then preference affinity, then wantsMore
    const candidatePool = avail.filter(s => !alreadyInBlock.has(s._id));

    function candidateScore(s: ScoutInfo): number {
      const count = scoutBlockCounts.get(s._id) ?? 0;
      // Absolute floor still wins first: nobody should be starved below the
      // documented 2-block minimum just because their proportional target
      // (e.g. a non-wantsMoreMatches scout) happens to be lower than that.
      const underMinimum = count < 2 ? 10000 : 0;
      const target = targetBlocks.get(s._id) ?? 2;
      const deficit = target - count;
      let affinity = 0;
      for (const id of alreadyInBlock) affinity += prefScore(s._id, id);
      // Small tie-break, well below the deficit/affinity weights above: when
      // slack blocks need filling, deprioritise scouts already committed to
      // pit rotation elsewhere (zero-preference scouts no longer need a
      // boost here — their higher 1.5x target already drives the deficit
      // term above).
      const pref = prefMap.get(s._id);
      const slackNudge = pref?.wantsPitRotation ? -2 : 0;
      return underMinimum + deficit * 100 + affinity * 200 + slackNudge;
    }

    const scored = [...candidatePool].sort((a, b) => candidateScore(b) - candidateScore(a));
    const chosen = scored.slice(0, openPositions.length);
    const allSix = [...avail.filter(s => alreadyInBlock.has(s._id)).map(s => s._id), ...chosen.map(s => s._id)];

    // Alliance-aware position assignment
    const assigned = assignPositions(allSix, openPositions, fixedPos, prefScore);

    // Pit rotation is planned first and always wins (step 4, above), so if
    // there weren't enough available scouts to cover every open position,
    // some positions in this block are left blank. Report exactly which,
    // and call out pit-rotation overlap as the cause when that's why.
    const filled = new Set(assigned.keys());
    const blanks = openPositions.filter(p => !filled.has(p));
    if (blanks.length > 0) {
      const pitBusyCount = matchPool.length - avail.length;
      warnings.push(
        `Block ${bi + 1} (Q${blockStart(bi)}–Q${blockEnd(bi)}): ${blanks.length} position(s) left blank ` +
        `(${blanks.join(", ")}) — only ${avail.length} scout(s) available` +
        (pitBusyCount > 0
          ? `, ${pitBusyCount} on pit duty during this window. Pit rotation is prioritized over match scouting.`
          : ` out of ${matchPool.length} match-eligible scouts.`)
      );
    }

    // Emit for every match in block
    for (const m of blocks[bi]) {
      for (const [pos, scoutId] of assigned) {
        const key = `${m.matchNumber}-${pos}`;
        if (!existingSlots.has(key))
          newAssignments.push({ matchNumber: m.matchNumber, matchLabel: m.matchLabel, position: pos, scoutId });
      }
    }

    // Update counts
    for (const id of [...alreadyInBlock, ...chosen.map(s => s._id)])
      scoutBlockCounts.set(id, (scoutBlockCounts.get(id) ?? 0) + 1);
  }

  // 8. Warn about scouts below 2-block minimum (match-eligible scouts only —
  // drive team scouts are intentionally never assigned match blocks)
  for (const s of matchPool) {
    const count = scoutBlockCounts.get(s._id) ?? 0;
    const nonBusy = Array.from({ length: B }, (_, i) => i).filter(bi => !isPitBusy(s._id, bi)).length;
    if (count < 2 && nonBusy >= 2)
      warnings.push(`${displayName(s)} assigned to only ${count} block(s) — could not meet 2-block minimum.`);
  }

  return {
    newPitRotations,
    matchAssignments: newAssignments,
    warnings,
    stats: {
      totalBlocks: B,
      assignedSlots: newAssignments.length,
      newPitRotationCount: newPitRotations.length,
      scoutBlockCounts: Object.fromEntries(scoutBlockCounts),
    },
  };
}

// ── Pre-competition pit scouting pairs ──────────────────────────────────────
// Separate from pit ROTATION (in-event pit duty during quals, above). This
// assigns pairs of scouts to pit-scout specific TBA teams before quals start.

export interface PitScoutingExistingAssignment {
  teamNumber: number;
  scoutIds: string[];
}

export interface PitScoutingInput {
  teamNumbers: number[];
  scouts: ScoutInfo[];
  preferences: ScoutPref[];
  /** Teams that already have a non-empty scout list are left untouched. */
  existingAssignments?: PitScoutingExistingAssignment[];
  excludedScoutIds?: string[];
}

export interface PitScoutingOutput {
  teamAssignments: { teamNumber: number; scoutIds: string[] }[];
  groups: string[][];
  warnings: string[];
}

const PIT_SCOUTING_MIN_TEAMS_PER_PAIR = 6;
const PIT_SCOUTING_MAX_TEAMS_PER_PAIR = 8;

/** Greedily pair scout IDs, preferring a listed (or reciprocal) preferred
 *  partner over an arbitrary pairing. Returns complete pairs plus at most
 *  one leftover solo ID (when the input list has odd length). */
function pairByPreference(
  ids: string[],
  prefMap: Map<string, ScoutPref>,
): { pairs: string[][]; solo?: string } {
  const remaining = new Set(ids);
  const pairs: string[][] = [];
  let solo: string | undefined;
  for (const id of ids) {
    if (!remaining.has(id)) continue;
    remaining.delete(id);
    const partners = prefMap.get(id)?.preferredPartners ?? [];
    let partnerId: string | undefined;
    for (const p of partners) {
      if (remaining.has(p)) { partnerId = p; break; }
    }
    if (!partnerId) {
      for (const other of remaining) {
        if (prefMap.get(other)?.preferredPartners.includes(id)) { partnerId = other; break; }
      }
    }
    if (!partnerId) {
      const next = remaining.values().next();
      if (!next.done) partnerId = next.value;
    }
    if (partnerId) { remaining.delete(partnerId); pairs.push([id, partnerId]); }
    else solo = id;
  }
  return { pairs, solo };
}

export function generatePitScoutingTeams(input: PitScoutingInput): PitScoutingOutput {
  const warnings: string[] = [];
  const excludedSet = new Set(input.excludedScoutIds ?? []);
  const scouts = input.scouts.filter(s => !excludedSet.has(s._id));
  const prefMap = new Map<string, ScoutPref>();
  for (const p of input.preferences) prefMap.set(p.scoutId, p);

  const teamNumbers = [...new Set(input.teamNumbers)].sort((a, b) => a - b);
  const existingByTeam = new Map<number, string[]>();
  for (const e of input.existingAssignments ?? []) {
    if (e.scoutIds.length > 0) existingByTeam.set(e.teamNumber, e.scoutIds);
  }
  const unassignedTeams = teamNumbers.filter(t => !existingByTeam.has(t));
  const preserved = [...existingByTeam.entries()].map(([teamNumber, scoutIds]) => ({ teamNumber, scoutIds }));

  if (teamNumbers.length === 0) {
    return { teamAssignments: [], groups: [], warnings: ["No TBA teams loaded for this event."] };
  }
  if (unassignedTeams.length === 0) {
    return { teamAssignments: preserved, groups: [], warnings: [] };
  }
  if (scouts.length === 0) {
    return { teamAssignments: preserved, groups: [], warnings: ["No scouts available for pit scouting."] };
  }

  // 1. Pair up wantsPitScouting opt-ins first, preference-aware.
  const optedIn = scouts.filter(s => prefMap.get(s._id)?.wantsPitScouting === true);
  const { pairs: optedPairs, solo } = pairByPreference(optedIn.map(s => s._id), prefMap);
  const pairs: string[][] = optedPairs.map(p => [...p]);

  // 2. How many pairs do we need to keep every pair within 6-8 teams?
  const minPairsForCap = Math.max(1, Math.ceil(unassignedTeams.length / PIT_SCOUTING_MAX_TEAMS_PER_PAIR));
  const idealPairsForTarget = Math.max(1, Math.ceil(unassignedTeams.length / PIT_SCOUTING_MIN_TEAMS_PER_PAIR));
  const baseCount = pairs.length + (solo ? 1 : 0);

  // 3. Fallback recruits: never from scouts who opted into pit rotation
  // specifically (they've already committed elsewhere) — zero-preference
  // scouts first, then scouts with the fewest preferences selected.
  const usedIds = new Set(optedIn.map(s => s._id));
  const recruitCandidates = scouts.filter(s => !usedIds.has(s._id) && !prefMap.get(s._id)?.wantsPitRotation);
  const zeroPrefPool = recruitCandidates.filter(s => hasNoPreferences(prefMap.get(s._id)));
  const otherPool = recruitCandidates
    .filter(s => !zeroPrefPool.includes(s))
    .sort((a, b) => preferenceCount(prefMap.get(a._id)) - preferenceCount(prefMap.get(b._id)));
  const recruitPool = [...zeroPrefPool, ...otherPool];

  const extraPairsAchievableWithZero = Math.floor(zeroPrefPool.length / 2);
  const targetPairs = Math.max(minPairsForCap, Math.min(idealPairsForTarget, baseCount + extraPairsAchievableWithZero));

  let ri = 0;
  // Resolve a pending solo (odd opt-in) by pairing them with the first recruit.
  let pendingSolo = solo;
  if (pendingSolo && ri < recruitPool.length) {
    pairs.push([pendingSolo, recruitPool[ri]._id]);
    ri++;
    pendingSolo = undefined;
  }
  while (pairs.length < targetPairs && ri + 1 < recruitPool.length) {
    pairs.push([recruitPool[ri]._id, recruitPool[ri + 1]._id]);
    ri += 2;
  }
  // One leftover recruit (odd pool) — a lone scout can't form a valid 2-person
  // pair, so fold them into the smallest existing pair as a trio instead.
  if (ri < recruitPool.length && pairs.length > 0) {
    pairs.sort((a, b) => a.length - b.length);
    pairs[0].push(recruitPool[ri]._id);
    ri++;
  }
  if (pendingSolo) {
    // No recruits were available at all — better a trio (or solo) than losing
    // an opted-in scout's pit scouting assignment entirely.
    if (pairs.length > 0) { pairs.sort((a, b) => a.length - b.length); pairs[0].push(pendingSolo); }
    else pairs.push([pendingSolo]);
  }

  if (pairs.length === 0) {
    return { teamAssignments: preserved, groups: [], warnings: ["No scouts available to form pit scouting pairs."] };
  }
  if (pairs.length < minPairsForCap) {
    warnings.push(
      `Only ${pairs.length} pit scouting pair(s) available for ${unassignedTeams.length} unassigned teams — ` +
      `some pairs will need to scout more than ${PIT_SCOUTING_MAX_TEAMS_PER_PAIR} teams.`
    );
  }

  // 4. Distribute unassigned teams evenly across the final pairs.
  const teamsPerPair = Math.ceil(unassignedTeams.length / pairs.length);
  const teamAssignments = [...preserved];
  for (let i = 0; i < pairs.length; i++) {
    const slice = unassignedTeams.slice(i * teamsPerPair, (i + 1) * teamsPerPair);
    for (const t of slice) teamAssignments.push({ teamNumber: t, scoutIds: pairs[i] });
  }

  return { teamAssignments, groups: pairs, warnings };
}

// ══════════════════════════════════════════════════════════════════════════════
//  TEST SUITE
// ══════════════════════════════════════════════════════════════════════════════

export interface TestResult { name: string; passed: boolean; message: string; }

function makeMatches(n: number): QualMatch[] {
  return Array.from({ length: n }, (_, i) => ({ matchNumber: i + 1, matchLabel: `Q${i + 1}` }));
}
function makeScouts(n: number): ScoutInfo[] {
  return Array.from({ length: n }, (_, i) => ({ _id: `s${i + 1}`, name: `Scout ${i + 1}` }));
}
function makePrefs(scouts: ScoutInfo[], overrides: Partial<ScoutPref>[] = []): ScoutPref[] {
  return scouts.map((s, i) => ({
    scoutId: s._id, preferredPartners: [], wantsMoreMatches: false, wantsPitRotation: false,
    ...overrides[i],
  }));
}

export function runTests(): TestResult[] {
  const results: TestResult[] = [];

  function test(name: string, fn: () => void) {
    try { fn(); results.push({ name, passed: true, message: "OK" }); }
    catch (e: unknown) { results.push({ name, passed: false, message: (e as Error).message ?? String(e) }); }
  }
  function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

  // T1 ── Every qual slot filled
  test("T1 Every qual slot filled (12 scouts, 30 matches)", () => {
    const scouts = makeScouts(12); const matches = makeMatches(30);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: makePrefs(scouts), existingPitRotations: [], existingMatchAssignments: [] });
    const filled = new Set(out.matchAssignments.map(a => `${a.matchNumber}-${a.position}`));
    for (const m of matches)
      for (const p of POSITIONS)
        assert(filled.has(`${m.matchNumber}-${p}`), `Missing Q${m.matchNumber} ${p}`);
  });

  // T2 ── Minimum 2 blocks per scout
  test("T2 Each scout ≥2 blocks (18 scouts, 60 matches)", () => {
    const scouts = makeScouts(18); const matches = makeMatches(60);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: makePrefs(scouts), existingPitRotations: [], existingMatchAssignments: [] });
    for (const s of scouts) {
      const cnt = out.stats.scoutBlockCounts[s._id] ?? 0;
      assert(cnt >= 2, `${s.name} has ${cnt} blocks (need ≥2)`);
    }
  });

  // T3 ── Pit scouts not also assigned to scout during their pit window
  test("T3 Pit scouts absent from match assignments during pit window", () => {
    const scouts = makeScouts(14); const matches = makeMatches(40);
    const prefs = makePrefs(scouts, [{ wantsPitRotation: true }, { wantsPitRotation: true }, { wantsPitRotation: true }]);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    const pitWindow = new Map<string, { start: number; end: number }>();
    for (const rot of out.newPitRotations)
      for (const id of rot.scoutIds) pitWindow.set(id, { start: rot.startMatch, end: rot.endMatch });
    for (const a of out.matchAssignments) {
      const w = pitWindow.get(a.scoutId);
      assert(!w || a.matchNumber < w.start || a.matchNumber > w.end,
        `Scout ${a.scoutId} scouting Q${a.matchNumber} but on pit duty Q${w?.start}-Q${w?.end}`);
    }
  });

  // T4 ── Pit rotation ≤5 scouts (no drive team)
  test("T4 No pit rotation has >5 scouts", () => {
    const scouts = makeScouts(18); const matches = makeMatches(60);
    const prefs = makePrefs(scouts, scouts.map(() => ({ wantsPitRotation: true })));
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    for (const rot of out.newPitRotations)
      assert(rot.scoutIds.length <= 5, `Pit rotation has ${rot.scoutIds.length} scouts`);
  });

  // T5 ── Mutual preferred partners share an alliance
  test("T5 Mutual preferred partners share an alliance in ≥1 block", () => {
    const scouts = makeScouts(12); const matches = makeMatches(30);
    const prefs = makePrefs(scouts, [{ preferredPartners: ["s2"] }, { preferredPartners: ["s1"] }]);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    const blockGroups = chunk([...matches].sort((a, b) => a.matchNumber - b.matchNumber), 5);
    let found = false;
    for (const block of blockGroups) {
      const mn = block[0].matchNumber;
      const red = new Set(RED_POS.map(p => out.matchAssignments.find(a => a.matchNumber === mn && a.position === p)?.scoutId).filter(Boolean));
      const blue = new Set(BLUE_POS.map(p => out.matchAssignments.find(a => a.matchNumber === mn && a.position === p)?.scoutId).filter(Boolean));
      if ((red.has("s1") && red.has("s2")) || (blue.has("s1") && blue.has("s2"))) { found = true; break; }
    }
    assert(found, "s1 and s2 never shared an alliance");
  });

  // T6 ── Existing pit rotations respected
  test("T6 Existing pit rotation respected (no scouting during pit window)", () => {
    const scouts = makeScouts(12); const matches = makeMatches(30);
    const existingPit: ExistingPitRotation[] = [{ scoutIds: ["s1","s2"], startMatch: 1, endMatch: 10 }];
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: makePrefs(scouts), existingPitRotations: existingPit, existingMatchAssignments: [] });
    const pitSet = new Set([1,2,3,4,5,6,7,8,9,10]);
    for (const a of out.matchAssignments)
      assert(!(pitSet.has(a.matchNumber) && (a.scoutId === "s1" || a.scoutId === "s2")),
        `s1/s2 assigned to Q${a.matchNumber} despite pit rotation`);
  });

  // T7 ── Existing match assignments not overwritten
  test("T7 Existing match assignments preserved", () => {
    const scouts = makeScouts(12); const matches = makeMatches(20);
    const existing: ExistingMatchAssignment[] = [
      { matchNumber: 1, position: "red1", scoutId: "s1" },
      { matchNumber: 1, position: "red2", scoutId: "s2" },
    ];
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: makePrefs(scouts), existingPitRotations: [], existingMatchAssignments: existing });
    const overlap = out.matchAssignments.filter(a => a.matchNumber === 1 && (a.position === "red1" || a.position === "red2"));
    assert(overlap.length === 0, `Overwrote ${overlap.length} existing assignments`);
  });

  // T8 ── wantsMoreMatches scouts fill gaps
  test("T8 wantsMoreMatches scout gets ≥ average blocks", () => {
    const scouts = makeScouts(13); const matches = makeMatches(30);
    const prefs = makePrefs(scouts, [{ wantsMoreMatches: true }]);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    const s1 = out.stats.scoutBlockCounts["s1"] ?? 0;
    assert(s1 >= 2, `wantsMore scout s1 has only ${s1} blocks`);
  });

  // T9 ── No duplicate positions within a block
  test("T9 Each match has 6 distinct scouts (no position duplication)", () => {
    const scouts = makeScouts(12); const matches = makeMatches(25);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: makePrefs(scouts), existingPitRotations: [], existingMatchAssignments: [] });
    const blockGroups = chunk([...matches].sort((a,b) => a.matchNumber - b.matchNumber), 5);
    for (const block of blockGroups) {
      const mn = block[0].matchNumber;
      const ids = POSITIONS.map(p => out.matchAssignments.find(a => a.matchNumber === mn && a.position === p)?.scoutId).filter(Boolean);
      assert(new Set(ids).size === 6, `Block at Q${mn}: only ${new Set(ids).size} unique scouts`);
    }
  });

  // T10 ── Pre-existing pit + generate schedule compatibility
  test("T10 Pre-existing pit rotation + new schedule fills remaining blocks correctly", () => {
    const scouts = makeScouts(10); const matches = makeMatches(20);
    const existingPit: ExistingPitRotation[] = [{ scoutIds: ["s1","s2","s3"], startMatch: 11, endMatch: 20 }];
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: makePrefs(scouts), existingPitRotations: existingPit, existingMatchAssignments: [] });
    const pitSet = new Set([11,12,13,14,15,16,17,18,19,20]);
    for (const a of out.matchAssignments)
      if (pitSet.has(a.matchNumber))
        assert(!["s1","s2","s3"].includes(a.scoutId), `Pit scout ${a.scoutId} scouting Q${a.matchNumber}`);
    for (let mn = 1; mn <= 10; mn++)
      for (const p of POSITIONS)
        assert(out.matchAssignments.some(a => a.matchNumber === mn && a.position === p), `Q${mn} ${p} not filled`);
  });

  // T11 ── wantsMoreMatches scouts land ~50% above scouts with an expressed,
  // non-boosting preference (zero-preference scouts get boosted too now —
  // see T11b — so "rest" here must have a real preference to isolate this).
  test("T11 wantsMoreMatches scouts average ~1.5x the block count of scouts with other preferences", () => {
    const scouts = makeScouts(16); const matches = makeMatches(80);
    // s1-s4 opt into more matches; s5-s16 list a (mutual, non-blocking) preferred
    // partner instead, so they're not zero-preference but aren't kept off any blocks.
    const prefs = makePrefs(scouts, [
      { wantsMoreMatches: true }, { wantsMoreMatches: true }, { wantsMoreMatches: true }, { wantsMoreMatches: true },
      ...Array.from({ length: 12 }, (_, i) => ({ preferredPartners: [`s${5 + ((i + 1) % 12)}`] })),
    ]);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    const moreIds = ["s1", "s2", "s3", "s4"];
    const avg = (ids: string[]) => ids.reduce((sum, id) => sum + (out.stats.scoutBlockCounts[id] ?? 0), 0) / ids.length;
    const moreAvg = avg(moreIds);
    const restAvg = avg(scouts.map(s => s._id).filter(id => !moreIds.includes(id)));
    const ratio = moreAvg / restAvg;
    assert(ratio > 1.25 && ratio < 1.75, `Expected ~1.5x ratio, got ${ratio.toFixed(2)} (more=${moreAvg}, rest=${restAvg})`);
  });

  // T11b ── Zero-preference scouts default to the same 1.5x weight as
  // explicit wantsMoreMatches scouts (this conversation's change).
  test("T11b Zero-preference scouts average ~1.5x the block count of scouts with other preferences", () => {
    const scouts = makeScouts(16); const matches = makeMatches(80);
    // s1-s4 select zero preferences; s5-s16 list a (mutual, non-blocking) preferred
    // partner instead, so they're not zero-preference but aren't kept off any blocks.
    const prefs = makePrefs(scouts, [
      {}, {}, {}, {},
      ...Array.from({ length: 12 }, (_, i) => ({ preferredPartners: [`s${5 + ((i + 1) % 12)}`] })),
    ]);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    const zeroIds = ["s1", "s2", "s3", "s4"];
    const avg = (ids: string[]) => ids.reduce((sum, id) => sum + (out.stats.scoutBlockCounts[id] ?? 0), 0) / ids.length;
    const zeroAvg = avg(zeroIds);
    const restAvg = avg(scouts.map(s => s._id).filter(id => !zeroIds.includes(id)));
    const ratio = zeroAvg / restAvg;
    assert(ratio > 1.25 && ratio < 1.75, `Expected ~1.5x ratio, got ${ratio.toFixed(2)} (zero=${zeroAvg}, rest=${restAvg})`);
  });

  // T12 ── Scouts who don't opt into pit rotation are never auto-assigned pit duty
  test("T12 Scouts without wantsPitRotation are fully excluded from new pit rotations", () => {
    const scouts = makeScouts(14); const matches = makeMatches(40);
    const prefs = makePrefs(scouts, [{ wantsPitRotation: true }, { wantsPitRotation: true }]);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    const pitAssigned = new Set(out.newPitRotations.flatMap(r => r.scoutIds));
    for (const s of scouts) {
      if (s._id === "s1" || s._id === "s2") continue;
      assert(!pitAssigned.has(s._id), `${s._id} did not opt into pit rotation but was auto-assigned pit duty`);
    }
  });

  // T13 ── Drive team scouts are excluded from match scouting entirely
  test("T13 Drive team scouts never receive a match assignment", () => {
    const scouts = makeScouts(14); const matches = makeMatches(40);
    const out = generateSchedule({
      qualMatches: matches, scouts, preferences: makePrefs(scouts),
      existingPitRotations: [], existingMatchAssignments: [],
      driveTeamScoutIds: ["s1", "s2"],
    });
    for (const a of out.matchAssignments)
      assert(a.scoutId !== "s1" && a.scoutId !== "s2", `Drive team scout ${a.scoutId} was assigned Q${a.matchNumber}`);
  });

  // T14 ── Drive team scouts cover every pit window across the whole event
  test("T14 Drive team scouts appear in every generated pit rotation", () => {
    const scouts = makeScouts(14); const matches = makeMatches(40); // B = 8 blocks -> 4 windows
    const out = generateSchedule({
      qualMatches: matches, scouts, preferences: makePrefs(scouts),
      existingPitRotations: [], existingMatchAssignments: [],
      driveTeamScoutIds: ["s1"],
    });
    assert(out.newPitRotations.length === 4, `Expected 4 full-event pit windows, got ${out.newPitRotations.length}`);
    for (const rot of out.newPitRotations)
      assert(rot.scoutIds.includes("s1"), `Window Q${rot.startMatch}-Q${rot.endMatch} missing drive team scout s1`);
    // Windows must be contiguous and cover the whole event (Q1-Q40)
    const covered = out.newPitRotations.flatMap(r => Array.from({ length: r.endMatch - r.startMatch + 1 }, (_, i) => r.startMatch + i));
    for (let mn = 1; mn <= 40; mn++) assert(covered.includes(mn), `Q${mn} not covered by any pit window`);
  });

  // T15 ── Drive team scouts don't count toward the 2-block match minimum
  test("T15 No 2-block-minimum warning for drive team scouts", () => {
    const scouts = makeScouts(14); const matches = makeMatches(40);
    const out = generateSchedule({
      qualMatches: matches, scouts, preferences: makePrefs(scouts),
      existingPitRotations: [], existingMatchAssignments: [],
      driveTeamScoutIds: ["s1"],
    });
    assert(!out.warnings.some(w => w.includes("Scout 1") && w.includes("2-block minimum")),
      "Drive team scout incorrectly warned for missing the 2-block match minimum");
  });

  // T16 ── With a drive team, no window seats more than driveTeam + 5 others
  test("T16 Drive-team windows cap non-drive-team scouts at 5 per window", () => {
    const scouts = makeScouts(20); const matches = makeMatches(60);
    const prefs = makePrefs(scouts, [
      { wantsPitRotation: true }, ...Array.from({ length: 18 }, () => ({ wantsPitRotation: true })),
    ]);
    const out = generateSchedule({
      qualMatches: matches, scouts, preferences: prefs,
      existingPitRotations: [], existingMatchAssignments: [],
      driveTeamScoutIds: ["s1"],
    });
    for (const rot of out.newPitRotations) {
      const others = rot.scoutIds.filter(id => id !== "s1");
      assert(others.length <= 5, `Window Q${rot.startMatch}-Q${rot.endMatch} has ${others.length} non-drive-team scouts`);
    }
  });

  // T17 ── A scout with 3 preferred partners shares a block with >=2 of them
  test("T17 Scout with 3 preferred partners co-scouts with >=2 of them", () => {
    const scouts = makeScouts(14); const matches = makeMatches(50);
    const prefs = makePrefs(scouts, [{ preferredPartners: ["s2", "s3", "s4"] }]);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    const blockGroups = chunk([...matches].sort((a, b) => a.matchNumber - b.matchNumber), 5);
    const coScoutedWith = new Set<string>();
    for (const block of blockGroups) {
      const mn = block[0].matchNumber;
      const allInBlock = new Set(POSITIONS.map(p => out.matchAssignments.find(a => a.matchNumber === mn && a.position === p)?.scoutId).filter(Boolean));
      if (!allInBlock.has("s1")) continue;
      for (const partner of ["s2", "s3", "s4"]) if (allInBlock.has(partner)) coScoutedWith.add(partner);
    }
    assert(coScoutedWith.size >= 2, `s1 only ever shared a block with ${coScoutedWith.size}/3 listed partners`);
  });

  // T18 ── generatePitScoutingTeams: opted-in scouts paired by preference, 6-8 teams/pair
  test("T18 Pit scouting pairs opted-in scouts by preference, 6-8 teams each", () => {
    const scouts = makeScouts(4);
    const prefs = makePrefs(scouts, [
      { wantsPitScouting: true, preferredPartners: ["s2"] },
      { wantsPitScouting: true, preferredPartners: ["s1"] },
      { wantsPitScouting: true, preferredPartners: ["s4"] },
      { wantsPitScouting: true, preferredPartners: ["s3"] },
    ]);
    const teamNumbers = Array.from({ length: 12 }, (_, i) => 100 + i);
    const out = generatePitScoutingTeams({ teamNumbers, scouts, preferences: prefs });
    assert(out.groups.length === 2, `Expected 2 pairs, got ${out.groups.length}`);
    assert(out.groups.some(g => g.includes("s1") && g.includes("s2")), "s1/s2 not paired despite mutual preference");
    assert(out.groups.some(g => g.includes("s3") && g.includes("s4")), "s3/s4 not paired despite mutual preference");
    const perPair = new Map<string, number>();
    for (const a of out.teamAssignments) for (const id of a.scoutIds) perPair.set(id, (perPair.get(id) ?? 0) + 1);
    for (const [id, count] of perPair) assert(count >= 6 && count <= 8, `${id} assigned ${count} teams (want 6-8)`);
  });

  // T19 ── generatePitScoutingTeams: recruits zero-preference scouts before
  // scouts with some preferences, and never recruits wantsPitRotation scouts
  test("T19 Pit scouting recruits zero-preference scouts first, never pit-rotation scouts", () => {
    const scouts = makeScouts(8);
    const prefs = makePrefs(scouts, [
      { wantsPitScouting: true }, { wantsPitScouting: true }, // s1, s2: 1 pair, not enough for 24 teams
      {}, {}, // s3, s4: zero preferences
      { wantsMoreMatches: true }, // s5: 1 preference
      { wantsPitRotation: true }, { wantsPitRotation: true }, { wantsPitRotation: true }, // s6-s8: must never be recruited
    ]);
    const teamNumbers = Array.from({ length: 24 }, (_, i) => 200 + i);
    const out = generatePitScoutingTeams({ teamNumbers, scouts, preferences: prefs });
    const allRecruited = new Set(out.groups.flat());
    assert(allRecruited.has("s3") && allRecruited.has("s4"), "Zero-preference scouts s3/s4 not recruited before others");
    assert(!allRecruited.has("s6") && !allRecruited.has("s7") && !allRecruited.has("s8"),
      "wantsPitRotation scout was recruited for pit scouting — should never happen");
    for (const a of out.teamAssignments) assert(a.scoutIds.length >= 2, `Team ${a.teamNumber} has fewer than 2 scouts`);
  });

  // T20 ── generatePitScoutingTeams: existing non-empty assignments preserved
  test("T20 Pit scouting preserves existing team assignments", () => {
    const scouts = makeScouts(6);
    const prefs = makePrefs(scouts, [{ wantsPitScouting: true }, { wantsPitScouting: true }]);
    const teamNumbers = [300, 301, 302, 303, 304, 305, 306, 307];
    const existing: PitScoutingExistingAssignment[] = [{ teamNumber: 300, scoutIds: ["s5", "s6"] }];
    const out = generatePitScoutingTeams({ teamNumbers, scouts, preferences: prefs, existingAssignments: existing });
    const row = out.teamAssignments.find(a => a.teamNumber === 300);
    assert(!!row && row.scoutIds.length === 2 && row.scoutIds.includes("s5") && row.scoutIds.includes("s6"),
      "Existing team 300 assignment was not preserved");
  });

  // T21 ── Re-running Auto-Generate against its own previously-applied output
  // must not create duplicate/overlapping pit rotations (this conversation's
  // fix — the drive-team branch used to regenerate every window on every
  // run with no memory of what had already been saved).
  test("T21 Re-running against already-applied pit rotations creates no duplicates", () => {
    const scouts = makeScouts(10); const matches = makeMatches(40); // B = 8 blocks -> 4 windows
    const prefs = makePrefs(scouts, [{}, { wantsPitRotation: true }, { wantsPitRotation: true }]);
    const run1 = generateSchedule({
      qualMatches: matches, scouts, preferences: prefs,
      existingPitRotations: [], existingMatchAssignments: [],
      driveTeamScoutIds: ["s1"],
    });
    assert(run1.newPitRotations.length === 4, `First run: expected 4 windows, got ${run1.newPitRotations.length}`);

    // Simulate "Apply": what run1 generated is now saved as existingPitRotations.
    const appliedPit: ExistingPitRotation[] = run1.newPitRotations.map(r => ({
      startMatch: r.startMatch, endMatch: r.endMatch, isElims: false, scoutIds: r.scoutIds,
    }));
    const run2 = generateSchedule({
      qualMatches: matches, scouts, preferences: prefs,
      existingPitRotations: appliedPit, existingMatchAssignments: [],
      driveTeamScoutIds: ["s1"],
    });
    assert(run2.newPitRotations.length === 0,
      `Second run against already-applied rotations should generate 0 new ones, got ${run2.newPitRotations.length}`);
  });

  // T22 ── Cycles land exactly on 1-10, 11-20, ... (no off-by-one like "10-20")
  test("T22 Pit rotation windows are exact 10-match cycles (1-10, 11-20, ...)", () => {
    const scouts = makeScouts(10); const matches = makeMatches(40);
    const prefs = makePrefs(scouts, [{}, { wantsPitRotation: true }]);
    const out = generateSchedule({
      qualMatches: matches, scouts, preferences: prefs,
      existingPitRotations: [], existingMatchAssignments: [],
      driveTeamScoutIds: ["s1"],
    });
    const expected = [[1, 10], [11, 20], [21, 30], [31, 40]];
    assert(out.newPitRotations.length === expected.length,
      `Expected ${expected.length} windows, got ${out.newPitRotations.length}`);
    out.newPitRotations.forEach((r, i) => {
      assert(r.startMatch === expected[i][0] && r.endMatch === expected[i][1],
        `Window ${i}: expected Q${expected[i][0]}-Q${expected[i][1]}, got Q${r.startMatch}-Q${r.endMatch}`);
    });
  });

  return results;
}
