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
