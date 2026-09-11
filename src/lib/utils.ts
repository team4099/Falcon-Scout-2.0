import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── Match identity ────────────────────────────────────────────────────────────
//
// A match number alone is ambiguous: qualification 5 and elimination 5 are
// different matches. Anything that groups, sorts or charts submissions must key
// on the comp level too, or the two collapse into one and their values average
// together.

export type CompLevel = "qm" | "elim";

/** Stable grouping key for a submission — "qm-12", "elim-3". */
export function matchKey(
  matchNumber: number,
  compLevel?: CompLevel | null,
): string {
  return `${compLevel ?? "qm"}-${matchNumber}`;
}

/** Human label — "Q12", "E3". Older rows with no comp level render as "12". */
export function matchLabel(
  matchNumber: number,
  compLevel?: CompLevel | null,
): string {
  if (compLevel === "elim") return `E${matchNumber}`;
  if (compLevel === "qm") return `Q${matchNumber}`;
  return String(matchNumber);
}

/** Sort order: quals first by number, then elims by number. */
export function matchSortValue(
  matchNumber: number,
  compLevel?: CompLevel | null,
): number {
  return (compLevel === "elim" ? 100_000 : 0) + matchNumber;
}

// ── Display text ──────────────────────────────────────────────────────────────

/**
 * Strip the circle/arrow emojis baked into older betting-market records, so
 * titles and option labels render as plain text.
 *
 * The character class holds code points ONLY. It previously ended with the
 * literal letters `UPDOWN` — intended as a note about the arrow glyphs, but a
 * character class treats them as six more characters to match. Every capital
 * U, P, D, O, W and N in any market title, option label or description was
 * therefore deleted: "⬆ Over 5 pts" rendered as "ver 5 pts", and
 * "Statbotics EPA predicts…" as "Statbotics EA predicts…".
 */
export function stripEmojis(text: string): string {
  return text
    .replace(
      /[\u{1F534}\u{1F535}\u{2B06}\u{2B07}\u{26AA}\u{2B55}\u{1F7E0}\u{1F7E1}\u{1F7E2}\u{1F7E3}\u{1F7E4}\u{2764}\u{1F499}]/gu,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}
