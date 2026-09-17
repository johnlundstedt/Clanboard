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

// Extract table + column from a drizzle-generated `ALTER TABLE ... ADD`
// statement so re-runs can skip columns that already exist.
export function parseAlterAdd(sql: string): { table: string; column: string } | null {
  const m = /^ALTER TABLE\s+[`"]?([A-Za-z0-9_]+)[`"]?\s+ADD(?:\s+COLUMN)?\s+[`"]?([A-Za-z0-9_]+)[`"]?/i.exec(
    sql.trim()
  );
  if (!m) return null;
  return { table: m[1], column: m[2] };
}

// Portable column-existence check (PRAGMA table_info works on SQLite, D1, and
// better-sqlite3; .all() is available on every adapter shape). Normalizes the
// two all() shapes: an array (better-sqlite3, worker d1Raw) or a D1 response
// with a .results array (raw D1 / test harness).
export async function tableHasColumn(
  db: MigratableDatabase,
  table: string,
  column: string
): Promise<boolean> {
  const stmt = db.prepare(`PRAGMA table_info("${table}")`) as {
    all(): unknown | Promise<unknown>;
  };
  const res = await stmt.all();
  const rows = (Array.isArray(res)
    ? res
    : (res as { results?: Array<{ name?: string }> }).results ?? []) as Array<{
    name?: string;
  }>;
  return rows.some((r) => r.name === column);
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
//                and skip ALTER TABLE ... ADD COLUMN statements whose column
//                already exists, so re-running against a provisioned DB is a
//                no-op rather than an error.
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
    if (opts.idempotent) {
      const add = parseAlterAdd(raw);
      if (add && (await tableHasColumn(db, add.table, add.column))) {
        continue;
      }
    }
    const sql = opts.idempotent ? idempotentize(raw) : raw;
    await runStatement(db, sql);
    count += 1;
  }
  return count;
}

// Execute a single DDL statement. Prefers prepare().run(), which handles
// multi-line statements on every backend (D1/Miniflare's exec() rejects SQL
// spanning newlines). Falls back to exec() for adapters that only expose it.
async function runStatement(db: MigratableDatabase, sql: string): Promise<void> {
  const prepared = db.prepare(sql) as { run?: () => unknown } | null;
  if (prepared && typeof prepared.run === "function") {
    await prepared.run();
    return;
  }
  let execSql = sql;
  if (!/;\s*$/.test(execSql)) execSql += ";";
  await db.exec(execSql);
}