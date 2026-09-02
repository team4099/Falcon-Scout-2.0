/**
 * QR pipeline: chunking, envelope format, reassembly.
 *
 * Covers three audit findings — the scanner guessing the template (FS-03), a
 * corrupt reassembly being stored as an empty submission (FS-06), and chunk
 * payloads overrunning their own size budget once JSON-escaped (FS-07).
 */
import { beforeEach, describe, expect, test } from "vitest";
import { MAX_CHUNK_CHARS, toQRChunks, type LocalSubmission } from "./submissionStore";
import { ingestQRPayload } from "./scannedDataStore";

// jsdom supplies localStorage; both modules persist through it.
beforeEach(() => localStorage.clear());

function submission(fieldCount: number, stringHeavy = false): LocalSubmission {
  const data: Record<string, unknown> = { _matchPrefix: "qm", _matchNumber: 12 };
  for (let i = 0; i < fieldCount; i++) {
    data[`fld_${i}_${"abcdefgh".slice(0, 8)}`] = stringHeavy
      ? "a free text scouting note about the robot"
      : i % 3 === 0 ? true : i * 7;
  }
  return {
    id: "3f8a1c2e-9b4d-4e7f-a1b2-c3d4e5f60718",
    matchNumber: 12,
    compLevel: "qm",
    teamNumber: 4099,
    templateId: "n578s96vsj5qjvzqdc2jb8t32x8dnx6h",
    templateName: "Match Scouting",
    eventKey: "2025chcmp",
    data,
    fieldLabels: {},
    submittedAt: 1_700_000_000_000,
  };
}

const scanAll = (chunks: { payload: string }[]) =>
  chunks.reduce<ReturnType<typeof ingestQRPayload> | undefined>(
    (_, c) => ingestQRPayload(c.payload), undefined,
  )!;

describe("chunk sizing", () => {
  // The old implementation sized the slice against the RAW budget, then
  // embedded it in JSON where every quote doubled — producing ~870-char
  // payloads against an 800 budget.
  test.each([
    ["small",        submission(2)],
    ["typical form", submission(40)],
    ["string-heavy", submission(60, true)],
  ])("%s stays within MAX_CHUNK_CHARS once encoded", (_label, sub) => {
    for (const c of toQRChunks(sub)) {
      expect(c.payload.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  test("every chunk is valid JSON carrying its index and total", () => {
    const chunks = toQRChunks(submission(40));
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      const env = JSON.parse(c.payload);
      expect(env.i).toBe(i);
      expect(env.n).toBe(chunks.length);
      expect(env.v).toBe(2);
    });
  });
});

describe("round trip", () => {
  test.each([1, 40, 60])("preserves data, templateId and compLevel (%i fields)", (n) => {
    const sub = submission(n, n === 60);
    const result = scanAll(toQRChunks(sub));
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.submission.data).toEqual(sub.data);
    // FS-03: the scanner used to guess the template from the active list.
    expect(result.submission.templateId).toBe(sub.templateId);
    expect(result.submission.compLevel).toBe("qm");
    expect(result.submission.teamNumber).toBe(4099);
  });

  test("a second scan of the same submission is a duplicate", () => {
    const chunks = toQRChunks(submission(3));
    expect(scanAll(chunks).status).toBe("complete");
    expect(ingestQRPayload(chunks[0].payload).status).toBe("duplicate");
  });

  test("partial scans report progress", () => {
    const chunks = toQRChunks(submission(40));
    const first = ingestQRPayload(chunks[0].payload);
    expect(first.status).toBe("buffering");
    if (first.status !== "buffering") return;
    expect(first.chunksNeeded).toBe(chunks.length);
  });
});

describe("rejected input", () => {
  test("a v1 code is reported as outdated, never guessed", () => {
    const v1 = JSON.stringify({
      v: 1, id: "abc", m: 1, t: 4099, e: "2025chcmp", i: 0, n: 1, d: '{"x":1}',
    });
    expect(ingestQRPayload(v1).status).toBe("outdated");
  });

  test("a v2 code with no templateId is outdated too", () => {
    const noTid = JSON.stringify({
      v: 2, id: "abc", m: 1, t: 4099, e: "e", i: 0, n: 1, d: "{}",
    });
    expect(ingestQRPayload(noTid).status).toBe("outdated");
  });

  test("a non-FalconScout QR is ignored", () => {
    expect(ingestQRPayload("https://example.com").status).toBe("ignored");
    expect(ingestQRPayload("{}").status).toBe("ignored");
  });
});

describe("corrupt reassembly", () => {
  // FS-06: the parse failure used to be swallowed and an EMPTY submission was
  // stored and uploaded under a real match and team number.
  test("stores nothing and keeps the buffer so a rescan recovers", () => {
    const chunks = toQRChunks(submission(60, true));
    expect(chunks.length).toBeGreaterThan(2);

    const lastIndex = chunks.length - 1;
    let last!: ReturnType<typeof ingestQRPayload>;
    chunks.forEach((c, i) => {
      if (i === lastIndex) {
        // Truncating the tail drops the closing brace, so the reassembled
        // string cannot parse. (Snipping the middle of a long text value
        // often still yields valid JSON.)
        const damaged = JSON.parse(c.payload);
        damaged.d = damaged.d.slice(0, -8);
        last = ingestQRPayload(JSON.stringify(damaged));
      } else {
        last = ingestQRPayload(c.payload);
      }
    });

    expect(last.status).toBe("corrupt");
    expect(JSON.parse(localStorage.getItem("falconscout_scanned_submissions") ?? "[]")).toHaveLength(0);

    // Rescanning the code that read badly completes the submission.
    const fixed = ingestQRPayload(chunks[lastIndex].payload);
    expect(fixed.status).toBe("complete");
    expect(JSON.parse(localStorage.getItem("falconscout_scanned_submissions") ?? "[]")).toHaveLength(1);
  });

  test("a single-chunk code with unparseable data is corrupt, not complete", () => {
    const bad = JSON.stringify({
      v: 2, id: "x1", tid: "t1", cl: "qm", m: 1, t: 4099,
      e: "e", i: 0, n: 1, d: "{not json",
    });
    expect(ingestQRPayload(bad).status).toBe("corrupt");
    expect(JSON.parse(localStorage.getItem("falconscout_scanned_submissions") ?? "[]")).toHaveLength(0);
  });
});
