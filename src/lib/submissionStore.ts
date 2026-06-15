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
 * Envelope format (per chunk):
 *   { v:1, id:"<8-char>", m:<matchNum>, t:<teamNum>, e:"<eventKey>",
 *     i:<chunkIndex>, n:<totalChunks>, d:"<chunkData>" }
 */

export interface LocalSubmission {
  id: string;
  matchNumber: number;
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

/**
 * Serialise a LocalSubmission into one or more QR-code-safe strings.
 * The data payload is split if it exceeds MAX_CHUNK_CHARS.
 */
export function toQRChunks(sub: LocalSubmission): QRChunk[] {
  // Compact data serialisation — fieldId:value pairs joined by ~
  const dataStr = JSON.stringify(sub.data);

  // Fixed envelope header (without the data segment or chunk indices)
  // We'll measure how much space the header takes and fill the rest with data.
  const headerTemplate = (i: number, n: number) =>
    JSON.stringify({ v: 1, id: sub.id, m: sub.matchNumber, t: sub.teamNumber,
                     e: sub.eventKey, i, n, d: "" });

  // Calculate available space for data in each chunk
  const headerLen = headerTemplate(99, 99).length; // worst-case header size
  const dataPerChunk = MAX_CHUNK_CHARS - headerLen - 4; // 4 bytes margin

  // Split dataStr into segments
  const segments: string[] = [];
  for (let pos = 0; pos < dataStr.length; pos += dataPerChunk) {
    segments.push(dataStr.slice(pos, pos + dataPerChunk));
  }
  if (segments.length === 0) segments.push("");

  return segments.map((seg, i) => ({
    index: i,
    total: segments.length,
    payload: JSON.stringify({
      v: 1,
      id: sub.id,
      m: sub.matchNumber,
      t: sub.teamNumber,
      e: sub.eventKey,
      i,
      n: segments.length,
      d: seg,
    }),
  }));
}
