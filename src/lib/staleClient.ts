/**
 * Detects the "this device is older than the backend" crash.
 *
 * Convex deploys before Vercel does, and a PWA keeps serving its precached
 * bundle until a new service worker installs — so after any deploy that removes
 * or renames a backend function there is a window where a cached client calls
 * something the server no longer has. Convex answers "Could not find public
 * function", which throws during render and takes the whole route down.
 *
 * Lives in its own module rather than next to RouteErrorBoundary so that
 * component file only exports a component (react-refresh/only-export-components).
 */

/** Convex's wording when the client asks for a function the backend doesn't have. */
const STALE_CLIENT = /could not find public function|could not find function/i;

export function isStaleClientError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              // Circular or otherwise unserialisable — not something we can match.
              return "";
            }
          })();
  return STALE_CLIENT.test(msg);
}
