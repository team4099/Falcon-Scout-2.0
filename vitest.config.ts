import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    // Two environments: convex-test needs edge-runtime, the client-side
    // libraries are plain modules that run fine in node.
    projects: [
      {
        resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["convex/**/*.test.ts"],
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
        test: {
          name: "client",
          // jsdom, not node: these modules use localStorage, and clearAllCache
          // enumerates it with Object.keys — which only works on the real thing.
          environment: "jsdom",
          include: ["src/**/*.test.ts"],
        },
      },
    ],
  },
});
