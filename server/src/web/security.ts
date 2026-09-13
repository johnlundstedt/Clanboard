import type { Security } from "./helpers.js";

// Singleton security instance bound by the server entry at boot (Node today,
// Workers entry later). Adapters read it through `security()` so they don't
// have to thread the session secret / database around individually.
let current: Security | null = null;

export function initSecurity(sec: Security): void {
  current = sec;
}

export function security(): Security {
  if (!current) throw new Error("security not initialized");
  return current;
}

// Hono middleware forwarding to the bound security instance. Adapters register
// this at import time (before initSecurity runs), so the lookup happens lazily
// at request time.
export function requireAdmin(...args: Parameters<Security["requireAdmin"]>): ReturnType<Security["requireAdmin"]> {
  return security().requireAdmin(...args);
}