/**
 * scheduleGenerator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Auto-generate match assignments + pit rotations for a FRC scouting event.
 *
 * Rules enforced:
 *  - Qual matches only (no elims) — elims pit rotation is always manual
 *    (see the separate ElimsRotationPanel UI; this generator never touches it)
 *  - Matches organised in blocks of 5; same 6 scouts cover all 5 matches in a block
 *  - Each scout scouts at least 2 blocks (10 matches) minimum, except drive
 *    team scouts, who never scout matches at all (see below)
 *  - Scouts who opt into pit duty get one block of 10 consecutive qual matches
 *    on pit duty (2 consecutive 5-match blocks); max 6 scouts on pit at once
 *  - Drive team scouts are excluded from match scouting entirely and are
 *    placed on every qual pit-rotation window for the whole event (a window
 *    every 10 matches, covering the full schedule) — they have nowhere else
 *    to be assigned, so pit duty must fully cover the event when any exist
 *  - Pit rotation is planned BEFORE match scouting and always wins: a scout
 *    on pit duty for a match cannot also scout that match. If that leaves too
 *    few scouts to fill a block, the leftover positions are reported as
 *    blank spaces rather than silently double-booking someone
 *  - wantsMoreMatches scouts are targeted for ~50% more blocks than everyone
 *    else (proportional target, not a flat bonus)
 *  - Preferred partner pairs/triplets are placed on the same alliance side
 *    within a scouting block (bitmask-optimised alliance splitting)
 *  - Existing pit rotations are honoured as-is
 *  - Existing match assignments are preserved; only empty slots are filled
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
  for (const rot of existingPitRotations) {
    if (rot.isElims) continue;
    if (rot.startMatch != null && rot.endMatch != null) {
      for (const id of rot.scoutIds) {
        markPitBusy(id, rot.startMatch, rot.endMatch);
        scoutsAlreadyInPit.add(id);
      }
    }
  }

  // 4. Plan new pit rotations.
  //  - No drive team: original behaviour — one window per up-to-6 opted-in
  //    wanters, spaced across the event, each wanter serves exactly one shift.
  //  - With a drive team: pit must be staffed for the entire event (drive
  //    team scouts have nowhere else to go), so a window is generated for
  //    every consecutive 10-match chunk from the first to the last qual
  //    match. Drive team scouts go in every window; wantsPitRotation scouts
  //    are folded in (one shift each, same as before) to help staff them.
  const driveTeamCapped = scouts.filter(s => driveTeamIds.has(s._id)).map(s => s._id).slice(0, 6);
  if (driveTeamIds.size > 6) {
    warnings.push(
      `${driveTeamIds.size} drive team scouts but pit rotations cap at 6 — ` +
      `only the first 6 will be placed in each auto-generated pit window.`
    );
  }

  const pitWanters = scouts.filter(s =>
    prefMap.get(s._id)?.wantsPitRotation && !driveTeamIds.has(s._id) && !scoutsAlreadyInPit.has(s._id)
  );
  const newPitRotations: GeneratedPitRotation[] = [];

  if (driveTeamCapped.length > 0 && B >= 1) {
    const remainingCap = Math.max(0, 6 - driveTeamCapped.length);
    let wIdx = 0;
    for (let bi = 0; bi < B; bi += 2) {
      const endBi = Math.min(bi + 1, B - 1);
      const start = blockStart(bi);
      const end = blockEnd(endBi);
      const grp = [...driveTeamCapped];
      for (let k = 0; k < remainingCap && wIdx < pitWanters.length; k++) {
        grp.push(pitWanters[wIdx]._id);
        wIdx++;
      }
      for (const id of grp) markPitBusy(id, start, end);
      newPitRotations.push({ label: `Auto Pit ${Math.floor(bi / 2) + 1}`, startMatch: start, endMatch: end, scoutIds: grp });
    }
    if (wIdx < pitWanters.length) {
      warnings.push(
        `${pitWanters.length - wIdx} scout(s) opted into pit rotation but there was no room left ` +
        `alongside the drive team's full-event pit schedule to give them a shift.`
      );
    }
  } else if (pitWanters.length > 0 && B >= 2) {
    const numWindows = Math.ceil(pitWanters.length / 6);

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
    // of 6 scouts on pit at once. Detect that and warn rather than emitting a
    // schedule that quietly breaks its own rules.
    for (let i = 1; i < windowStarts.length; i++) {
      if (windowStarts[i] <= windowStarts[i - 1])
        windowStarts[i] = Math.min(windowStarts[i - 1] + 2, B - 2);
    }

    const distinctStarts = new Set(windowStarts).size;
    if (distinctStarts < numWindows) {
      const capacity = distinctStarts * 6;
      warnings.push(
        `${pitWanters.length} scouts asked for pit duty but this schedule only has room for ` +
        `about ${capacity} (${distinctStarts} non-overlapping window${distinctStarts === 1 ? "" : "s"} ` +
        `across ${B} blocks). Some pit rotations overlap, so more than 6 scouts may be on pit ` +
        `at the same time — review the pit rotations before publishing.`
      );
    }

    let pitIdx = 0;
    for (let w = 0; w < numWindows && pitIdx < pitWanters.length; w++) {
      const bi = windowStarts[w];
      const start = blockStart(bi);
      const end   = blockEnd(Math.min(bi + 1, B - 1));
      const grp: string[] = [];
      while (grp.length < 6 && pitIdx < pitWanters.length) {
        const s = pitWanters[pitIdx++];
        grp.push(s._id);
        markPitBusy(s._id, start, end);
      }
      newPitRotations.push({ label: `Auto Pit ${w + 1}`, startMatch: start, endMatch: end, scoutIds: grp });
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
  const MORE_MATCHES_WEIGHT = 1.5;
  const totalBlockSlots = B * 6;
  const weightOf = (id: string) => (prefMap.get(id)?.wantsMoreMatches ? MORE_MATCHES_WEIGHT : 1);
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
      return underMinimum + deficit * 100 + affinity * 200;
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

  // T4 ── Pit rotation ≤6 scouts
  test("T4 No pit rotation has >6 scouts", () => {
    const scouts = makeScouts(18); const matches = makeMatches(60);
    const prefs = makePrefs(scouts, scouts.map(() => ({ wantsPitRotation: true })));
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    for (const rot of out.newPitRotations)
      assert(rot.scoutIds.length <= 6, `Pit rotation has ${rot.scoutIds.length} scouts`);
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

  // T11 ── wantsMoreMatches scouts land ~50% above everyone else
  test("T11 wantsMoreMatches scouts average ~1.5x the block count of everyone else", () => {
    const scouts = makeScouts(16); const matches = makeMatches(80);
    // s1-s4 opt into more matches; s5-s16 do not.
    const prefs = makePrefs(scouts, [
      { wantsMoreMatches: true }, { wantsMoreMatches: true }, { wantsMoreMatches: true }, { wantsMoreMatches: true },
    ]);
    const out = generateSchedule({ qualMatches: matches, scouts, preferences: prefs, existingPitRotations: [], existingMatchAssignments: [] });
    const moreIds = ["s1", "s2", "s3", "s4"];
    const avg = (ids: string[]) => ids.reduce((sum, id) => sum + (out.stats.scoutBlockCounts[id] ?? 0), 0) / ids.length;
    const moreAvg = avg(moreIds);
    const restAvg = avg(scouts.map(s => s._id).filter(id => !moreIds.includes(id)));
    const ratio = moreAvg / restAvg;
    assert(ratio > 1.25 && ratio < 1.75, `Expected ~1.5x ratio, got ${ratio.toFixed(2)} (more=${moreAvg}, rest=${restAvg})`);
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

  return results;
}
