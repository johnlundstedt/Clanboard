// One-time legacy cleanup for databases created before the priorities / dollar
// value features were removed (drizzle 0000 created task_priorities and the
// priority_id / dollar_value columns on tasks). SQLite refuses to DROP COLUMN
// while priority_id is part of a FOREIGN KEY constraint, so rebuild `tasks` in
// place — guarded by the PRAGMA column check so it runs exactly once on both
// the container and D1 (deploy-safe), then drop the orphaned priorities table
// and the leftover admin setting rows.
//
// Lives outside modules/tasks/index.js so the test harness can apply the exact
// same migration without pulling in the ws/realtime module graph.
export async function ensureTaskSchemaCleanup(db) {
  const res = await db.prepare(`PRAGMA table_info("tasks")`).all();
  const cols = (Array.isArray(res) ? res : res.results ?? []);
  if (cols.some((c) => c.name === "priority_id")) {
    // tasks is the FK parent of task_assignees / task_occurrences, so suspend
    // FK enforcement around the DROP (same pattern SQLite's own tooling uses).
    await db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE __new_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        category_id INTEGER REFERENCES task_categories(id) ON DELETE SET NULL,
        due_at TEXT,
        requires_adult_review INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        reviewed_at TEXT,
        recurrence_type TEXT,
        recurrence_interval INTEGER NOT NULL DEFAULT 1,
        recurrence_period TEXT,
        recurrence_days_of_week TEXT,
        recurrence_start_date TEXT,
        recurrence_end_date TEXT,
        recurrence_count INTEGER,
        due_time TEXT,
        icon TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO __new_tasks
        (id, name, description, category_id, due_at, requires_adult_review, completed_at, reviewed_at,
         recurrence_type, recurrence_interval, recurrence_period, recurrence_days_of_week,
         recurrence_start_date, recurrence_end_date, recurrence_count, due_time, icon, created_at)
        SELECT id, name, description, category_id, due_at, requires_adult_review, completed_at, reviewed_at,
         recurrence_type, recurrence_interval, recurrence_period, recurrence_days_of_week,
         recurrence_start_date, recurrence_end_date, recurrence_count, due_time, icon, created_at
        FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE __new_tasks RENAME TO tasks;
      PRAGMA foreign_keys = ON;
    `);
  }
  await db.exec("DROP TABLE IF EXISTS task_priorities");
  await db.exec("DELETE FROM settings WHERE key IN ('tasks_enable_priorities', 'tasks_enable_dollar')");
}