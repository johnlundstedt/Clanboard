import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "./db.js";
import { getSetting, setSetting } from "./db.js";
import { membersRoles, modules, roleModules, taskAssignees, userModules, users } from "../schema.js";
import { badRequest, notFound } from "./errors.js";
import { publicUser, hashPassword, validateNewPassword, generateTemporaryPassword, resetPassword, type AuthUserRow } from "./auth.js";
import { emailConfigured, sendTemporaryPasswordEmail, sendWelcomeEmail } from "./email.js";
import { ROLE_CAPABILITIES } from "./role-caps.js";
import {
  getRole,
  roleWithGrants,
  setMemberModule,
  type RoleWire,
} from "./members.js";

export { getRole, roleWithGrants } from "./members.js";

// Modules a role can toggle + configure capabilities for (Home/Admin are locked).
const ROLE_MODULES = ["tasks", "lists", "meal-plan", "calendar"];

// Indexable view of the capability catalog keyed by module name.
const CAPS: Record<string, readonly string[]> = ROLE_CAPABILITIES as unknown as Record<string, readonly string[]>;

// Human labels for each capability (used by the admin UI checkboxes).
const CAP_LABELS: Record<string, Record<string, string>> = {
  tasks: {
    view_others: "View other's tasks",
    create: "Add new tasks",
    create_unassigned: "Add new unassigned tasks",
    assign_self: "Assign tasks to myself",
    assign_others: "Assign tasks to others",
    volunteer: "Volunteer for an unassigned task",
    reassign: "Reassign tasks to another user",
    edit: "Modify an existing task",
    delete: "Delete a task",
    update_deadline: "Update the deadline",
    complete_own: "Mark my own tasks complete",
    complete_others: "Mark other's tasks complete",
    review: "Review a task and confirm it's done",
  },
  "meal-plan": {
    edit: "Modify the meal plan",
  },
  lists: {
    create_lists: "Create a list",
    delete_lists: "Delete a list",
    add_items: "Add an item to a list",
    remove_items: "Remove an item from a list",
    complete_items: "Mark a list item as complete",
  },
};

// The catalog endpoint payload: per module, the (key, label) capability pairs.
export function roleCapabilities() {
  return {
    modules: ROLE_MODULES.map((name) => ({
      name,
      caps: (CAPS[name] || []).map((cap) => ({
        key: cap,
        label: CAP_LABELS[name]?.[cap] || cap,
      })),
    })),
  };
}

// Default capabilities per role for each module a role can grant. Keys are
// capability names from ROLE_CAPABILITIES; true grants, false denies. Modules
// not listed for a role stay off (the role matrix gates access entirely).
const DEFAULT_ROLES: Record<string, Record<string, Record<string, boolean>>> = {
  Parents: {
    tasks: { view_others: true, create: true, create_unassigned: true, assign_self: true, assign_others: true, volunteer: true, reassign: true, edit: true, delete: true, update_deadline: true, complete_own: true, complete_others: true, review: true },
    "meal-plan": { edit: true },
    lists: { create_lists: true, delete_lists: true, add_items: true, remove_items: true, complete_items: true },
    calendar: {},
  },
  "Older Kids": {
    tasks: { view_others: true, create: true, create_unassigned: true, assign_self: true, assign_others: false, volunteer: true, reassign: false, edit: true, delete: true, update_deadline: true, complete_own: true, complete_others: false, review: false },
    "meal-plan": { edit: false },
    lists: { create_lists: true, delete_lists: false, add_items: true, remove_items: false, complete_items: true },
    calendar: {},
  },
  "Younger Kids": {
    tasks: { view_others: false, create: false, create_unassigned: false, assign_self: true, assign_others: false, volunteer: true, reassign: false, edit: false, delete: false, update_deadline: false, complete_own: true, complete_others: false, review: false },
    "meal-plan": { edit: false },
    lists: { create_lists: false, delete_lists: false, add_items: true, remove_items: false, complete_items: true },
    calendar: {},
  },
  Kiosk: {
    tasks: { view_others: true, create: false, create_unassigned: false, assign_self: true, assign_others: false, volunteer: true, reassign: false, edit: false, delete: false, update_deadline: false, complete_own: true, complete_others: true, review: false },
    "meal-plan": { edit: false },
    lists: { create_lists: false, delete_lists: false, add_items: true, remove_items: false, complete_items: true },
    calendar: {},
  },
};

function defaultRoleModule(name: string) {
  const caps = CAPS[name] || [];
  return {
    name,
    enabled: true,
    caps: Object.fromEntries(caps.map((c) => [c, true])),
  };
}

// Seed the default family roles on a fresh database (called at migrate time).
export async function seedDefaultRoles(db: DbClient) {
  const count = await db.select({ n: sql`COUNT(*)` }).from(membersRoles).get();
  if (count?.n) return;

  for (const [roleName, roleCfg] of Object.entries(DEFAULT_ROLES)) {
    const inserted = await db
      .insert(membersRoles)
      .values({ name: roleName })
      .returning({ id: membersRoles.id })
      .get();
    for (const [moduleName, moduleCfg] of Object.entries(roleCfg)) {
      const caps = Object.fromEntries(
        (CAPS[moduleName] || []).map((c) => [c, moduleCfg[c] === true])
      );
      await db
        .insert(roleModules)
        .values({ roleId: inserted.id, name: moduleName, enabled: true, caps: JSON.stringify(caps) })
        .run();
    }
  }
}

interface ModuleBody {
  name?: string;
  enabled?: boolean;
  caps?: Record<string, boolean>;
}

function normalizeModules(modulesBody: unknown) {
  const list: ModuleBody[] = Array.isArray(modulesBody) ? (modulesBody as ModuleBody[]) : [];
  const byName = new Map(list.map((m) => [m.name, m]));
  return ROLE_MODULES.map((name) => {
    const m = byName.get(name);
    return {
      name,
      enabled: m ? !!m.enabled : true,
      caps: { ...(defaultRoleModule(name).caps), ...(m && m.caps ? m.caps : {}) },
    };
  });
}

// --- Household settings ------------------------------------------------------
export interface AdminSettings {
  family_name: string | null;
  latitude: string | null;
  longitude: string | null;
  weather_location: string | null;
  weather_units: string;
  tasks_enable_categories: boolean;
  tasks_enable_priorities: boolean;
  tasks_enable_dollar: boolean;
  lists_autodelete_enabled: boolean;
  lists_autodelete_minutes: number;
  email_configured: boolean;
  site_url: string | null;
}

export async function getAdminSettings(db: DbClient): Promise<AdminSettings> {
  return {
    family_name: await getSetting(db, "family_name"),
    latitude: await getSetting(db, "latitude"),
    longitude: await getSetting(db, "longitude"),
    weather_location: await getSetting(db, "weather_location"),
    weather_units: (await getSetting(db, "weather_units")) || "metric",
    tasks_enable_categories: (await getSetting(db, "tasks_enable_categories")) !== "0",
    tasks_enable_priorities: (await getSetting(db, "tasks_enable_priorities")) !== "0",
    tasks_enable_dollar: (await getSetting(db, "tasks_enable_dollar")) === "1",
    lists_autodelete_enabled: (await getSetting(db, "lists_autodelete_enabled")) === "1",
    lists_autodelete_minutes: Number(await getSetting(db, "lists_autodelete_minutes")) || 60,
    email_configured: await emailConfigured(db),
    site_url: await getSetting(db, "site_url"),
  };
}

function flagToStorage(value: unknown, current: string | null): string | null {
  if (value === undefined) return current;
  return value ? "1" : "0";
}

// Apply basic household settings. Empty lat/lon clears the value (null).
export async function updateAdminSettings(db: DbClient, body: Partial<AdminSettings> & Record<string, unknown>) {
  const { family_name, latitude, longitude, weather_location, weather_units, tasks_enable_categories, tasks_enable_priorities, tasks_enable_dollar, lists_autodelete_enabled, lists_autodelete_minutes, site_url } = body;
  if (family_name !== undefined) await setSetting(db, "family_name", String(family_name));
  if (latitude !== undefined) await setSetting(db, "latitude", latitude === "" || latitude == null ? null : String(latitude));
  if (longitude !== undefined) await setSetting(db, "longitude", longitude === "" || longitude == null ? null : String(longitude));
  if (weather_location !== undefined) await setSetting(db, "weather_location", String(weather_location));
  if (weather_units !== undefined) {
    const units = ["imperial", "metric", "both"].includes(String(weather_units)) ? String(weather_units) : "metric";
    await setSetting(db, "weather_units", units);
  }
  if (tasks_enable_categories !== undefined) {
    await setSetting(db, "tasks_enable_categories", flagToStorage(tasks_enable_categories, await getSetting(db, "tasks_enable_categories")));
  }
  if (tasks_enable_priorities !== undefined) {
    await setSetting(db, "tasks_enable_priorities", flagToStorage(tasks_enable_priorities, await getSetting(db, "tasks_enable_priorities")));
  }
  if (tasks_enable_dollar !== undefined) {
    await setSetting(db, "tasks_enable_dollar", flagToStorage(tasks_enable_dollar, await getSetting(db, "tasks_enable_dollar")));
  }
  if (lists_autodelete_enabled !== undefined) {
    await setSetting(db, "lists_autodelete_enabled", flagToStorage(lists_autodelete_enabled, await getSetting(db, "lists_autodelete_enabled")));
  }
  if (lists_autodelete_minutes !== undefined) {
    const minutes = Math.max(1, Math.floor(Number(lists_autodelete_minutes)));
    await setSetting(db, "lists_autodelete_minutes", Number.isFinite(minutes) ? String(minutes) : "60");
  }
  if (site_url !== undefined) {
    await setSetting(db, "site_url", site_url === "" || site_url == null ? null : String(site_url).trim());
  }
}

// --- Module toggles ----------------------------------------------------------
export async function setModuleEnabled(db: DbClient, name: string, enabled: unknown) {
  await db.update(modules).set({ enabled: Boolean(enabled) }).where(eq(modules.name, name)).run();
}

// --- Roles -------------------------------------------------------------------
export async function listRoles(db: DbClient) {
  const rows = await db.select().from(membersRoles).orderBy(membersRoles.id).all();
  const roles: RoleWire[] = [];
  for (const row of rows) {
    const r = await roleWithGrants(db, { id: row.id, name: row.name, modules: [] });
    if (r) roles.push(r);
  }
  return roles;
}

export async function createRole(db: DbClient, name: string | undefined, modulesBody: unknown) {
  if (!name || !name.trim()) throw badRequest("name is required");
  const clash = await db.select().from(membersRoles).where(sql`name = ${name.trim()} COLLATE BINARY`).get();
  if (clash) throw badRequest("A role with that name already exists");
  const inserted = await db
    .insert(membersRoles)
    .values({ name: name.trim() })
    .returning({ id: membersRoles.id, name: membersRoles.name })
    .get();
  for (const m of normalizeModules(modulesBody)) {
    await db
      .insert(roleModules)
      .values({ roleId: inserted.id, name: m.name, enabled: m.enabled, caps: JSON.stringify(m.caps) })
      .run();
  }
  return roleWithGrants(db, { id: inserted.id, name: inserted.name, modules: [] }) as Promise<RoleWire>;
}

export async function updateRole(
  db: DbClient,
  id: number,
  body: { name?: string; modules?: unknown }
): Promise<RoleWire> {
  const role = await getRole(db, id);
  if (!role) throw notFound("Role not found");
  const { name, modules: modulesBody } = body;
  if (name !== undefined) {
    if (!name.trim()) throw badRequest("name is required");
    const clash = await db
      .select()
      .from(membersRoles)
      .where(and(sql`name = ${name.trim()} COLLATE BINARY`, sql`id != ${id}`))
      .get();
    if (clash) throw badRequest("A role with that name already exists");
    await db.update(membersRoles).set({ name: name.trim() }).where(eq(membersRoles.id, id)).run();
  }
  if (modulesBody !== undefined) {
    await db.delete(roleModules).where(eq(roleModules.roleId, id)).run();
    for (const m of normalizeModules(modulesBody)) {
      await db
        .insert(roleModules)
        .values({ roleId: id, name: m.name, enabled: m.enabled, caps: JSON.stringify(m.caps) })
        .run();
    }
  }
  const updated = await getRole(db, id);
  return (await roleWithGrants(db, updated)) as RoleWire;
}

export async function deleteRole(db: DbClient, id: number) {
  const role = await getRole(db, id);
  if (!role) throw notFound("Role not found");
  await db.delete(membersRoles).where(eq(membersRoles.id, id)).run();
}

// --- Members -----------------------------------------------------------------
// The ORIGINAL handlers sent raw table rows (snake_case) to publicUser. Drizzle
// returns camelCase, so map back to the snake shape publicUser expects.
function snakeUser(u: typeof users.$inferSelect): AuthUserRow {
  return {
    id: u.id,
    name: u.name,
    photo_url: u.photoUrl,
    birthday: u.birthday,
    gender: u.gender,
    role_id: u.roleId,
    nav_scope: u.navScope,
    is_admin: u.isAdmin,
    is_kiosk: u.isKiosk,
    system_account: u.systemAccount,
    password_hash: u.passwordHash,
    email: u.email,
    login_enabled: u.loginEnabled,
    failed_attempts: u.failedAttempts,
    locked: u.locked,
    must_change_password: u.mustChangePassword,
  };
}

export async function listMembers(db: DbClient) {
  const rows = await db.select().from(users).orderBy(users.id).all();
  return rows.map((u) => publicUser(snakeUser(u)));
}

export interface MemberBody {
  name?: string;
  photo_url?: string | null;
  birthday?: string | null;
  gender?: string | null;
  role_id?: number | null;
  nav_scope?: string;
  is_admin?: boolean;
  is_kiosk?: boolean;
  system_account?: boolean;
  password?: string;
  email?: string | null;
  login_enabled?: boolean;
}

// Normalize + validate the login setup for a member being created or updated.
// When login is enabled an email is required, email sending must be configured,
// and an admin-typed password must pass the same policy members choose against.
// Returns the email column value (lowercased, or null).
async function loginEmailFor(
  db: DbClient,
  body: MemberBody,
  existingEmail: string | null
): Promise<string | null> {
  const enabled = !!body.login_enabled;
  const email =
    body.email === undefined ? existingEmail : String(body.email ?? "").trim().toLowerCase();
  if (enabled) {
    if (!email) throw badRequest("An email address is required to enable login");
    if (!email.includes("@") || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest("That doesn't look like a valid email address");
    }
    if (!(await emailConfigured(db))) {
      throw badRequest("Add a Resend API key in settings before enabling email login");
    }
  }
  if (body.password !== undefined) {
    const err = validateNewPassword(body.password);
    if (err) throw badRequest(err);
  }
  return enabled ? email : email ?? null;
}

async function insertMember(
  db: DbClient,
  body: MemberBody,
  opts: { mustChangePassword?: boolean } = {}
) {
  const { name, password } = body;
  if (!name || !name.trim()) throw badRequest("name is required");
  const email = await loginEmailFor(db, body, null);
  return db
    .insert(users)
    .values({
      name: name.trim(),
      photoUrl: body.photo_url || null,
      birthday: body.birthday || null,
      gender: body.gender || null,
      roleId: body.role_id ? Number(body.role_id) : null,
      navScope: body.nav_scope || "all",
      isAdmin: !!body.is_admin,
      isKiosk: !!body.is_kiosk,
      systemAccount: !!body.system_account,
      passwordHash: password ? hashPassword(password) : null,
      email,
      loginEnabled: !!body.login_enabled,
      mustChangePassword:
        opts.mustChangePassword ?? (!!body.login_enabled && !password),
    })
    .returning()
    .get();
}

export async function createMember(db: DbClient, body: MemberBody) {
  const { password } = body;
  // A login-enabled member with no admin-chosen password gets a generated
  // temporary password mailed to them separately from the welcome note.
  const issueTemp = !!body.login_enabled && !password;
  const tempPassword = issueTemp ? generateTemporaryPassword() : null;
  const row = await insertMember(
    db,
    { ...body, password: password ?? tempPassword ?? undefined },
    { mustChangePassword: issueTemp }
  );
  if (body.login_enabled && row.email) {
    if (tempPassword) {
      await sendWelcomeEmail(db, row.email);
      await sendTemporaryPasswordEmail(db, row.email, tempPassword, "welcome");
    } else {
      await sendWelcomeEmail(db, row.email);
    }
  }
  return publicUser(snakeUser(row));
}

export async function updateMember(db: DbClient, id: number, body: MemberBody) {
  const existing = await db.select().from(users).where(eq(users.id, id)).get();
  if (!existing) throw notFound("Not found");
  const { name, photo_url, birthday, gender, role_id, nav_scope, is_admin, is_kiosk, system_account, password, login_enabled } = body;

  const email = await loginEmailFor(db, body, existing.email);
  const enablingLogin = login_enabled !== undefined ? !!login_enabled : !!existing.loginEnabled;
  const justEnabled = enablingLogin && !existing.loginEnabled;

  // Turn login on for a member with no password yet (e.g. a traditionally
  // password-less member): generate a temporary password and mail it.
  const needsPassword = enablingLogin && !existing.passwordHash && !password;
  let tempPassword: string | null = null;
  if (password !== undefined || needsPassword) {
    const pw = password ?? generateTemporaryPassword();
    const bad = validateNewPassword(pw);
    if (bad) throw badRequest(bad);
    await db
      .update(users)
      .set({ passwordHash: hashPassword(pw), mustChangePassword: needsPassword })
      .where(eq(users.id, id))
      .run();
    if (needsPassword) tempPassword = pw;
  }

  await db
    .update(users)
    .set({
      name: name ?? existing.name,
      photoUrl: photo_url !== undefined ? photo_url : existing.photoUrl,
      birthday: birthday !== undefined ? birthday : existing.birthday,
      gender: gender !== undefined ? gender : existing.gender,
      roleId: role_id !== undefined ? (role_id ? Number(role_id) : null) : existing.roleId,
      navScope: nav_scope !== undefined ? nav_scope : existing.navScope,
      isAdmin: is_admin !== undefined ? !!is_admin : existing.isAdmin,
      isKiosk: is_kiosk !== undefined ? !!is_kiosk : existing.isKiosk,
      systemAccount: system_account !== undefined ? !!system_account : existing.systemAccount,
      email,
      loginEnabled: login_enabled !== undefined ? !!login_enabled : existing.loginEnabled,
    })
    .where(eq(users.id, id))
    .run();

  // When login is newly enabled, welcome the member by email exactly like
  // createMember. A freshly generated temporary password travels separately;
  // members who already had a password just get the welcome note.
  if (justEnabled && email) {
    if (tempPassword) {
      await sendWelcomeEmail(db, email);
      await sendTemporaryPasswordEmail(db, email, tempPassword, "welcome");
    } else {
      await sendWelcomeEmail(db, email);
    }
  }

  const updated = await db.select().from(users).where(eq(users.id, id)).get();
  if (!updated) throw notFound("Not found");
  return publicUser(snakeUser(updated));
}

// Admin action: clear lockout state so the member can sign in again.
export async function unlockMember(db: DbClient, id: number) {
  const existing = await db.select().from(users).where(eq(users.id, id)).get();
  if (!existing) throw notFound("Not found");
  await db
    .update(users)
    .set({ locked: false, failedAttempts: 0 })
    .where(eq(users.id, id))
    .run();
  return publicUser(snakeUser({ ...existing, locked: false, failedAttempts: 0 }));
}

// Admin action: issue a fresh random temporary password, mail it, and force a
// change on the member's next sign-in (also clears any lockout).
export async function resetMemberPassword(db: DbClient, id: number) {
  const existing = await db.select().from(users).where(eq(users.id, id)).get();
  if (!existing) throw notFound("Not found");
  if (!existing.email) throw badRequest("This member has no email address to send a password to");
  const password = generateTemporaryPassword();
  await resetPassword(db, id, password);
  await sendTemporaryPasswordEmail(db, existing.email, password, "reset");
  return publicUser(
    snakeUser({
      ...existing,
      passwordHash: hashPassword(password),
      mustChangePassword: true,
      locked: false,
      failedAttempts: 0,
    })
  );
}

export async function deleteMember(db: DbClient, id: number) {
  await db.delete(taskAssignees).where(eq(taskAssignees.userId, id)).run();
  await db.delete(users).where(eq(users.id, id)).run();
}

// --- Per-member module access -------------------------------------------------
export async function getMemberModules(db: DbClient, userId: number) {
  const rows = await db.select({ name: userModules.name, enabled: userModules.enabled }).from(userModules).where(eq(userModules.userId, userId)).all();
  return { overrides: Object.fromEntries(rows.map((o) => [o.name, !!o.enabled])) };
}

// enabled=false disables for this member, true enables, null clears the override.
export async function setMemberModules(db: DbClient, userId: number, moduleName: string, enabled: unknown) {
  await setMemberModule(db, userId, moduleName, enabled === undefined ? null : enabled);
}

export async function memberExists(db: DbClient, id: number) {
  const row = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
  if (!row) throw notFound("Not found");
  return row;
}