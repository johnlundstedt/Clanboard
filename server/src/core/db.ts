import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { modules, settings } from "../schema.js";

// One async-style Drizzle interface that works on both the container backend
// (better-sqlite3, sync) and the Cloudflare backend (D1, async). Awaiting a
// synchronous value is a no-op, so every core function is `async` and reads the
// same on both targets.
export type DbClient = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, never>>;

export async function isModuleEnabled(db: DbClient, name: string): Promise<boolean> {
  const row = await db.select({ enabled: modules.enabled }).from(modules).where(eq(modules.name, name)).get();
  // default enabled if not yet registered in the table
  return row ? !!row.enabled : true;
}

export async function ensureModuleRow(db: DbClient, name: string): Promise<void> {
  await db.insert(modules).values({ name, enabled: true }).onConflictDoNothing().run();
}

export async function getSetting(db: DbClient, key: string): Promise<string | null> {
  const row = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

export async function setSetting(db: DbClient, key: string, value: string | null): Promise<void> {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}