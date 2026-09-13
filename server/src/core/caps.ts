import { and, eq } from "drizzle-orm";
import type { DbClient } from "./db.js";
import { roleModules } from "../schema.js";
import { ROLE_CAPABILITIES, fullCapabilities } from "./role-caps.js";

// A logged-in user as produced by the auth layer: snake_case DB row shape.
export interface LoggedInUser {
  id: number;
  is_admin?: boolean | number;
  is_kiosk?: boolean | number;
  role_id?: number | null;
}

function safeCaps(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Resolved capabilities for a member's role (admin/no-role = everything).
// Portable twin of db.js#memberCapabilities, reading through the injected
// DbClient so the same logic runs against better-sqlite3 and D1.
export async function memberCapabilities(
  db: DbClient,
  user: LoggedInUser | null | undefined
): Promise<Record<string, Record<string, boolean>>> {
  if (!user || user.is_admin) return fullCapabilities();
  const caps = fullCapabilities();
  if (!user.role_id) return caps;
  for (const [module, keys] of Object.entries(ROLE_CAPABILITIES)) {
    const grant = await db
      .select()
      .from(roleModules)
      .where(and(eq(roleModules.roleId, user.role_id), eq(roleModules.name, module)))
      .get();
    if (!grant) {
      caps[module] = Object.fromEntries(keys.map((k) => [k, false]));
      continue;
    }
    const granted = safeCaps(grant.caps);
    caps[module] = Object.fromEntries(keys.map((k) => [k, granted[k] === true]));
  }
  return caps;
}

// True if `user` can perform `cap` inside `module`. Admins (and the wall
// display) are always allowed.
export async function hasCap(
  db: DbClient,
  user: LoggedInUser | null | undefined,
  module: string,
  cap: string
): Promise<boolean> {
  if (!user) return false;
  if (user.is_admin || user.is_kiosk) return true;
  const caps = await memberCapabilities(db, user);
  return !!(caps[module]?.[cap]);
}

// A user may assign a task to `assigneeId` only if it's themselves (needs
// assign_self) or someone else (needs assign_others).
export async function canAssign(
  db: DbClient,
  user: LoggedInUser | null | undefined,
  assigneeId: number
): Promise<boolean> {
  if (user && (user.is_admin || user.is_kiosk)) return true;
  if (user && assigneeId === undefined) return true;
  const cap = user && assigneeId === user.id ? "assign_self" : "assign_others";
  return hasCap(db, user, "tasks", cap);
}