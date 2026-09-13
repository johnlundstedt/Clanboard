import { and, eq } from "drizzle-orm";
import type { DbClient } from "./db.js";
import { membersRoles, roleModules, userModules } from "../schema.js";

// Per-member module override helpers and role grant readers, portable over
// better-sqlite3 and D1. These are the DbClient twins of the raw db.js
// functions the admin + auth modules used to share.

function safeCaps(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Explicit per-member overrides: [{ name, enabled }]
export async function memberModuleOverrides(db: DbClient, userId: number) {
  const rows = await db.select().from(userModules).where(eq(userModules.userId, userId)).all();
  return rows.map((r) => ({ name: r.name, enabled: !!r.enabled }));
}

// Set a per-member module override. enabled=true/false writes an override row;
// enabled=null deletes it (back to inheriting the role or global state).
export async function setMemberModule(db: DbClient, userId: number, moduleName: string, enabled: unknown) {
  if (enabled == null) {
    await db
      .delete(userModules)
      .where(and(eq(userModules.userId, userId), eq(userModules.name, moduleName)))
      .run();
  } else {
    await db
      .insert(userModules)
      .values({ userId, name: moduleName, enabled: Boolean(enabled) })
      .onConflictDoUpdate({
        target: [userModules.userId, userModules.name],
        set: { enabled: Boolean(enabled) },
      })
      .run();
  }
}

export interface RoleWire {
  id: number;
  name: string;
  modules: { name: string; enabled: boolean; caps: Record<string, unknown> }[];
}

export async function getRole(db: DbClient, id: number): Promise<RoleWire | null> {
  const row = await db.select().from(membersRoles).where(eq(membersRoles.id, id)).get();
  if (!row) return null;
  return { id: row.id, name: row.name, modules: [] };
}

// Module grants for a role: [{ name, enabled, caps }]
export async function listRoleGrants(db: DbClient, roleId: number) {
  const rows = await db
    .select()
    .from(roleModules)
    .where(eq(roleModules.roleId, roleId))
    .orderBy(roleModules.name)
    .all();
  return rows.map((r) => ({
    name: r.name,
    enabled: !!r.enabled,
    caps: safeCaps(r.caps),
  }));
}

// A role with its module grants attached (the admin UI's role shape).
export async function roleWithGrants(db: DbClient, row: RoleWire | null): Promise<RoleWire | null> {
  if (!row) return null;
  return { id: row.id, name: row.name, modules: await listRoleGrants(db, row.id) };
}