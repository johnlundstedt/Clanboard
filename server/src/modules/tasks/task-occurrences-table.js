// Per-instance audit table for repeating tasks: one row per scheduled
// occurrence, materialized ahead of time (completed_at NULL = scheduled but
// not done yet). Keeps both completed and skipped days for later review.
//
// Lives outside modules/tasks/index.js so the test harness can apply the
// exact same migration without pulling in the ws/realtime module graph.
export async function ensureTaskOccurrencesTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS task_occurrences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      occurrence_date TEXT NOT NULL,
      completed_at TEXT,          -- NULL = scheduled / not completed
      completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_occurrences_task_date
      ON task_occurrences(task_id, occurrence_date);
  `);

  // Databases created before the instance model hold completed_at NOT NULL;
  // that column needs to accept NULL (pending instances) and SQLite can't
  // ALTER a column to drop NOT NULL. Rebuild the table in place, guarded by
  // the PRAGMA check so it runs exactly once (deploy-safe on D1 and sqlite).
  const occColsRes = await db.prepare(`PRAGMA table_info("task_occurrences")`).all();
  const occInfo = (Array.isArray(occColsRes) ? occColsRes : occColsRes.results ?? []);
  const completedCol = occInfo.find((c) => c.name === "completed_at");
  if (completedCol && Number(completedCol.notnull) === 1) {
    await db.exec(`
      CREATE TABLE task_occurrences_rebuild (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        occurrence_date TEXT NOT NULL,
        completed_at TEXT,
        completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TEXT
      );
      INSERT INTO task_occurrences_rebuild
        (id, task_id, occurrence_date, completed_at, completed_by, reviewed_at)
        SELECT id, task_id, occurrence_date, completed_at, completed_by, reviewed_at
        FROM task_occurrences;
      DROP TABLE task_occurrences;
      ALTER TABLE task_occurrences_rebuild RENAME TO task_occurrences;
      CREATE UNIQUE INDEX idx_task_occurrences_task_date
        ON task_occurrences(task_id, occurrence_date);
    `);
  }
}