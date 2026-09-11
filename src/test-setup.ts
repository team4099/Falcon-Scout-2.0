// Restores `localStorage` / `sessionStorage` for the jsdom test environment.
//
// Node 26 ships its own experimental `globalThis.localStorage`, which is
// `undefined` unless the process was started with `--localstorage-file`.
// Vitest's jsdom environment only copies a jsdom global across when the key is
// not already present on `globalThis`, so Node's stub wins and jsdom's real
// Storage never lands. Every `localStorage.*` call in the client code then
// throws "Cannot read properties of undefined".
//
// Installing jsdom's own Storage (rather than a hand-rolled stub) keeps the
// behaviour the cache code depends on — notably `Object.keys(localStorage)`
// enumerating stored keys, which `clearAllCache` in persistentCache.ts uses.

import { JSDOM } from "jsdom";

const { window: storageWindow } = new JSDOM("", { url: "http://localhost:3000/" });

for (const name of ["localStorage", "sessionStorage"] as const) {
  const storage = storageWindow[name];
  if (!storage) continue;
  if ((globalThis as Record<string, unknown>)[name] != null) continue;

  Object.defineProperty(globalThis, name, {
    value: storage,
    configurable: true,
    writable: true,
  });
}
