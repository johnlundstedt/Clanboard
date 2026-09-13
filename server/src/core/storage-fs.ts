import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentTypeForKey, type StorageAdapter } from "./storage.js";

// Node-container storage backend: a directory on disk under the uploads root.
// Keys are treated as untrusted (they can come from /uploads/* URLs), so path
// separators and traversal segments are stripped before touching the fs.

function safeKey(root: string, key: string): string {
  const clean = key.replace(/[\\/]/g, "_").replace(/\.\./g, "_");
  return join(root, clean);
}

export function createFsStorage(root: string): StorageAdapter {
  mkdirSync(root, { recursive: true });
  return {
    async put(key, bytes) {
      writeFileSync(safeKey(root, key), bytes);
    },
    async get(key) {
      const file = safeKey(root, key);
      if (!existsSync(file)) return null;
      const data = readFileSync(file);
      return { bytes: new Uint8Array(data), contentType: contentTypeForKey(key) };
    },
    async delete(key) {
      rmSync(safeKey(root, key), { force: true });
    },
  };
}