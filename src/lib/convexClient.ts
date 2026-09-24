// Single ConvexReactClient shared by the React provider and by non-React
// modules (src/lib/api.ts calls the TBA proxy action through it).
import { ConvexReactClient } from "convex/react";

export const convex = new ConvexReactClient(
  (import.meta.env.VITE_CONVEX_URL ?? "https://unset.invalid") as string,
);
