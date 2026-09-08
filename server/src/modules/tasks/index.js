import express from "express";
import { db, getSetting } from "../../db.js";
import { broadcastTasks } from "../../realtime.js";
import { requireAdmin } from "../auth/index.js";
import { hasCap, requireCap, canAssign } from "../../caps.js";
import { autoAssignIcon } from "./icon-catalog.js";
import { nextOccurrence, withinRange, occurrenceIndex, todayStr } from "./recurrence.js";

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_priorities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      category_id INTEGER REFERENCES task_categories(id) ON DELETE SET NULL,
      priority_id INTEGER REFERENCES task_priorities(id) ON DELETE SET NULL,
      dollar_value REAL,
      due_at TEXT,
      requires_adult_review INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      reviewed_at TEXT,
      recurrence_type TEXT,          -- NULL | 'daily' | 'weekdays' | 'weekends' | 'custom'
      recurrence_interval INTEGER NOT NULL DEFAULT 1,  -- "x" for custom repeats
      recurrence_period TEXT,        -- custom: 'day' | 'week' | 'month' | 'year'
      recurrence_days_of_week TEXT,  -- e.g. '["MO","WE","FR"]' for custom (weekly)
      recurrence_start_date TEXT,
      recurrence_end_date TEXT,
      recurrence_count INTEGER,      -- 'ends after N occurrences' (0/1-based cap)
      due_time TEXT,                 -- repeating tasks: daily deadline time 'HH:MM'
      icon TEXT,                     -- Lucide icon name for display; auto-assigned if null
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Multi-assignee junction table (one task can have several people)
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
  `);

  const cols = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);

  // Add the icon column for databases created before it existed
  if (!cols.includes("icon")) {
    db.exec("ALTER TABLE tasks ADD COLUMN icon TEXT");
  }
  if (!cols.includes("category_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN category_id INTEGER REFERENCES task_categories(id) ON DELETE SET NULL");
  }
  if (!cols.includes("priority_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN priority_id INTEGER REFERENCES task_priorities(id) ON DELETE SET NULL");
  }
  if (!cols.includes("dollar_value")) {
    db.exec("ALTER TABLE tasks ADD COLUMN dollar_value REAL");
  }

  // Recurrence redesign: add interval/period/due_time columns as they appear in
  // the current CREATE TABLE above (a no-op for fresh databases).
  if (!cols.includes("recurrence_interval")) {
    db.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.includes("recurrence_period")) {
    db.exec("ALTER TABLE tasks ADD COLUMN recurrence_period TEXT");
  }
  if (!cols.includes("due_time")) {
    db.exec("ALTER TABLE tasks ADD COLUMN due_time TEXT");
  }
  if (!cols.includes("recurrence_count")) {
    db.exec("ALTER TABLE tasks ADD COLUMN recurrence_count INTEGER");
  }

  // Normalize legacy recurrence data:
  //  - 'weekly' becomes a custom repeat with a 1-week interval (keeps its days)
  //  - fixed patterns get a derived period; intervals default to 1
  db.exec(`
    UPDATE tasks SET recurrence_type = 'custom', recurrence_period = 'week'
      WHERE recurrence_type = 'weekly';
    UPDATE tasks SET recurrence_period = 'day'
      WHERE recurrence_type = 'daily' AND recurrence_period IS NULL;
    UPDATE tasks SET recurrence_period = 'week'
      WHERE recurrence_type IN ('weekdays','weekends') AND recurrence_period IS NULL;
  `);

  // Move legacy single-assignee rows into the junction table, then drop the
  // obsolete column. New databases include assigned_to in CREATE TABLE only so
  // the DROP below is a no-op for them.
  if (cols.includes("assigned_to")) {
    db.exec(`
      INSERT OR IGNORE INTO task_assignees (task_id, user_id)
      SELECT id, assigned_to FROM tasks WHERE assigned_to IS NOT NULL;
    `);
    try {
      db.exec("ALTER TABLE tasks DROP COLUMN assigned_to");
    } catch {
      // Older SQLite without DROP COLUMN support: leave the unused column in
      // place; all reads/writes go through task_assignees from here on.
    }
  }

  // Ensure task_categories has an is_default column and seed the initial
  // categories (Chores/School/Household) with Chores as the default.
  const catCols = db.prepare("PRAGMA table_info(task_categories)").all().map((c) => c.name);
  if (!catCols.includes("is_default")) {
    db.exec("ALTER TABLE task_categories ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
  }
  const catCount = db.prepare("SELECT COUNT(*) AS c FROM task_categories").get().c;
  if (catCount === 0) {
    const ins = db.prepare("INSERT INTO task_categories (name, is_default) VALUES (?, ?)");
    ins.run("Chores", 1);
    ins.run("School", 0);
    ins.run("Household", 0);
  } else {
    // Make sure at least one category is marked default if the admin hasn't
    // chosen one yet.
    const anyDefault = db.prepare("SELECT id FROM task_categories WHERE is_default = 1").get();
    if (!anyDefault) {
      const first = db.prepare("SELECT id FROM task_categories ORDER BY id LIMIT 1").get();
      if (first) db.prepare("UPDATE task_categories SET is_default = 1 WHERE id = ?").run(first.id);
    }
  }

  // Seed the initial priorities: High, Medium, Low.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_priorities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const priCount = db.prepare("SELECT COUNT(*) AS c FROM task_priorities").get().c;
  if (priCount === 0) {
    const ins = db.prepare("INSERT INTO task_priorities (name, sort) VALUES (?, ?)");
    ins.run("High", 1);
    ins.run("Medium", 2);
    ins.run("Low", 3);
  }
}

const router = express.Router();

// --- Feature flags (admin-managed via /admin/settings) ------------------------
// Whether categories / priorities / dollar values are enabled for the household.
// Any authenticated user can read these so the task form can adapt.
router.get("/settings", (req, res) => {
  res.json({
    enable_categories: getSetting("tasks_enable_categories") !== "0",
    enable_priorities: getSetting("tasks_enable_priorities") !== "0",
    enable_dollar: getSetting("tasks_enable_dollar") === "1",
  });
});

// --- Task categories (admin-managed) -----------------------------------------
router.get("/categories", (req, res) => {
  res.json(db.prepare("SELECT * FROM task_categories ORDER BY id").all());
});

router.post("/categories", requireAdmin, (req, res) => {
  const { name, color, is_default } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const existing = db.prepare("SELECT id FROM task_categories WHERE name = ?").get(name.trim());
  if (existing) return res.status(400).json({ error: "A category with that name already exists" });
  const info = db
    .prepare("INSERT INTO task_categories (name, color, is_default) VALUES (?, ?, ?)")
    .run(name.trim(), color || null, is_default ? 1 : 0);
  if (is_default) {
    db.prepare("UPDATE task_categories SET is_default = 0 WHERE id != ?").run(info.lastInsertRowid);
  }
  broadcastTasks();
  res.status(201).json(db.prepare("SELECT * FROM task_categories WHERE id = ?").get(info.lastInsertRowid));
});

router.patch("/categories/:id", requireAdmin, (req, res) => {
  const existing = db.prepare("SELECT * FROM task_categories WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const { name, color, is_default } = req.body;
  db.prepare("UPDATE task_categories SET name = ?, color = ?, is_default = ? WHERE id = ?").run(
    name !== undefined ? name.trim() : existing.name,
    color !== undefined ? color : existing.color,
    is_default !== undefined ? (is_default ? 1 : 0) : existing.is_default,
    req.params.id
  );
  if (is_default) {
    db.prepare("UPDATE task_categories SET is_default = 0 WHERE id != ?").run(req.params.id);
  }
  broadcastTasks();
  res.json(db.prepare("SELECT * FROM task_categories WHERE id = ?").get(req.params.id));
});

router.delete("/categories/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM task_categories WHERE id = ?").run(req.params.id);
  broadcastTasks();
  res.status(204).end();
});

// --- Task priorities (admin-managed) -----------------------------------------
router.get("/priorities", (req, res) => {
  res.json(db.prepare("SELECT * FROM task_priorities ORDER BY sort, id").all());
});

router.post("/priorities", requireAdmin, (req, res) => {
  const { name, sort } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const existing = db.prepare("SELECT id FROM task_priorities WHERE name = ?").get(name.trim());
  if (existing) return res.status(400).json({ error: "That priority already exists" });
  const nextSort = sort !== undefined ? Number(sort) : Number(db.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM task_priorities").get().m) + 1;
  const info = db
    .prepare("INSERT INTO task_priorities (name, sort) VALUES (?, ?)")
    .run(name.trim(), nextSort);
  broadcastTasks();
  res.status(201).json(db.prepare("SELECT * FROM task_priorities WHERE id = ?").get(info.lastInsertRowid));
});

router.patch("/priorities/:id", requireAdmin, (req, res) => {
  const existing = db.prepare("SELECT * FROM task_priorities WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const { name, sort } = req.body;
  db.prepare("UPDATE task_priorities SET name = ?, sort = ? WHERE id = ?").run(
    name !== undefined ? name.trim() : existing.name,
    sort !== undefined ? (Number(sort) || existing.sort) : existing.sort,
    req.params.id
  );
  broadcastTasks();
  res.json(db.prepare("SELECT * FROM task_priorities WHERE id = ?").get(req.params.id));
});

router.delete("/priorities/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM task_priorities WHERE id = ?").run(req.params.id);
  broadcastTasks();
  res.status(204).end();
});

// Helper: the current default category, or the first one if none is marked.
function defaultCategoryId() {
  return db.prepare("SELECT id FROM task_categories WHERE is_default = 1 ORDER BY id LIMIT 1").get()?.id
    || db.prepare("SELECT id FROM task_categories ORDER BY id LIMIT 1").get()?.id
    || null;
}

// Reject a request if any assignee in `userIds` isn't someone the current user
// may assign to (self → assign_self, anyone else → assign_others).
function assertCanAssign(req, res, userIds) {
  for (const id of userIds) {
    if (!canAssign(req.user, id)) {
      return res.status(403).json({ error: "Your role doesn't allow assigning tasks to that person." });
    }
  }
}

// --- Assignee helpers ---------------------------------------------------------

function normalizeUserIds(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

function setAssignees(taskId, userIds) {
  db.prepare("DELETE FROM task_assignees WHERE task_id = ?").run(taskId);
  const stmt = db.prepare("INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)");
  for (const uid of normalizeUserIds(userIds)) stmt.run(taskId, uid);
}

// Attaches `assignees: [{id, name}]` to every task in `tasks`, resolves
// category/priority names, and synthesizes `assigned_to` (first assignee id or
// null) for older client callers.
function attachAssignees(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const rows = db.prepare(`
    SELECT ta.task_id, u.id AS user_id, u.name
    FROM task_assignees ta
    JOIN users u ON u.id = ta.user_id
    WHERE ta.task_id IN (${ids.map(() => "?").join(",")})
    ORDER BY u.id
  `).all(...ids);
  const byTask = new Map();
  for (const r of rows) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push({ id: r.user_id, name: r.name });
  }

  const catIds = [...new Set(tasks.map((t) => t.category_id).filter(Boolean))];
  const catNames = new Map();
  if (catIds.length) {
    const cats = db.prepare(`SELECT id, name FROM task_categories WHERE id IN (${catIds.map(() => "?").join(",")})`).all(...catIds);
    for (const c of cats) catNames.set(c.id, c.name);
  }
  const priIds = [...new Set(tasks.map((t) => t.priority_id).filter(Boolean))];
  const priNames = new Map();
  if (priIds.length) {
    const pris = db.prepare(`SELECT id, name FROM task_priorities WHERE id IN (${priIds.map(() => "?").join(",")})`).all(...priIds);
    for (const p of pris) priNames.set(p.id, p.name);
  }

  for (const t of tasks) {
    const list = byTask.get(t.id) || [];
    t.assignees = list;
    t.assigned_to = list.length ? list[0].id : null;
    t.category_name = catNames.get(t.category_id) || null;
    t.priority_name = priNames.get(t.priority_id) || null;
  }
  return tasks;
}

// List all tasks, optionally filtered to a single member's assignments
// via ?user_id= (wall-display member view). Non-admins without the
// `view_others` capability only see their own tasks.
router.get("/", (req, res) => {
  const requestedUser = req.query.user_id ? Number(req.query.user_id) : null;

  if (requestedUser && !hasCap(req.user, "tasks", "view_others") && requestedUser !== req.user.id) {
    return res.status(403).json({ error: "Your role doesn't allow viewing that member's tasks." });
  }

  const canViewAll = hasCap(req.user, "tasks", "view_others");
  const userId = requestedUser || (!canViewAll ? req.user.id : null);

  const tasks = userId
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE EXISTS (
          SELECT 1 FROM task_assignees ta
          WHERE ta.task_id = tasks.id AND ta.user_id = ?
        )
        ORDER BY due_at IS NULL, due_at, id
      `).all(userId)
    : db.prepare(`
        SELECT * FROM tasks
        ORDER BY due_at IS NULL, due_at, id
      `).all();
  res.json(attachAssignees(tasks));
});

// Quick-add: name only, everything else optional/filled in later. New quick-add
// tasks are assigned the default task category. Creating an unassigned task
// requires the `create_unassigned` capability; assigning it needs assign caps.
router.post("/quick-add", requireCap("tasks", "create"), (req, res) => {
  const { name, assigned_ids } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const ids = assigned_ids ? normalizeUserIds(assigned_ids) : [];
  if (ids.length === 0 && !hasCap(req.user, "tasks", "create_unassigned")) {
    return res.status(403).json({ error: "Your role doesn't allow creating unassigned tasks." });
  }
  if (ids.length) {
    const denied = assertCanAssign(req, res, ids);
    if (denied) return denied;
  }
  const trimmed = name.trim();
  const icon = autoAssignIcon(trimmed);
  const info = db
    .prepare("INSERT INTO tasks (name, icon, category_id) VALUES (?, ?, ?)")
    .run(trimmed, icon, defaultCategoryId());
  if (ids.length) setAssignees(info.lastInsertRowid, ids);
  const task = attachAssignees([db.prepare("SELECT * FROM tasks WHERE id = ?").get(info.lastInsertRowid)])[0];
  broadcastTasks();
  res.status(201).json(task);
});

// Full create, for the detailed task form
router.post("/", requireCap("tasks", "create"), (req, res) => {
  const {
    name, description, category_id, priority_id, dollar_value,
    assigned_to, assigned_ids, due_at, due_time, requires_adult_review,
    recurrence_type, recurrence_interval, recurrence_period, recurrence_days_of_week,
    recurrence_start_date, recurrence_end_date, recurrence_count, icon,
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const targetIds = normalizeUserIds(assigned_ids !== undefined ? assigned_ids : assigned_to);
  const denied = assertCanAssign(req, res, targetIds);
  if (denied) return denied;

  const trimmedName = name.trim();
  const iconName = icon || autoAssignIcon(trimmedName);

  const info = db.prepare(`
    INSERT INTO tasks (
      name, description, category_id, priority_id, dollar_value, due_at, due_time, requires_adult_review,
      recurrence_type, recurrence_interval, recurrence_period, recurrence_days_of_week,
      recurrence_start_date, recurrence_end_date, recurrence_count, icon
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trimmedName,
    description || null,
    category_id !== undefined ? (category_id ? Number(category_id) : null) : defaultCategoryId(),
    priority_id !== undefined ? (priority_id ? Number(priority_id) : null) : null,
    dollar_value !== undefined && dollar_value !== null && dollar_value !== ""
      ? (Number(dollar_value) || null)
      : null,
    due_at || null,
    due_time || null,
    requires_adult_review ? 1 : 0,
    recurrence_type || null,
    recurrence_interval !== undefined ? (Number(recurrence_interval) || 1) : 1,
    recurrence_period || null,
    recurrence_days_of_week ? JSON.stringify(recurrence_days_of_week) : null,
    recurrence_start_date || null,
    recurrence_end_date || null,
    recurrence_count !== undefined ? (Number(recurrence_count) || null) : null,
    iconName
  );

  // Back-compat: a bare assigned_to (single id/null) behaves like assigned_ids
  if (assigned_ids !== undefined) setAssignees(info.lastInsertRowid, assigned_ids);
  else if (assigned_to !== undefined) setAssignees(info.lastInsertRowid, assigned_to);

  const task = attachAssignees([db.prepare("SELECT * FROM tasks WHERE id = ?").get(info.lastInsertRowid)])[0];
  broadcastTasks();
  res.status(201).json(task);
});

// Mark complete (assignee checks it off) — if requires_adult_review, this
// does NOT count as fully done until an adult also reviews it. Users may only
// complete their own tasks unless they have the `complete_others` capability.
function assertCanComplete(req, res, task) {
  const assignedToMe = db
    .prepare("SELECT user_id FROM task_assignees WHERE task_id = ? AND user_id = ?")
    .get(task.id, req.user.id);
  if (assignedToMe) {
    if (hasCap(req.user, "tasks", "complete_own")) return null;
  } else if (hasCap(req.user, "tasks", "complete_others")) {
    return null;
  }
  return res.status(403).json({ error: "Your role doesn't allow completing that task." });
}

router.patch("/:id/complete", (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  const denied = assertCanComplete(req, res, task);
  if (denied) return denied;

  const nowDate = todayStr();
  const next = task.recurrence_type ? nextOccurrence(task, nowDate) : null;

  const afterN = task.recurrence_count;
  const reachedCount = afterN && next && occurrenceIndex(task, next) > afterN;

  if (next && withinRange(task, next) && !reachedCount) {
    // Roll over: same row becomes the next instance
    db.prepare(`
      UPDATE tasks SET
        due_at = ?,
        completed_at = NULL,
        reviewed_at = NULL
      WHERE id = ?
    `).run(next, req.params.id);
  } else {
    db.prepare("UPDATE tasks SET completed_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
  }

  broadcastTasks();
  res.json({ ok: true });
});

// Undo completion (also usable for a recurring task that already rolled over —
// that's acceptable for v1)
router.patch("/:id/uncomplete", (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  const denied = assertCanComplete(req, res, task);
  if (denied) return denied;
  db.prepare("UPDATE tasks SET completed_at = NULL, reviewed_at = NULL WHERE id = ?")
    .run(req.params.id);
  broadcastTasks();
  res.json({ ok: true });
});

// Adult review — separate step, only meaningful for requires_adult_review tasks
router.patch("/:id/review", requireCap("tasks", "review"), (req, res) => {
  db.prepare("UPDATE tasks SET reviewed_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  broadcastTasks();
  res.json({ ok: true });
});

// Un-review (an admin/role with review power changed their mind after marking reviewed)
router.patch("/:id/unreview", requireCap("tasks", "review"), (req, res) => {
  db.prepare("UPDATE tasks SET reviewed_at = NULL WHERE id = ?")
    .run(req.params.id);
  broadcastTasks();
  res.json({ ok: true });
});

// PATCH /assign sets the assignee list for a task. Fine-grained rules:
//  - Unassigned task → volunteer (for self) or assign_others (for anyone else)
//  - Already-assigned task → reassign
//  - Each target still needs the usual assign_self/assign_others grant.
router.patch("/:id/assign", (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  let userIds;
  if (req.body.user_ids !== undefined) userIds = normalizeUserIds(req.body.user_ids);
  else userIds = normalizeUserIds(req.body.assigned_to !== undefined ? req.body.assigned_to : []);

  const current = db.prepare("SELECT user_id FROM task_assignees WHERE task_id = ?").all(task.id).map((r) => r.user_id);
  const wasUnassigned = current.length === 0;

  if (wasUnassigned) {
    const selfOnly = userIds.length === 1 && userIds[0] === req.user.id;
    if (selfOnly) {
      if (!hasCap(req.user, "tasks", "volunteer") && !hasCap(req.user, "tasks", "assign_self")) {
        return res.status(403).json({ error: "Your role doesn't allow volunteering for unassigned tasks." });
      }
    } else if (!hasCap(req.user, "tasks", "assign_others")) {
      return res.status(403).json({ error: "Your role doesn't allow assigning tasks to other people." });
    }
  } else if (!hasCap(req.user, "tasks", "reassign")) {
    return res.status(403).json({ error: "Your role doesn't allow reassigning tasks." });
  }

  const denied = assertCanAssign(req, res, userIds);
  if (denied) return denied;
  setAssignees(task.id, userIds);
  broadcastTasks();
  res.json({ ok: true });
});

// Patch task details (name, description, due_at, etc.)
router.patch("/:id", requireCap("tasks", "edit"), (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });

  const {
    name, description, category_id, priority_id, dollar_value, due_at, due_time,
    requires_adult_review, recurrence_type, recurrence_interval, recurrence_period,
    recurrence_days_of_week, recurrence_start_date, recurrence_end_date, recurrence_count,
    icon, assigned_ids, assigned_to,
  } = req.body;

  if (assigned_ids !== undefined || assigned_to !== undefined) {
    const targetIds = normalizeUserIds(assigned_ids !== undefined ? assigned_ids : assigned_to);
    const denied = assertCanAssign(req, res, targetIds);
    if (denied) return denied;
  }

  db.prepare(`
    UPDATE tasks SET
      name = ?,
      description = ?,
      category_id = ?,
      priority_id = ?,
      dollar_value = ?,
      due_at = ?,
      due_time = ?,
      requires_adult_review = ?,
      recurrence_type = ?,
      recurrence_interval = ?,
      recurrence_period = ?,
      recurrence_days_of_week = ?,
      recurrence_start_date = ?,
      recurrence_end_date = ?,
      recurrence_count = ?,
      icon = ?
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : task.name,
    description !== undefined ? description : task.description,
    category_id !== undefined ? (category_id ? Number(category_id) : null) : task.category_id,
    priority_id !== undefined ? (priority_id ? Number(priority_id) : null) : task.priority_id,
    dollar_value !== undefined
      ? (dollar_value === null || dollar_value === "" ? null : (Number(dollar_value) || null))
      : task.dollar_value,
    due_at !== undefined ? due_at : task.due_at,
    due_time !== undefined ? due_time : task.due_time,
    requires_adult_review !== undefined ? (requires_adult_review ? 1 : 0) : task.requires_adult_review,
    recurrence_type !== undefined ? recurrence_type : task.recurrence_type,
    recurrence_interval !== undefined
      ? (Number(recurrence_interval) || 1)
      : task.recurrence_interval,
    recurrence_period !== undefined ? recurrence_period : task.recurrence_period,
    recurrence_days_of_week !== undefined
      ? (recurrence_days_of_week ? JSON.stringify(recurrence_days_of_week) : null)
      : task.recurrence_days_of_week,
    recurrence_start_date !== undefined ? recurrence_start_date : task.recurrence_start_date,
    recurrence_end_date !== undefined ? recurrence_end_date : task.recurrence_end_date,
    recurrence_count !== undefined
      ? (recurrence_count ? Number(recurrence_count) : null)
      : task.recurrence_count,
    icon !== undefined ? icon : task.icon,
    req.params.id
  );

  if (assigned_ids !== undefined) setAssignees(task.id, assigned_ids);
  else if (assigned_to !== undefined) setAssignees(task.id, assigned_to);

  broadcastTasks();
  res.json({ ok: true });
});

router.delete("/:id", requireCap("tasks", "delete"), (req, res) => {
  db.prepare("DELETE FROM task_assignees WHERE task_id = ?").run(req.params.id);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
  broadcastTasks();
  res.status(204).end();
});

// Dashboard helper: tasks "due today or overdue" plus unassigned tasks needing
// an owner. `date` is a YYYY-MM-DD local date (defaults to today).
router.get("/today", (req, res) => {
  const date = req.query.date || todayStr();

  const dueToday = db.prepare(`
    SELECT * FROM tasks
    WHERE completed_at IS NULL
      AND (due_at IS NULL OR substr(due_at, 1, 10) = ?)
    ORDER BY due_at IS NULL, due_at, id
  `).all(date);

  const unassigned = db.prepare(`
    SELECT * FROM tasks
    WHERE completed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id
      )
    ORDER BY id
  `).all();

  res.json({ date, dueToday: attachAssignees(dueToday), unassigned: attachAssignees(unassigned) });
});

export default {
  name: "tasks",
  navLabel: "Tasks",
  migrate,
  router,
};