// Portable, dependency-free migration runner — the single source of truth for
// "apply the drizzle-generated SQL to a backend". Same code drives the
// container's better-sqlite3 file (`npm run db:migrate:sqlite`), the test
// harness's :memory: sqlite, and Cloudflare's D1 via the Workers entry — so the
// container, the suite, and production can never drift on schema.
//
// drizzle-kit marks statement boundaries with "--> statement-breakpoint",
// which is a wrangler delimiter rather than valid SQL. Strip it, then split
// into individual statements so they can be applied one at a time. D1's
// multi-statement `exec()` chokes on compound/multi-line DDL, and each backend
// runs a single statement at a time instead.
//
// Workers has no fs, so the worker embeds the generated SQL (see
// src/db/d1-schema.ts, produced by scripts/gen-d1-schema.ts) and applies the
// same statement list through `applyMigrationStatements`.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface MigratableDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): unknown;
  // better-sqlite3's close() chains (returns the Database), D1's is async and
  // returns void; the runner never reads the result, so the portable shape
  // just accepts whichever the backend yields.
  close?(): unknown;
}

// Split the joined drizzle SQL text into individual statements.
export function migrationStatementsFromText(raw: string): string[] {
  return raw
    .replace(/--> statement-breakpoint/g, "")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .map((s) => s.replace(/;\s*$/, ""))
    .filter(Boolean);
}

// Rewrite bare CREATE TABLE / INDEX to their guarded forms so a statement list
// can be applied to an already-provisioned database (the container bootstraps
// core tables, D1 persists across worker cold starts).
export function idempotentize(sql: string): string {
  return sql
    .replace(/^CREATE TABLE\s+([`"])/i, "CREATE TABLE IF NOT EXISTS $1")
    .replace(/^CREATE UNIQUE INDEX\s+([`"])/i, "CREATE UNIQUE INDEX IF NOT EXISTS $1")
    .replace(/^CREATE INDEX\s+([`"])/i, "CREATE INDEX IF NOT EXISTS $1");
}

// Read + parse the migration SQL directory into a statement list (Node only;
// the Worker uses the embedded D1_SCHEMA text instead).
export async function migrationStatements(dir = "drizzle"): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error(`No migration SQL found in ${dir}`);
  const parts = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
  return migrationStatementsFromText(parts.join("\n"));
}

// Apply a parsed statement list (or the SQL directory, Node-only) to a
// portable database. Options:
//   idempotent — rewrite bare CREATE TABLE/INDEX to the IF NOT EXISTS form
//                before executing, so re-running against a provisioned DB is
//                a no-op rather than an error.
export async function applyMigrationStatements(
  db: MigratableDatabase,
  input: string | string[] = "drizzle",
  opts: { idempotent?: boolean } = {}
): Promise<number> {
  // The container's db.js provisions core tables via CREATE TABLE IF NOT
  // EXISTS at boot, so any other backend may already be bootstrapped; the
  // guarded rewrite makes one SQL set safe everywhere.
  const statements = Array.isArray(input) ? input : await migrationStatements(input);
  let count = 0;
  for (const raw of statements) {
    const sql = opts.idempotent ? idempotentize(raw) : raw;
    await db.exec(sql);
    count += 1;
  }
  return count;
}