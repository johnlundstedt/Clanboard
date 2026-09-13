import { Hono } from "hono";
import { notifyTasks } from "../../web/events.js";
import { containerDb } from "../../core/container-db.js";
import { numParam, readJson, requireCap, respond } from "../../web/helpers.js";
import { requireAdmin } from "../../web/security.js";
import * as core from "../../core/tasks.js";

async function migrate(db) {
  await db.exec(`
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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
  `);

  const cols = (await db.prepare("PRAGMA table_info(tasks)").all()).map((c) => c.name);

  // Add the icon column for databases created before it existed
  if (!cols.includes("icon")) {
    await db.exec("ALTER TABLE tasks ADD COLUMN icon TEXT");
  }
  if (!cols.includes("category_id")) {
    await db.exec("ALTER TABLE tasks ADD COLUMN category_id INTEGER REFERENCES task_categories(id) ON DELETE SET NULL");
  }
  if (!cols.includes("priority_id")) {
    await db.exec("ALTER TABLE tasks ADD COLUMN priority_id INTEGER REFERENCES task_priorities(id) ON DELETE SET NULL");
  }
  if (!cols.includes("dollar_value")) {
    await db.exec("ALTER TABLE tasks ADD COLUMN dollar_value REAL");
  }

  // Recurrence redesign: add interval/period/due_time columns as they appear in
  // the current CREATE TABLE above (a no-op for fresh databases).
  if (!cols.includes("recurrence_interval")) {
    await db.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.includes("recurrence_period")) {
    await db.exec("ALTER TABLE tasks ADD COLUMN recurrence_period TEXT");
  }
  if (!cols.includes("due_time")) {
    await db.exec("ALTER TABLE tasks ADD COLUMN due_time TEXT");
  }
  if (!cols.includes("recurrence_count")) {
    await db.exec("ALTER TABLE tasks ADD COLUMN recurrence_count INTEGER");
  }

  // Normalize legacy recurrence data:
  //  - 'weekly' becomes a custom repeat with a 1-week interval (keeps its days)
  //  - fixed patterns get a derived period; intervals default to 1
  await db.exec(`
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
    await db.exec(`
      INSERT OR IGNORE INTO task_assignees (task_id, user_id)
      SELECT id, assigned_to FROM tasks WHERE assigned_to IS NOT NULL;
    `);
    try {
      await db.exec("ALTER TABLE tasks DROP COLUMN assigned_to");
    } catch {
      // Older SQLite without DROP COLUMN support: leave the unused column in
      // place; all reads/writes go through task_assignees from here on.
    }
  }

  // Ensure task_categories has an is_default column and seed the initial
  // categories (Chores/School/Household) with Chores as the default.
  const catCols = (await db.prepare("PRAGMA table_info(task_categories)").all()).map((c) => c.name);
  if (!catCols.includes("is_default")) {
    await db.exec("ALTER TABLE task_categories ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
  }
  const catCount = (await db.prepare("SELECT COUNT(*) AS c FROM task_categories").get()).c;
  if (catCount === 0) {
    const ins = db.prepare("INSERT INTO task_categories (name, is_default) VALUES (?, ?)");
    await ins.run("Chores", 1);
    await ins.run("School", 0);
    await ins.run("Household", 0);
  } else {
    // Make sure at least one category is marked default if the admin hasn't
    // chosen one yet.
    const anyDefault = await db.prepare("SELECT id FROM task_categories WHERE is_default = 1").get();
    if (!anyDefault) {
      const first = await db.prepare("SELECT id FROM task_categories ORDER BY id LIMIT 1").get();
      if (first) await db.prepare("UPDATE task_categories SET is_default = 1 WHERE id = ?").run(first.id);
    }
  }

  // Seed the initial priorities: High, Medium, Low.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS task_priorities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const priCount = (await db.prepare("SELECT COUNT(*) AS c FROM task_priorities").get()).c;
  if (priCount === 0) {
    const ins = db.prepare("INSERT INTO task_priorities (name, sort) VALUES (?, ?)");
    await ins.run("High", 1);
    await ins.run("Medium", 2);
    await ins.run("Low", 3);
  }
}

const app = new Hono();

// --- Feature flags (admin-managed via /admin/settings) ------------------------
// Whether categories / priorities / dollar values are enabled for the household.
// Any authenticated user can read these so the task form can adapt.
app.get("/settings", (c) => respond(c, () => core.taskSettings(containerDb)));

// --- Task categories (admin-managed) -----------------------------------------
app.get("/categories", (c) => respond(c, () => core.listCategories(containerDb)));

app.post("/categories", requireAdmin, (c) =>
  respond(c, async () => {
    const category = await core.createCategory(containerDb, await readJson(c));
    notifyTasks();
    return category;
  }, { status: 201 })
);

app.patch("/categories/:id", requireAdmin, (c) =>
  respond(c, async () => {
    const category = await core.updateCategory(containerDb, numParam(c, "id"), await readJson(c));
    notifyTasks();
    return category;
  })
);

app.delete("/categories/:id", requireAdmin, (c) =>
  respond(c, async () => {
    await core.deleteCategory(containerDb, numParam(c, "id"));
    notifyTasks();
    return null;
  }, { status: 204 })
);

// --- Task priorities (admin-managed) -----------------------------------------
app.get("/priorities", (c) => respond(c, () => core.listPriorities(containerDb)));

app.post("/priorities", requireAdmin, (c) =>
  respond(c, async () => {
    const priority = await core.createPriority(containerDb, await readJson(c));
    notifyTasks();
    return priority;
  }, { status: 201 })
);

app.patch("/priorities/:id", requireAdmin, (c) =>
  respond(c, async () => {
    const priority = await core.updatePriority(containerDb, numParam(c, "id"), await readJson(c));
    notifyTasks();
    return priority;
  })
);

app.delete("/priorities/:id", requireAdmin, (c) =>
  respond(c, async () => {
    await core.deletePriority(containerDb, numParam(c, "id"));
    notifyTasks();
    return null;
  }, { status: 204 })
);

// --- Tasks -------------------------------------------------------------------
// List all tasks, optionally filtered to a single member's assignments
// via ?user_id= (wall-display member view).
app.get("/", (c) =>
  respond(c, () => core.listTasks(containerDb, c.get("user"), { user_id: c.req.query("user_id") }))
);

// Quick-add: name only, everything else optional/filled in later.
app.post("/quick-add", requireCap(containerDb, "tasks", "create"), (c) =>
  respond(c, async () => {
    const task = await core.quickAddTask(containerDb, c.get("user"), await readJson(c));
    notifyTasks();
    return task;
  }, { status: 201 })
);

// Full create, for the detailed task form
app.post("/", requireCap(containerDb, "tasks", "create"), (c) =>
  respond(c, async () => {
    const task = await core.createTask(containerDb, c.get("user"), await readJson(c));
    notifyTasks();
    return task;
  }, { status: 201 })
);

app.patch("/:id/complete", (c) =>
  respond(c, async () => {
    const out = await core.completeTask(containerDb, c.get("user"), numParam(c, "id"));
    notifyTasks();
    return out;
  })
);

app.patch("/:id/uncomplete", (c) =>
  respond(c, async () => {
    const out = await core.uncompleteTask(containerDb, c.get("user"), numParam(c, "id"));
    notifyTasks();
    return out;
  })
);

app.patch("/:id/review", requireCap(containerDb, "tasks", "review"), (c) =>
  respond(c, async () => {
    const out = await core.reviewTask(containerDb, c.get("user"), numParam(c, "id"));
    notifyTasks();
    return out;
  })
);

app.patch("/:id/unreview", requireCap(containerDb, "tasks", "review"), (c) =>
  respond(c, async () => {
    const out = await core.unreviewTask(containerDb, c.get("user"), numParam(c, "id"));
    notifyTasks();
    return out;
  })
);

app.patch("/:id/assign", (c) =>
  respond(c, async () => {
    const out = await core.assignTask(containerDb, c.get("user"), numParam(c, "id"), await readJson(c));
    notifyTasks();
    return out;
  })
);

// Patch task details (name, description, due_at, etc.)
app.patch("/:id", requireCap(containerDb, "tasks", "edit"), (c) =>
  respond(c, async () => {
    const out = await core.updateTask(containerDb, c.get("user"), numParam(c, "id"), await readJson(c));
    notifyTasks();
    return out;
  })
);

app.delete("/:id", requireCap(containerDb, "tasks", "delete"), (c) =>
  respond(c, async () => {
    await core.deleteTask(containerDb, c.get("user"), numParam(c, "id"));
    notifyTasks();
    return null;
  }, { status: 204 })
);

// Dashboard helper: tasks "due today or overdue" plus unassigned tasks.
app.get("/today", (c) =>
  respond(c, () => core.tasksToday(containerDb, c.req.query("date") || undefined))
);

export default {
  name: "tasks",
  navLabel: "Tasks",
  migrate,
  app,
};