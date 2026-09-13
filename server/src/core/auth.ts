import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { DbClient } from "./db.js";
import { getSetting } from "./db.js";
import { modules, roleModules, users } from "../schema.js";
import { badRequest, unauthorized } from "./errors.js";
import { memberCapabilities, type LoggedInUser } from "./caps.js";
import { memberModuleOverrides } from "./members.js";

const SALT_ROUNDS = 10;

// A full users row as the adapter/session layer hands back (snake_case keys).
export interface AuthUserRow {
  id: number;
  name: string;
  photo_url?: string | null;
  birthday?: string | null;
  gender?: string | null;
  role_id?: number | null;
  nav_scope?: string;
  is_admin?: boolean | number;
  is_kiosk?: boolean | number;
  system_account?: boolean | number;
  password_hash?: string | null;
}

export interface PublicUser {
  id: number;
  name: string;
  photo_url: string | null;
  birthday: string | null;
  gender: string | null;
  role_id: number | null;
  nav_scope: string;
  is_admin: boolean;
  is_kiosk: boolean;
  system_account: boolean;
}

// Public, navigable view of a user (no password_hash, no created_at).
export function publicUser(u: AuthUserRow | null | undefined): PublicUser | null {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    photo_url: u.photo_url ?? null,
    birthday: u.birthday ?? null,
    gender: u.gender ?? null,
    role_id: u.role_id ?? null,
    nav_scope: u.nav_scope ?? "all",
    is_admin: !!u.is_admin,
    is_kiosk: !!u.is_kiosk,
    system_account: !!u.system_account,
  };
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string | null): boolean {
  if (!hash) return false;
  return bcrypt.compareSync(password, hash);
}

// Find a user by exact name and check the password. Throws 401 on any failure
// so route handlers don't leak which part was wrong (same as the old handler).
export async function verifyCredentials(
  db: DbClient,
  name: string | undefined,
  password: string | undefined
): Promise<AuthUserRow> {
  if (!name || !password) throw badRequest("name and password are required");
  const user = await db.select().from(users).where(eq(users.name, name.trim())).get();
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw unauthorized("Invalid credentials");
  }
  return {
    id: user.id,
    name: user.name,
    photo_url: user.photoUrl,
    birthday: user.birthday,
    gender: user.gender,
    role_id: user.roleId,
    nav_scope: user.navScope,
    is_admin: user.isAdmin,
    is_kiosk: user.isKiosk,
    system_account: user.systemAccount,
    password_hash: user.passwordHash,
  };
}

// Resolved module names a member can access. Precedence matches db.js exactly:
// global disabled always wins; dashboard locked on; admin only for admins;
// per-member override beats the role's grants, which beat global enabled; a
// member without a role inherits the global gate.
export async function memberEnabledModules(
  db: DbClient,
  user: Pick<AuthUserRow, "id" | "is_admin" | "role_id">
): Promise<string[]> {
  const all = await db.select().from(modules).all();
  const overrides = new Map((await memberModuleOverrides(db, user.id)).map((o) => [o.name, o.enabled]));
  const isAdmin = !!user.is_admin;

  const enabled: string[] = [];
  for (const m of all) {
    if (!m.enabled) continue; // global gate always applies
    if (m.name === "dashboard") {
      enabled.push(m.name);
      continue; // locked landing view
    }
    if (m.name === "admin") {
      if (isAdmin) enabled.push(m.name);
      continue;
    }
    if (overrides.has(m.name)) {
      if (overrides.get(m.name)) enabled.push(m.name);
      continue;
    }
    if (user.role_id) {
      const grant = await db
        .select({ enabled: roleModules.enabled })
        .from(roleModules)
        .where(and(eq(roleModules.roleId, user.role_id), eq(roleModules.name, m.name)))
        .get();
      if (grant?.enabled) enabled.push(m.name);
      continue;
    }
    enabled.push(m.name); // no role: inherit the global gate
  }
  return enabled;
}

export interface MePayload extends PublicUser {
  family_name: string;
  enabled_modules: string[];
  caps: Record<string, Record<string, boolean>>;
}

// The /me payload: public user plus household context.
export async function getMePayload(db: DbClient, user: AuthUserRow): Promise<MePayload> {
  const [enabled_modules, caps] = await Promise.all([
    memberEnabledModules(db, user),
    memberCapabilities(db, user as unknown as LoggedInUser),
  ]);
  return {
    ...(publicUser(user) as PublicUser),
    family_name: (await getSetting(db, "family_name")) || "Clanboard",
    enabled_modules,
    caps,
  };
}