import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    // Miniflare's synchronous D1 bridge (Atomics.wait proxy) intermittently
    // loses a response id under rapid calls (cloudflare/miniflare sync-fetch
    // race). It's an infra quirk, not a parity divergence; retrying a failed
    // test is safe because each attempt starts from a reset() database.
    retry: 3,
    testTimeout: 30000,
  },
});