/**
 * scannedDataStore.ts
 *
 * Stores QR-scanned scouting submissions locally and handles:
 *   1. Chunk reassembly  — multi-QR submissions are buffered until all
 *      chunks arrive, then merged into a single ScannedSubmission.
 *   2. Deduplication     — a submission ID that already exists in either
 *      this store OR the "my submissions" store is silently ignored so we
 *      never store two copies of the same match data.
 *   3. Upload tracking   — each record carries a status so the UI can
 *      show pending / uploaded / failed states.
 *
 * QR envelope format (per chunk, as JSON string), version 2:
 *   { v:2, id:"<12-char>", tid:"<templateId>", cl:"qm"|"elim",
 *     m:<matchNum>, t:<teamNum>, e:"<eventKey>",
 *     i:<chunkIndex>, n:<totalChunks>, d:"<dataChunk>" }
 *
 * v1 codes carried no templateId, so the scanner had to guess which form the
 * data belonged to. Rather than keep guessing, v1 is rejected with a message
 * telling the scout to regenerate the code from their My QR Codes tab.
 */

import { getMySubmissions } from "./submissionStore";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QREnvelope {
  v: number;
  id: string;
  tid: string;             // templateId the submission was filled out against
  cl?: "qm" | "elim";      // comp level
  m: number;  // matchNumber
  t: number;  // teamNumber
  e: string;  // eventKey
  i: number;  // chunkIndex (0-based)
  n: number;  // totalChunks
  d: string;  // data chunk
}

export type UploadStatus = "pending" | "uploaded" | "failed";

export interface ScannedSubmission {
  id: string;           // same as QR envelope id — used as offlineId
  templateId: string;   // which form this was filled out against
  matchNumber: number;
  compLevel?: "qm" | "elim";
  teamNumber: number;
  eventKey: string;
  data: Record<string, unknown>;
  scannedAt: number;
  uploadStatus: UploadStatus;
  /** Convex document ID once successfully uploaded */
  convexId?: string;
}

// Partial scan buffer for multi-chunk submissions
interface ChunkBuffer {
  id: string;
  templateId: string;
  matchNumber: number;
  compLevel?: "qm" | "elim";
  teamNumber: number;
  eventKey: string;
  chunks: Record<number, string>; // chunkIndex → dataChunk
  total: number;
  firstSeenAt: number;
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const SCANNED_KEY = "falconscout_scanned_submissions";
const CHUNK_BUF_KEY = "falconscout_chunk_buffers";
const MAX_SCANNED = 500;
const CHUNK_BUF_TTL_MS = 1000 * 60 * 30; // 30 min — discard stale partial scans

// ── Scanned submissions store ─────────────────────────────────────────────────

export function getScannedSubmissions(): ScannedSubmission[] {
  try {
    const raw = localStorage.getItem(SCANNED_KEY);
    return raw ? (JSON.parse(raw) as ScannedSubmission[]) : [];
  } catch { return []; }
}

function saveScannedSubmissions(subs: ScannedSubmission[]): void {
  try {
    localStorage.setItem(SCANNED_KEY, JSON.stringify(subs.slice(0, MAX_SCANNED)));
  } catch { /* quota */ }
}

export function updateScannedStatus(
  id: string,
  status: UploadStatus,
  convexId?: string
): void {
  const subs = getScannedSubmissions().map((s) =>
    s.id === id ? { ...s, uploadStatus: status, ...(convexId ? { convexId } : {}) } : s
  );
  saveScannedSubmissions(subs);
}

export function deleteScannedSubmission(id: string): void {
  saveScannedSubmissions(getScannedSubmissions().filter((s) => s.id !== id));
}

export function clearScannedSubmissions(): void {
  localStorage.removeItem(SCANNED_KEY);
}

// ── Chunk buffer ──────────────────────────────────────────────────────────────

function getChunkBuffers(): Record<string, ChunkBuffer> {
  try {
    const raw = localStorage.getItem(CHUNK_BUF_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ChunkBuffer>) : {};
  } catch { return {}; }
}

function saveChunkBuffers(bufs: Record<string, ChunkBuffer>): void {
  try {
    localStorage.setItem(CHUNK_BUF_KEY, JSON.stringify(bufs));
  } catch { /* quota */ }
}

/** Remove chunk buffers that are stale (> 30 min old with missing chunks). */
export function evictStaleChunkBuffers(): void {
  const bufs = getChunkBuffers();
  const now = Date.now();
  const fresh: Record<string, ChunkBuffer> = {};
  for (const [id, buf] of Object.entries(bufs)) {
    if (now - buf.firstSeenAt < CHUNK_BUF_TTL_MS) fresh[id] = buf;
  }
  saveChunkBuffers(fresh);
}

// ── Deduplication check ───────────────────────────────────────────────────────

/** Returns true if this submission ID is already stored anywhere locally. */
function isDuplicate(id: string): boolean {
  if (getScannedSubmissions().some((s) => s.id === id)) return true;
  if (getMySubmissions().some((s) => s.id === id)) return true;
  return false;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export type IngestResult =
  | { status: "duplicate" }
  | { status: "ignored" }                                  // not a FalconScout code
  | { status: "outdated" }                                 // v1 code — must be regenerated
  | { status: "corrupt" }                                  // chunks did not reassemble
  | { status: "buffering"; chunksReceived: number; chunksNeeded: number }
  | { status: "complete"; submission: ScannedSubmission };

/** Envelope version this build understands. */
const SUPPORTED_VERSION = 2;

/**
 * Parse a raw QR string and ingest it.
 * Returns the result — caller should attempt upload when status === "complete".
 */
export function ingestQRPayload(raw: string): IngestResult {
  let env: QREnvelope;
  try {
    env = JSON.parse(raw) as QREnvelope;
    if (!env.id || env.i === undefined || env.n === undefined) {
      throw new Error("bad envelope");
    }
  } catch {
    return { status: "ignored" }; // not a FalconScout QR at all
  }

  // A v1 code has no templateId, so its data cannot be attributed to a form.
  // Say so instead of guessing and mislabelling the submission.
  if (env.v !== SUPPORTED_VERSION) return { status: "outdated" };
  if (!env.tid) return { status: "outdated" };

  // ── Single-chunk fast path ──────────────────────────────────────────────
  if (env.n === 1) {
    if (isDuplicate(env.id)) return { status: "duplicate" };

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(env.d) as Record<string, unknown>;
    } catch {
      return { status: "corrupt" };
    }

    // Checklist QR codes are not scouting data — silently skip them
    if (data._checklist === true) return { status: "ignored" };

    const sub: ScannedSubmission = {
      id: env.id,
      templateId: env.tid,
      matchNumber: env.m,
      compLevel: env.cl,
      teamNumber: env.t,
      eventKey: env.e,
      data,
      scannedAt: Date.now(),
      uploadStatus: "pending",
    };
    saveScannedSubmissions([sub, ...getScannedSubmissions()]);
    return { status: "complete", submission: sub };
  }

  // ── Multi-chunk buffering ───────────────────────────────────────────────
  if (isDuplicate(env.id)) return { status: "duplicate" };

  const bufs = getChunkBuffers();
  const buf: ChunkBuffer = bufs[env.id] ?? {
    id: env.id,
    templateId: env.tid,
    matchNumber: env.m,
    compLevel: env.cl,
    teamNumber: env.t,
    eventKey: env.e,
    chunks: {},
    total: env.n,
    firstSeenAt: Date.now(),
  };
  buf.chunks[env.i] = env.d;
  bufs[env.id] = buf;
  saveChunkBuffers(bufs);

  const received = Object.keys(buf.chunks).length;
  if (received < buf.total) {
    return { status: "buffering", chunksReceived: received, chunksNeeded: buf.total };
  }

  // All chunks received — reassemble.
  const fullDataStr = Array.from({ length: buf.total }, (_, i) => buf.chunks[i] ?? "").join("");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fullDataStr) as Record<string, unknown>;
  } catch {
    // A chunk was misread. Previously this was swallowed and an EMPTY
    // submission was stored and uploaded under a real match and team number,
    // with the scanner reporting success. Keep the buffer so a rescan of the
    // bad code can still complete it, and tell the user.
    return { status: "corrupt" };
  }

  // Reassembled cleanly — drop the buffer.
  delete bufs[env.id];
  saveChunkBuffers(bufs);

  if (isDuplicate(env.id)) return { status: "duplicate" };

  // Checklist QR codes are not scouting data — silently skip them
  if (data._checklist === true) return { status: "ignored" };

  const sub: ScannedSubmission = {
    id: env.id,
    templateId: buf.templateId,
    matchNumber: buf.matchNumber,
    compLevel: buf.compLevel,
    teamNumber: buf.teamNumber,
    eventKey: buf.eventKey,
    data,
    scannedAt: Date.now(),
    uploadStatus: "pending",
  };
  saveScannedSubmissions([sub, ...getScannedSubmissions()]);
  return { status: "complete", submission: sub };
}
