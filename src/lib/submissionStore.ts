/**
 * submissionStore.ts
 *
 * Persists scouting form submissions locally (localStorage) so QR codes can
 * be generated at any time — even fully offline.
 *
 * Submissions are stored under the key `falconscout_my_submissions` as a
 * JSON array of LocalSubmission objects, newest first.
 *
 * Chunking for QR codes
 * ─────────────────────
 * Each submission is serialised as a compact envelope, then split into chunks
 * of at most MAX_CHUNK_CHARS characters. Each chunk is a self-contained JSON
 * string that can be decoded independently once all chunks for an id are
 * collected.
 *
 * Envelope format (per chunk), version 2:
 *   { v:2, id:"<12-char>", tid:"<templateId>", cl:"qm"|"elim",
 *     m:<matchNum>, t:<teamNum>, e:"<eventKey>",
 *     i:<chunkIndex>, n:<totalChunks>, d:"<chunkData>" }
 *
 * v2 adds `tid` and `cl`. Without `tid` the scanner had to guess which form a
 * scanned submission belonged to, which silently mislabelled the data; without
 * `cl` a qualification and an elimination match with the same number were
 * indistinguishable. `id` is now a 12-char slice rather than a full 36-char
 * UUID — it is repeated in every chunk, and 12 hex chars is ample to keep
 * submissions distinct within one event.
 */

export interface LocalSubmission {
  id: string;
  matchNumber: number;
  /** Qualification or elimination — distinguishes qual 5 from elim 5. */
  compLevel?: "qm" | "elim";
  teamNumber: number;
  templateId: string;
  templateName: string;
  eventKey: string;
  data: Record<string, unknown>;
  fieldLabels: Record<string, string>; // fieldId → human label
  submittedAt: number;
}

const STORE_KEY    = "falconscout_my_submissions";
const MAX_KEEP     = 200;          // maximum submissions to retain
export const MAX_CHUNK_CHARS = 800; // conservative QR capacity (works at any ECL)

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function getMySubmissions(): LocalSubmission[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as LocalSubmission[]) : [];
  } catch { return []; }
}

export function saveMySubmission(sub: LocalSubmission): void {
  try {
    const all = getMySubmissions();
    // Deduplicate by id
    const filtered = all.filter((s) => s.id !== sub.id);
    // Newest first, trim to max
    const next = [sub, ...filtered].slice(0, MAX_KEEP);
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch { /* quota */ }
}

export function deleteMySubmission(id: string): void {
  try {
    const next = getMySubmissions().filter((s) => s.id !== id);
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch { /* quota */ }
}

export function clearMySubmissions(): void {
  localStorage.removeItem(STORE_KEY);
}

// ── QR chunking ───────────────────────────────────────────────────────────────

export interface QRChunk {
  index: number;   // 0-based
  total: number;
  payload: string; // the string to encode into the QR
}

/** Envelope version emitted by this build. */
export const QR_VERSION = 2;

/** Short id carried in every chunk — see the note on `id` above. */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 12);
}

/**
 * Serialise a LocalSubmission into one or more QR-code-safe strings.
 * The data payload is split so that each *encoded* payload fits within
 * MAX_CHUNK_CHARS.
 */
export function toQRChunks(sub: LocalSubmission): QRChunk[] {
  const dataStr = JSON.stringify(sub.data);
  const id = shortId(sub.id);

  const envelope = (i: number, n: number, d: string) =>
    JSON.stringify({
      v: QR_VERSION,
      id,
      tid: sub.templateId,
      cl: sub.compLevel,
      m: sub.matchNumber,
      t: sub.teamNumber,
      e: sub.eventKey,
      i,
      n,
      d,
    });

  // Measure the ENCODED payload, not the raw slice. JSON.stringify escapes every
  // quote inside `d`, so a slice sized against the raw budget produced payloads
  // well over MAX_CHUNK_CHARS once embedded (~870 chars against an 800 budget on
  // a typical 40-field form). Shrink the slice until the real payload fits.
  const segments: string[] = [];
  let pos = 0;
  // Optimistic starting width, corrected per chunk by the loop below.
  const nominal = Math.max(1, MAX_CHUNK_CHARS - envelope(99, 99, "").length - 4);

  while (pos < dataStr.length) {
    let width = Math.min(nominal, dataStr.length - pos);
    // Chunk count is not known until we finish, so size against a worst-case
    // 3-digit i/n. Overestimating the header only costs a few characters.
    while (width > 1 && envelope(999, 999, dataStr.slice(pos, pos + width)).length > MAX_CHUNK_CHARS) {
      // Shrink proportionally to the overshoot rather than one char at a time.
      const over = envelope(999, 999, dataStr.slice(pos, pos + width)).length - MAX_CHUNK_CHARS;
      width = Math.max(1, width - Math.max(1, Math.ceil(over / 2)));
    }
    segments.push(dataStr.slice(pos, pos + width));
    pos += width;
  }
  if (segments.length === 0) segments.push("");

  return segments.map((seg, i) => ({
    index: i,
    total: segments.length,
    payload: envelope(i, segments.length, seg),
  }));
}
