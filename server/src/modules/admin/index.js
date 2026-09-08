import express from "express";
import fs from "node:fs";
import path from "node:path";
import {
  db, setSetting, getSetting, memberModuleOverrides, setMemberModule,
  ROLE_CAPABILITIES, fullCapabilities, getRole, listRoleGrants,
} from "../../db.js";
import { broadcast } from "../../realtime.js";
import { publicUser, hashPassword } from "../auth/index.js";
import { listModulesStatus } from "../registry.js";

const UPLOADS_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

// Modules a role can toggle + configure capabilities for (Home/Admin are locked).
const ROLE_MODULES = ["tasks", "lists", "meal-plan", "calendar"];

function defaultRoleModule(name) {
  const caps = ROLE_CAPABILITIES[name] || [];
  return {
    name,
    enabled: true,
    caps: Object.fromEntries(caps.map((c) => [c, true])),
  };
}

function migrate(db) {
  // Admin owns no tables of its own; it manages the modules, users, and
  // settings tables created by core and other modules. It does seed the
  // default family roles on a fresh database.
  seedDefaultRoles(db, ROLE_CAPABILITIES);
}

// Default capabilities per role for each module a role can grant. Keys are
// capability names from ROLE_CAPABILITIES; true grants the capability, false
// denies it. Modules not listed for a role stay off (the role matrix gates
// access entirely).
const DEFAULT_ROLES = {
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

function seedDefaultRoles(db, roleCaps) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM member_roles").get().c;
  if (count > 0) return;

  const insertRole = db.prepare("INSERT INTO member_roles (name) VALUES (?)");
  const insertGrant = db.prepare(`
    INSERT INTO role_modules (role_id, name, enabled, caps) VALUES (?, ?, ?, ?)
  `);

  for (const [roleName, roleCfg] of Object.entries(DEFAULT_ROLES)) {
    const info = insertRole.run(roleName);
    for (const [moduleName, moduleCfg] of Object.entries(roleCfg)) {
      const caps = Object.fromEntries(
        (roleCaps[moduleName] || []).map((c) => [c, moduleCfg[c] === true])
      );
      insertGrant.run(info.lastInsertRowid, moduleName, 1, JSON.stringify(caps));
    }
  }
}

const router = express.Router();

// --- Photos ------------------------------------------------------------------
// Upload a member photo. Accepts a base64 data URL in JSON, stored on disk
// under DATA_DIR/uploads (kept lean, no multipart dep for one household).
router.post("/photos", (req, res) => {
  const { data, name } = req.body;
  if (!data || !data.startsWith("data:image/")) {
    return res.status(400).json({ error: "photo must be a base64 data URL" });
  }
  const mime = data.slice(5, data.indexOf(";"));
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime] || "jpg";
  const base64 = data.slice(data.indexOf(",") + 1);
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "photo too large (max 5MB)" });
  }

  const uploadsDir = path.join(UPLOADS_DIR, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const slug = (name || "photo")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "photo";
  const filename = `${Date.now()}-${slug}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  res.status(201).json({ photo_url: `/uploads/${filename}` });
});

// --- Module toggles ----------------------------------------------------------
router.get("/modules", (req, res) => {
  res.json(listModulesStatus());
});

router.patch("/modules/:name", (req, res) => {
  const { enabled } = req.body;
  db.prepare("UPDATE modules SET enabled = ? WHERE name = ?").run(enabled ? 1 : 0, req.params.name);
  broadcast("modules");
  res.json({ ok: true });
});

// --- Household settings ------------------------------------------------------
// Basic Settings: household name + weather location are stored in the settings
// table. Module enablement lives in the modules table (see /modules above).
router.get("/settings", (req, res) => {
  res.json({
    family_name: getSetting("family_name"),
    latitude: getSetting("latitude"),
    longitude: getSetting("longitude"),
    weather_location: getSetting("weather_location"),
    weather_units: getSetting("weather_units") || "metric",
    tasks_enable_categories: getSetting("tasks_enable_categories") !== "0",
    tasks_enable_priorities: getSetting("tasks_enable_priorities") !== "0",
    tasks_enable_dollar: getSetting("tasks_enable_dollar") === "1",
  });
});

function flagToStorage(value, current) {
  if (value === undefined) return current;
  return value ? "1" : "0";
}

router.post("/settings", (req, res) => {
  const {
    family_name, latitude, longitude, weather_location, weather_units,
    tasks_enable_categories, tasks_enable_priorities, tasks_enable_dollar,
  } = req.body;
  if (family_name !== undefined) setSetting("family_name", family_name);
  if (latitude !== undefined) setSetting("latitude", latitude === "" ? null : String(latitude));
  if (longitude !== undefined) setSetting("longitude", longitude === "" ? null : String(longitude));
  if (weather_location !== undefined) setSetting("weather_location", weather_location);
  if (weather_units !== undefined) {
    const units = ["imperial", "metric", "both"].includes(weather_units) ? weather_units : "metric";
    setSetting("weather_units", units);
  }
  if (tasks_enable_categories !== undefined) {
    setSetting("tasks_enable_categories", flagToStorage(tasks_enable_categories, getSetting("tasks_enable_categories")));
  }
  if (tasks_enable_priorities !== undefined) {
    setSetting("tasks_enable_priorities", flagToStorage(tasks_enable_priorities, getSetting("tasks_enable_priorities")));
  }
  if (tasks_enable_dollar !== undefined) {
    setSetting("tasks_enable_dollar", flagToStorage(tasks_enable_dollar, getSetting("tasks_enable_dollar")));
  }
  broadcast("users");
  broadcast("dashboard");
  res.json({ ok: true });
});

// --- Roles -------------------------------------------------------------------
// Expose the capability catalog so the admin UI can render per-module
// permission checkboxes (server remains the source of truth for enforcement).
const CAP_LABELS = {
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

router.get("/role-capabilities", (req, res) => {
  res.json({
    modules: ROLE_MODULES.map((name) => ({
      name,
      caps: (ROLE_CAPABILITIES[name] || []).map((cap) => ({
        key: cap,
        label: CAP_LABELS[name]?.[cap] || cap,
      })),
    })),
  });
});

function roleWithGrants(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, modules: listRoleGrants(row.id) };
}

function normalizeModules(modules) {
  const list = Array.isArray(modules) ? modules : [];
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

router.get("/roles", (req, res) => {
  const roles = db.prepare("SELECT * FROM member_roles ORDER BY id").all();
  res.json(roles.map(roleWithGrants));
});

router.get("/roles/:id", (req, res) => {
  const role = roleWithGrants(getRole(Number(req.params.id)));
  if (!role) return res.status(404).json({ error: "Role not found" });
  res.json(role);
});

router.post("/roles", (req, res) => {
  const { name, modules } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const existing = db.prepare("SELECT id FROM member_roles WHERE name = ?").get(name.trim());
  if (existing) return res.status(400).json({ error: "A role with that name already exists" });

  const info = db.prepare("INSERT INTO member_roles (name) VALUES (?)").run(name.trim());
  const roleId = info.lastInsertRowid;
  const stmt = db.prepare(`
    INSERT INTO role_modules (role_id, name, enabled, caps) VALUES (?, ?, ?, ?)
  `);
  for (const m of normalizeModules(modules)) {
    stmt.run(roleId, m.name, m.enabled ? 1 : 0, JSON.stringify(m.caps));
  }
  broadcast("users");
  broadcast("modules");
  res.status(201).json(roleWithGrants(getRole(roleId)));
});

router.patch("/roles/:id", (req, res) => {
  const role = getRole(Number(req.params.id));
  if (!role) return res.status(404).json({ error: "Role not found" });
  const { name, modules } = req.body;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "name is required" });
    const clash = db.prepare("SELECT id FROM member_roles WHERE name = ? AND id != ?").get(name.trim(), role.id);
    if (clash) return res.status(400).json({ error: "A role with that name already exists" });
    db.prepare("UPDATE member_roles SET name = ? WHERE id = ?").run(name.trim(), role.id);
  }
  if (modules !== undefined) {
    db.prepare("DELETE FROM role_modules WHERE role_id = ?").run(role.id);
    const stmt = db.prepare(`
      INSERT INTO role_modules (role_id, name, enabled, caps) VALUES (?, ?, ?, ?)
    `);
    for (const m of normalizeModules(modules)) {
      stmt.run(role.id, m.name, m.enabled ? 1 : 0, JSON.stringify(m.caps));
    }
  }
  broadcast("users");
  broadcast("modules");
  res.json(roleWithGrants(getRole(role.id)));
});

router.delete("/roles/:id", (req, res) => {
  const role = getRole(Number(req.params.id));
  if (!role) return res.status(404).json({ error: "Role not found" });
  db.prepare("DELETE FROM member_roles WHERE id = ?").run(role.id);
  broadcast("users");
  broadcast("modules");
  res.status(204).end();
});

// --- Members -----------------------------------------------------------------
router.get("/members", (req, res) => {
  const users = db
    .prepare("SELECT * FROM users ORDER BY id")
    .all()
    .map(publicUser);
  res.json(users);
});

router.post("/members", (req, res) => {
  const { name, photo_url, birthday, gender, role_id, nav_scope, is_admin, is_kiosk, password } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  const info = db.prepare(`
    INSERT INTO users (name, photo_url, birthday, gender, role_id, nav_scope, is_admin, is_kiosk, password_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    photo_url || null,
    birthday || null,
    gender || null,
    role_id ? Number(role_id) : null,
    nav_scope || "all",
    is_admin ? 1 : 0,
    is_kiosk ? 1 : 0,
    password ? hashPassword(password) : null
  );
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  broadcast("users");
  res.status(201).json(publicUser(user));
});

router.patch("/members/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const { name, photo_url, birthday, gender, role_id, nav_scope, is_admin, is_kiosk, password } = req.body;
  db.prepare(`
    UPDATE users
    SET name = ?, photo_url = ?, birthday = ?, gender = ?, role_id = ?, nav_scope = ?,
        is_admin = ?, is_kiosk = ?
    WHERE id = ?
  `).run(
    name ?? existing.name,
    photo_url !== undefined ? photo_url : existing.photo_url,
    birthday !== undefined ? birthday : existing.birthday,
    gender !== undefined ? gender : existing.gender,
    role_id !== undefined ? (role_id ? Number(role_id) : null) : existing.role_id,
    nav_scope !== undefined ? nav_scope : existing.nav_scope,
    is_admin !== undefined ? (is_admin ? 1 : 0) : existing.is_admin,
    is_kiosk !== undefined ? (is_kiosk ? 1 : 0) : existing.is_kiosk,
    req.params.id
  );

  if (password) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(hashPassword(password), req.params.id);
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  broadcast("users");
  res.json(publicUser(user));
});

// --- Per-member module access -------------------------------------------------
router.get("/members/:id/modules", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ overrides: Object.fromEntries(memberModuleOverrides(user.id).map((o) => [o.name, o.enabled])) });
});

// Body: { module, enabled } — enabled=false disables for this member, true
// enables, null clears the override (back to inheriting the global state).
router.patch("/members/:id/modules", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  const { module, enabled } = req.body;
  if (!module) return res.status(400).json({ error: "module is required" });
  setMemberModule(user.id, module, enabled === undefined ? null : enabled);
  broadcast("modules");
  broadcast("users");
  res.json({ ok: true });
});

router.delete("/members/:id", (req, res) => {
  db.prepare("DELETE FROM task_assignees WHERE user_id = ?").run(req.params.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  broadcast("users");
  res.status(204).end();
});

export default {
  name: "admin",
  navLabel: "Admin",
  migrate,
  router,
};