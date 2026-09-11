/**
 * Stale-client detection.
 *
 * This predicate decides whether a route crash silently self-heals (drop the
 * service worker, reload onto the current build) or just shows the scout an
 * error. Getting it wrong in either direction is bad: a false negative leaves a
 * scout stranded on a dead app at a competition, a false positive throws away
 * the code cache — and forces a network round trip — over an unrelated bug, on
 * a venue network that may have no uplink.
 *
 * The real message is the one Convex returned when the deployed backend had
 * dropped checklists:* but a device was still serving its precached bundle.
 */
import { describe, expect, test } from "vitest";
import { isStaleClientError } from "./staleClient";

const REAL_CONVEX_ERROR =
  "[CONVEX Q(checklists:listActiveChecklistTemplates)] [Request ID: b6b322de360ccafc] " +
  "Server Error Could not find public function for 'checklists:listActiveChecklistTemplates'. " +
  "Called by client";

describe("isStaleClientError", () => {
  test("matches the real Convex missing-function error", () => {
    expect(isStaleClientError(new Error(REAL_CONVEX_ERROR))).toBe(true);
  });

  test("matches it as a bare string and regardless of casing", () => {
    expect(isStaleClientError(REAL_CONVEX_ERROR)).toBe(true);
    expect(isStaleClientError(new Error("could not find PUBLIC FUNCTION for 'x:y'"))).toBe(true);
  });

  test("does not fire on unrelated failures", () => {
    // These must NOT discard the cache — offline is the normal state at a venue.
    expect(isStaleClientError(new Error("Failed to fetch"))).toBe(false);
    expect(isStaleClientError(new Error("NetworkError when attempting to fetch resource"))).toBe(false);
    expect(isStaleClientError(new Error("Not signed in"))).toBe(false);
    expect(
      isStaleClientError(new Error("Team 9999 is not registered at this event. Submission rejected.")),
    ).toBe(false);
    expect(isStaleClientError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });

  test("survives values that are neither Error nor string", () => {
    expect(isStaleClientError(null)).toBe(false);
    expect(isStaleClientError(undefined)).toBe(false);
    expect(isStaleClientError(404)).toBe(false);
    expect(isStaleClientError({ message: "Could not find public function for 'a:b'" })).toBe(true);
    // A circular object must not throw on the way through JSON.stringify.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => isStaleClientError(circular)).not.toThrow();
    expect(isStaleClientError(circular)).toBe(false);
  });
});
