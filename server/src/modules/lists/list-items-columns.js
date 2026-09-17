// Databases created before the checked-item auto-cleanup feature lack
// list_items.checked_at (when the item was checked — the clock behind the
// auto-delete job) and list_items.deleted_at (soft-delete marker, so checked
// items can be tombstoned instead of hard-deleted on an hourly timer).
// SQLite can ADD COLUMN in place, so add them guarded by a PRAGMA check —
// deploy-safe on D1 and better-sqlite3 (runs exactly once per existing DB).
//
// Standalone .js (like task-occurrences-table.js) so the test harness can
// apply the same migration without pulling in a TS/import graph.
async function tableHasColumn(db, table, column) {
  const stmt = db.prepare(`PRAGMA table_info("${table}")`);
  const res = await stmt.all();
  const rows = (Array.isArray(res)
    ? res
    : res && typeof res === "object" && "results" in res ? res.results : []) ?? [];
  return rows.some((r) => r && r.name === column);
}

export async function ensureListItemsColumns(db) {
  const columns = ["checked_at", "deleted_at"];
  for (const column of columns) {
    if (await tableHasColumn(db, "list_items", column)) continue;
    await db.exec(`ALTER TABLE list_items ADD COLUMN ${column} TEXT`);
  }
}