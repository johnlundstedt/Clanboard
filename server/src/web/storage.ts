import type { StorageAdapter } from "../core/storage.js";

// Storage instance bound by the server entry at boot (fs adapter on the Node
// container today, the R2 adapter on the Workers entry later). Adapters read
// it through `storage()` so the file layer is swappable without plumbing.
let current: StorageAdapter | null = null;

export function initStorage(storage: StorageAdapter): void {
  current = storage;
}

export function storage(): StorageAdapter {
  if (!current) throw new Error("storage not initialized");
  return current;
}