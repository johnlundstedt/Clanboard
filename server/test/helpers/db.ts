import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { migrationStatements as coreMigrationStatements } from "../../src/core/migrations.js";
import Database from "better-sqlite3";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { drizzle as drizzleFromSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleFromD1, type DrizzleD1Database } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";

// Dual-backend test harness: the SAME generated migration SQL and the SAME
// Drizzle query code run against better-sqlite3 (:memory:) and Miniflare D1.
// Any behavioural divergence between container (SQLite) and Cloudflare (D1)
// surfaces here instead of production.

// better-sqlite3 prepares are sync, D1 prepares are async; both are exposed
// through the loose structural shapes below so tests can treat them uniformly.
export interface MigratableDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): unknown;
  close?(): Promise<void> | void;
}

// better-sqlite3 prepares are sync, D1 prepares are async; both are exposed
// through the loose structural shapes below so tests can treat them uniformly.

export interface TestDatabase {
  name: "sqlite" | "d1";
  db: BetterSQLite3Database & DrizzleD1Database;
  raw: MigratableDatabase;
  /** Run a raw SELECT and return plain rows (shape-normalized across backends). */
  queryAll(sql: string): Promise<Record<string, unknown>[]>;
  /** Truncate every table so each test starts clean. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export const ALL_TABLES = [
  "users",
  "member_roles",
  "role_modules",
  "modules",
  "settings",
  "user_modules",
  "sessions",
  "task_categories",
  "task_priorities",
  "tasks",
  "task_assignees",
  "lists",
  "list_items",
  "meal_plan",
  "calendar_connections",
  "calendar_cache",
];

// ---------------------------------------------------------------------------
// SQLite (container)
// ---------------------------------------------------------------------------

export async function makeSqliteDatabase(): Promise<TestDatabase> {
  const raw = new Database(":memory:");
  for (const stmt of await coreMigrationStatements()) raw.exec(stmt);
  const sqlite = drizzleFromSqlite(raw);
  const selectAll = (q: string): Record<string, unknown>[] =>
    (raw.prepare(q) as { all(): unknown[] }).all() as Record<string, unknown>[];

  const reset = async () => {
    const disableFk = "PRAGMA foreign_keys = OFF";
    const enableFk = "PRAGMA foreign_keys = ON";
    raw.exec(disableFk);
    for (const table of ALL_TABLES) raw.exec(`DELETE FROM ${table}`);
    raw.exec(enableFk);
  };

  return {
    name: "sqlite",
    db: sqlite as unknown as TestDatabase["db"],
    raw: raw as unknown as MigratableDatabase,
    queryAll: (q) => Promise.resolve(selectAll(q)),
    reset,
    close: async () => {
      raw.close();
    },
  };
}

// ---------------------------------------------------------------------------
// D1 (Cloudflare Workers)
// ---------------------------------------------------------------------------

let miniflare: Miniflare | null = null;
let d1Binding: D1Database | null = null;
let r2Binding: R2Bucket | null = null;
let d1Migrated = false;

async function ensureMiniflare(): Promise<D1Database> {
  if (d1Binding) return d1Binding;
  miniflare = new Miniflare({
    modules: true,
    script: `export default { fetch() { return new Response("ok"); } }`,
    d1Databases: ["CLANBOARD"],
    r2Buckets: ["UPLOADS"],
  });
  d1Binding = await miniflare.getD1Database("CLANBOARD");
  r2Binding = (await miniflare.getR2Bucket("UPLOADS")) as unknown as R2Bucket;
  d1Migrated = false;
  return d1Binding;
}

export async function getTestR2(): Promise<R2Bucket> {
  await ensureMiniflare();
  return r2Binding!;
}

export async function makeD1Database(): Promise<TestDatabase> {
  const raw = await ensureMiniflare();
  const d1Sql = {
    exec: (s: string) => raw.exec(s),
    prepare: (q: string) =>
      ({
        run: () => raw.prepare(q).run(),
        all: () => raw.prepare(q).all(),
      }) as unknown,
  } as unknown as MigratableDatabase;
  if (!d1Migrated) {
    for (const stmt of await coreMigrationStatements()) {
      await (d1Sql.prepare(stmt) as { run(): Promise<unknown> }).run();
    }
    d1Migrated = true;
  }
  const d1 = drizzleFromD1(raw);

  const reset = async () => {
    for (const table of ALL_TABLES) {
      await (d1Sql.prepare(`DELETE FROM "${table}"`) as { run(): Promise<unknown> }).run();
    }
  };

  return {
    name: "d1",
    db: d1 as unknown as TestDatabase["db"],
    raw: d1Sql,
    queryAll: async (q) =>
      (await (d1Sql.prepare(q) as { all(): Promise<{ results: unknown }> }).all())
        .results as unknown as Record<string, unknown>[],
    reset,
    close: async () => {},
  };
}

export async function closeD1() {
  await miniflare?.dispose();
  miniflare = null;
  d1Binding = null;
  r2Binding = null;
}