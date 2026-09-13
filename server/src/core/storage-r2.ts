import type { R2Bucket } from "@cloudflare/workers-types";
import { contentTypeForKey, type StorageAdapter } from "./storage.js";

// Cloudflare Workers storage backend: an R2 bucket binding. Runs against the
// real binding on the worker and Miniflare's implementation in tests.

export function createR2Storage(bucket: R2Bucket): StorageAdapter {
  return {
    async put(key, bytes, contentType) {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      const arrayBuffer = await obj.arrayBuffer();
      return {
        bytes: new Uint8Array(arrayBuffer),
        contentType: obj.httpMetadata?.contentType || contentTypeForKey(key),
      };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}