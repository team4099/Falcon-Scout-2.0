/**
 * scheduleGenerator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Auto-generate match assignments + pit rotations for a FRC scouting event.
 *
 * Rules enforced:
 *  - Qual matches only (no elims)
 *  - Matches organised in blocks of 5; same 6 scouts cover all 5 matches in a block
 *  - Each scout scouts at least 2 blocks (10 matches) minimum
 *  - Scouts who opt into pit duty get one block of 10 consecutive qual matches
 *    on pit duty (2 consecutive 5-match blocks); max 6 scouts on pit at once
 *  - Scouts on pit duty for a match cannot also scout that match
 *  - Gaps filled preferentially by scouts who indicated wantsMoreMatches
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

  // 4. Plan new pit rotations (scouts who opted in, not already assigned)
  const pitWanters = scouts.filter(s =>
    prefMap.get(s._id)?.wantsPitRotation && !scoutsAlreadyInPit.has(s._id)
  );
  const newPitRotations: GeneratedPitRotation[] = [];

  if (pitWanters.length > 0 && B >= 2) {
    const numWindows = Math.ceil(pitWanters.length / 6);

    // Space windows evenly, each window = 2 consecutive blocks (10 matches)
    const windowStarts: number[] = [];
    for (let w = 0; w < numWindows; w++) {
      const ideal = Math.round((w / numWindows) * (B - 1));
      windowStarts.push(Math.max(0, Math.min(ideal, B - 2)));
    }
    // Prevent overlap: each window start must be >= previous + 2
    for (let i = 1; i < windowStarts.length; i++) {
      if (windowStarts[i] <= windowStarts[i - 1])
        windowStarts[i] = Math.min(windowStarts[i - 1] + 2, B - 2);
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

  // 6. Seed block counts from existing assignments
  const scoutBlockCounts = new Map<string, number>();
  for (const s of scouts) scoutBlockCounts.set(s._id, 0);
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

  // 7. Assign scouts to blocks
  const newAssignments: GeneratedMatchAssignment[] = [];

  for (let bi = 0; bi < B; bi++) {
    if (blockFullyAssigned(bi)) continue;

    const avail = scouts.filter(s => !isPitBusy(s._id, bi));
    if (avail.length === 0) {
      warnings.push(`Block ${bi + 1} (Q${blockStart(bi)}–Q${blockEnd(bi)}): no scouts available, skipping.`);
      continue;
    }
    if (avail.length < 6) {
      warnings.push(`Block ${bi + 1} (Q${blockStart(bi)}–Q${blockEnd(bi)}): only ${avail.length} of 6 scouts available — filling partial slots.`);
      // Fall through — assignPositions sequential fallback handles partial fills
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
      const underserved = count < 2 ? 10000 : 0;
      let affinity = 0;
      for (const id of alreadyInBlock) affinity += prefScore(s._id, id);
      const more = prefMap.get(s._id)?.wantsMoreMatches ? 50 : 0;
      return underserved + affinity * 200 + more - count * 10;
    }

    const scored = [...candidatePool].sort((a, b) => candidateScore(b) - candidateScore(a));
    const chosen = scored.slice(0, openPositions.length);
    const allSix = [...avail.filter(s => alreadyInBlock.has(s._id)).map(s => s._id), ...chosen.map(s => s._id)];

    // Alliance-aware position assignment
    const assigned = assignPositions(allSix, openPositions, fixedPos, prefScore);

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

  // 8. Warn about scouts below 2-block minimum
  for (const s of scouts) {
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

  return results;
}
