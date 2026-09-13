import type { DbClient } from "../core/db.js";

// Portable db holder — a live-binding seam. The container entry (better-sqlite3
// drizzle) and the Worker entry (D1 drizzle) each build THEIR OWN drizzle and
// call initContainerDb(db) at boot, before any module mounts. Modules read the
// live `containerDb` binding inside handlers (always after boot), so the Worker
// graph never imports better-sqlite3 and the container never touches D1. The
// D1-suite threads its drizzle through the same seam and stays green on both
// targets. No Node singleton anywhere.
export let containerDb: DbClient = null as unknown as DbClient;

export function initContainerDb(db: DbClient): void {
  containerDb = db;
}

export function getContainerDb(): DbClient {
  if (!containerDb) throw new Error("container db not initialized — call initContainerDb(db) at boot");
  return containerDb;
}
