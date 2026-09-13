// `npm run db:migrate:sqlite` — apply the portable drizzle migration SQL to the
// container's on-disk sqlite file. This is a thin CLI over the SAME portable
// core the test helper and the future D1 entry use, so the container can never
// drift from the suite or production.
//
//   npm run db:migrate:sqlite            # DATA_DIR/clanboard.db
//   DATA_DIR=/tmp/x npm run db:migrate:sqlite
//
// Exits 0 on success (including "nothing pending"), 1 on any failure.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationStatements, type MigratableDatabase } from "../core/migrations.js";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });
const dbPath = join(DATA_DIR, "clanboard.db");

async function main(): Promise<never> {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    const applied = await applyMigrationStatements(db, "drizzle", {
      idempotent: true, // container db.js pre-provisions core tables at boot
    });
    console.log(
      `[db:migrate:sqlite] applied ${applied}${applied ? "" : " (nothing pending)"} -> ${dbPath}`
    );
    process.exit(0);
  } catch (err) {
    console.error(`[db:migrate:sqlite] failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
