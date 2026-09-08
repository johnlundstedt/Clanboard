import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "clanboard.db"));
db.pragma("journal_mode = WAL");

// Core tables that don't belong to any single module
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo_url TEXT,
    birthday TEXT,
    gender TEXT,                       -- 'male' | 'female' | 'nonbinary' | null
    role_id INTEGER REFERENCES member_roles(id) ON DELETE SET NULL,
    nav_scope TEXT NOT NULL DEFAULT 'all',  -- 'own' (just that member's dashboard/tasks) | 'all'
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_kiosk INTEGER NOT NULL DEFAULT 0, -- wall-display account
    password_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS member_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Which modules a role grants, plus the capabilities within each. "caps" is
  -- JSON, e.g. {"create":true,"assign_self":true,"assign_others":false,...}.
  CREATE TABLE IF NOT EXISTS role_modules (
    role_id INTEGER NOT NULL REFERENCES member_roles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    caps TEXT,
    PRIMARY KEY (role_id, name)
  );

  CREATE TABLE IF NOT EXISTS modules (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Per-member module overrides. A row means "explicitly enabled/disabled for
  -- this member"; absent rows inherit the global modules.enabled state (or the
  -- member's role grants when one is assigned).
  CREATE TABLE IF NOT EXISTS user_modules (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, name)
  );
`);

// Minimal migrations for databases created before these columns existed.
// (member_roles is referenced by users.role_id, so it must exist first: the
// CREATE above covers fresh DBs; older DBs get the tables via the same block
// since CREATE TABLE IF NOT EXISTS runs against the existing file too.)
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes("is_kiosk")) {
  db.exec("ALTER TABLE users ADD COLUMN is_kiosk INTEGER NOT NULL DEFAULT 0");
}
if (!userCols.includes("gender")) {
  db.exec("ALTER TABLE users ADD COLUMN gender TEXT");
}
if (!userCols.includes("role_id")) {
  db.exec("ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES member_roles(id) ON DELETE SET NULL");
}
if (!userCols.includes("nav_scope")) {
  db.exec("ALTER TABLE users ADD COLUMN nav_scope TEXT NOT NULL DEFAULT 'all'");
}

// Re-run migrations after the columns exist so any newly created tables above
// (member_roles, role_modules) land in every database.
db.exec(`
  CREATE TABLE IF NOT EXISTS member_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS role_modules (
    role_id INTEGER NOT NULL REFERENCES member_roles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    caps TEXT,
    PRIMARY KEY (role_id, name)
  );
`);

export function isModuleEnabled(name) {
  const row = db.prepare("SELECT enabled FROM modules WHERE name = ?").get(name);
  // default enabled if not yet registered in the table
  return row ? !!row.enabled : true;
}

export function ensureModuleRow(name) {
  db.prepare("INSERT OR IGNORE INTO modules (name, enabled) VALUES (?, 1)").run(name);
}

export function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// --- Per-member module access -------------------------------------------------

// The modules a role can grant beyond simple on/off, and the capabilities an
// admin can toggle within each. Calendar/dashboard/admin have no per-module
// capabilities (a role either grants the module or not).
export const ROLE_CAPABILITIES = {
  tasks: [
    "view_others",
    "create", "create_unassigned",
    "assign_self", "assign_others",
    "volunteer", "reassign",
    "edit", "delete", "update_deadline",
    "complete_own", "complete_others",
    "review",
  ],
  "meal-plan": ["edit"],
  lists: ["create_lists", "delete_lists", "add_items", "remove_items", "complete_items"],
};

// Full capabilities object for every configurable module (admin / no role).
export function fullCapabilities() {
  const out = {};
  for (const [module, caps] of Object.entries(ROLE_CAPABILITIES)) {
    out[module] = Object.fromEntries(caps.map((c) => [c, true]));
  }
  return out;
}

// Explicit per-member overrides for a user: [{ name, enabled }]
export function memberModuleOverrides(userId) {
  return db
    .prepare("SELECT name, enabled FROM user_modules WHERE user_id = ?")
    .all(userId)
    .map((r) => ({ name: r.name, enabled: !!r.enabled }));
}

// Set a per-member module override. enabled=true/false writes an override row;
// enabled=null deletes it (back to inheriting the role or global state).
export function setMemberModule(userId, moduleName, enabled) {
  if (enabled == null) {
    db.prepare("DELETE FROM user_modules WHERE user_id = ? AND name = ?").run(userId, moduleName);
  } else {
    db.prepare(`
      INSERT INTO user_modules (user_id, name, enabled) VALUES (?, ?, ?)
      ON CONFLICT(user_id, name) DO UPDATE SET enabled = excluded.enabled
    `).run(userId, moduleName, enabled ? 1 : 0);
  }
}

export function getRole(id) {
  return db.prepare("SELECT * FROM member_roles WHERE id = ?").get(id) || null;
}

export function getRoleGrant(roleId, moduleName) {
  return db.prepare("SELECT * FROM role_modules WHERE role_id = ? AND name = ?").get(roleId, moduleName) || null;
}

// Module grants for a role: [{ name, enabled, caps }]
export function listRoleGrants(roleId) {
  return db
    .prepare("SELECT * FROM role_modules WHERE role_id = ? ORDER BY name")
    .all(roleId)
    .map((r) => ({
      name: r.name,
      enabled: !!r.enabled,
      caps: safeCaps(r.caps),
    }));
}

function safeCaps(json) {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Resolved capabilities for a member's role (admin/no-role = everything).
export function memberCapabilities(user) {
  if (!user || user.is_admin) return fullCapabilities();
  const caps = fullCapabilities();
  if (!user.role_id) return caps; // members without a role stay unrestricted
  for (const [module, keys] of Object.entries(ROLE_CAPABILITIES)) {
    const grant = getRoleGrant(user.role_id, module);
    if (!grant) {
      caps[module] = Object.fromEntries(keys.map((k) => [k, false]));
      continue;
    }
    const granted = safeCaps(grant.caps);
    caps[module] = Object.fromEntries(keys.map((k) => [k, granted[k] === true]));
  }
  return caps;
}

// Resolved module names a member can access. Precedence: admin bypasses roles
// and overrides; otherwise a per-member override beats the role's grants, which
// beat the global modules.enabled state. Global disabled always wins. Home is
// always on; Admin is only for admins.
export function memberEnabledModules(userId) {
  const user = db.prepare("SELECT is_admin, role_id FROM users WHERE id = ?").get(userId);
  if (!user) return [];

  const all = db.prepare("SELECT name, enabled FROM modules").all();
  const overrides = new Map(memberModuleOverrides(userId).map((o) => [o.name, o.enabled]));
  const isAdmin = !!user.is_admin;

  return all
    .filter((m) => {
      if (!m.enabled) return false; // global gate always applies
      if (m.name === "dashboard") return true; // locked landing view
      if (m.name === "admin") return isAdmin;
      if (overrides.has(m.name)) return overrides.get(m.name);
      if (user.role_id) {
        // Role members: a module outside their role's matrix stays off unless
        // a per-member override turns it on.
        return !!db
          .prepare("SELECT enabled FROM role_modules WHERE role_id = ? AND name = ?")
          .get(user.role_id, m.name)?.enabled;
      }
      return true; // no role: inherit the global gate
    })
    .map((m) => m.name);
}
