import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { DbClient } from "./db.js";
import { getSetting } from "./db.js";
import { modules, roleModules, users } from "../schema.js";
import { badRequest, unauthorized } from "./errors.js";
import { HttpError } from "./errors.js";
import { memberCapabilities, type LoggedInUser } from "./caps.js";
import { memberModuleOverrides } from "./members.js";

const SALT_ROUNDS = 10;

// Password attempt limit for login-managed accounts before they lock.
export const MAX_FAILED_ATTEMPTS = 3;

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
  email?: string | null;
  login_enabled?: boolean | number;
  failed_attempts?: number;
  locked?: boolean | number;
  must_change_password?: boolean | number;
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
  email: string | null;
  login_enabled: boolean;
  failed_attempts: number;
  locked: boolean;
  must_change_password: boolean;
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
    email: u.email ?? null,
    login_enabled: !!u.login_enabled,
    failed_attempts: u.failed_attempts ?? 0,
    locked: !!u.locked,
    must_change_password: !!u.must_change_password,
  };
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string | null): boolean {
  if (!hash) return false;
  return bcrypt.compareSync(password, hash);
}

// Character pools (visually unambiguous) for generated temporary passwords. A
// temp password must satisfy the same policy as a user-chosen one so the
// forced-change screen never hits its own validation.
const PASSWORD_POOLS = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnopqrstuvwxyz",
  digit: "23456789",
  symbol: "!@#$%^&*-_=+?",
};

export function generateTemporaryPassword(length = 12): string {
  const union = (Object.keys(PASSWORD_POOLS) as Array<keyof typeof PASSWORD_POOLS>)
    .map((k) => PASSWORD_POOLS[k])
    .join("");
  const bytes = new Uint8Array(length + 8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => union[b % union.length]);
  // Guarantee one of each class so the password is policy-compliant.
  for (let i = 0; i < Object.keys(PASSWORD_POOLS).length; i += 1) {
    chars[i] = PASSWORD_POOLS[Object.keys(PASSWORD_POOLS)[i] as keyof typeof PASSWORD_POOLS][
      bytes[length + i] % PASSWORD_POOLS[Object.keys(PASSWORD_POOLS)[i] as keyof typeof PASSWORD_POOLS].length
    ];
  }
  return chars.join("");
}

// Enforce the member password policy: at least 8 chars with upper, lower, and
// a symbol. Returns null when valid, otherwise a human-readable message.
export function validateNewPassword(pw: string | undefined): string | null {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(pw)) return "Password must include an uppercase letter";
  if (!/[a-z]/.test(pw)) return "Password must include a lowercase letter";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password must include a symbol";
  return null;
}

// Set a user's password from a plaintext value, controlling whether the next
// sign-in forces a change. Also clears lockout state (identity-confirmed
// recovery, or acting from the admin panel).
export async function resetPassword(
  db: DbClient,
  userId: number,
  password: string,
  mustChange = true
): Promise<void> {
  await db
    .update(users)
    .set({
      passwordHash: hashPassword(password),
      mustChangePassword: mustChange,
      failedAttempts: 0,
      locked: false,
    })
    .where(eq(users.id, userId))
    .run();
}

// Locate a login-managed account by exact name + email (both trimmed, email
// compared case-insensitively). Used by forgot-password; returns null for
// admin/system/kiosk accounts or unknown combos.
export async function findLoginUser(
  db: DbClient,
  name: string,
  emailAddress: string
): Promise<{ id: number; email: string } | null> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.name, name.trim()))
    .get();
  if (!user || !user.email) return null;
  const managed = !!user.loginEnabled && !user.isAdmin && !user.isKiosk && !user.systemAccount;
  if (!managed) return null;
  if (user.email.toLowerCase() !== emailAddress.trim().toLowerCase()) return null;
  return { id: user.id, email: user.email };
}

// Find a user by exact name and check the password. Throws 401 on any failure
// so route handlers don't leak which part was wrong (same as the old handler).
// Login-managed accounts (email login enabled, and not an admin/system/kiosk
// account) accumulate failed attempts and lock at MAX_FAILED_ATTEMPTS. A
// locked account throws 423, distinct from bad credentials.
export async function verifyCredentials(
  db: DbClient,
  name: string | undefined,
  password: string | undefined
): Promise<AuthUserRow> {
  if (!name || !password) throw badRequest("name and password are required");
  const user = await db.select().from(users).where(eq(users.name, name.trim())).get();
  if (!user) throw unauthorized("Invalid credentials");

  const managed =
    !!user.loginEnabled && !user.isAdmin && !user.isKiosk && !user.systemAccount;
  const valid = !!user.passwordHash && verifyPassword(password, user.passwordHash);

  if (managed && user.locked) {
    throw new HttpError(423, "Account is locked. Ask a parent to unlock it.");
  }
  if (!user.passwordHash || !valid) {
    if (managed) {
      const attempts = (user.failedAttempts ?? 0) + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        await db
          .update(users)
          .set({ failedAttempts: 0, locked: true })
          .where(eq(users.id, user.id))
          .run();
        throw new HttpError(
          423,
          "Too many failed attempts — account locked. Ask a parent to unlock it."
        );
      }
      await db
        .update(users)
        .set({ failedAttempts: attempts })
        .where(eq(users.id, user.id))
        .run();
    }
    throw unauthorized("Invalid credentials");
  }

  if (managed) {
    await db
      .update(users)
      .set({ failedAttempts: 0 })
      .where(eq(users.id, user.id))
      .run();
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
    email: user.email,
    login_enabled: user.loginEnabled,
    failed_attempts: user.failedAttempts,
    locked: user.locked,
    must_change_password: user.mustChangePassword,
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