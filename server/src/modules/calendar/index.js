import express from "express";
import { db } from "../../db.js";
import { broadcast } from "../../realtime.js";

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'google',
      label TEXT,
      calendar_id TEXT NOT NULL,      -- Google Calendar ID, e.g. primary or an email-address id
      api_key TEXT,                   -- optional Google API key for read-only access
      color TEXT,                     -- display color for this calendar
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calendar_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      summary TEXT,
      location TEXT,
      description TEXT,
      start_at TEXT,                  -- ISO 8601 (RFC3339)
      end_at TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      UNIQUE(connection_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_cache_start ON calendar_cache(start_at);
  `);
}

const router = express.Router();

// --- Connections (admin-managed) ---------------------------------------------
router.get("/connections", (req, res) => {
  const conns = db.prepare("SELECT * FROM calendar_connections ORDER BY id").all();
  res.json(conns);
});

router.post("/connections", (req, res) => {
  const { provider, label, calendar_id, api_key, color } = req.body;
  if (!calendar_id || !calendar_id.trim()) {
    return res.status(400).json({ error: "calendar_id is required" });
  }
  const info = db.prepare(`
    INSERT INTO calendar_connections (provider, label, calendar_id, api_key, color)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    provider || "google",
    label || null,
    calendar_id.trim(),
    api_key || null,
    color || null
  );
  const conn = db.prepare("SELECT * FROM calendar_connections WHERE id = ?").get(info.lastInsertRowid);
  syncConnection(conn).catch(() => {});
  res.status(201).json(conn);
});

router.patch("/connections/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM calendar_connections WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const { label, calendar_id, api_key, color, enabled } = req.body;
  db.prepare(`
    UPDATE calendar_connections SET label = ?, calendar_id = ?, api_key = ?, color = ?, enabled = ?
    WHERE id = ?
  `).run(
    label !== undefined ? label : existing.label,
    calendar_id !== undefined ? calendar_id : existing.calendar_id,
    api_key !== undefined ? api_key : existing.api_key,
    color !== undefined ? color : existing.color,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete("/connections/:id", (req, res) => {
  db.prepare("DELETE FROM calendar_connections WHERE id = ?").run(req.params.id);
  broadcast("calendar");
  res.status(204).end();
});

// --- Events (read-only cache) ------------------------------------------------
router.get("/", (req, res) => {
  const start = req.query.start || new Date().toISOString();
  const end = req.query.end;

  let sql = `
    SELECT calendar_cache.*, calendar_connections.label AS calendar_label
    FROM calendar_cache
    JOIN calendar_connections ON calendar_connections.id = calendar_cache.connection_id
    WHERE calendar_cache.start_at >= ? AND calendar_connections.enabled = 1
  `;
  const params = [start];
  if (end) {
    sql += " AND calendar_cache.start_at < ?";
    params.push(end);
  }
  sql += " ORDER BY calendar_cache.start_at";

  const events = db.prepare(sql).all(...params);
  res.json(events);
});

router.post("/sync", (req, res) => {
  runSyncAll()
    .then(({ counts, errors }) => res.json({ ok: true, counts, errors }))
    .catch((err) => res.status(500).json({ error: err.message }));
});

// --- Google Calendar sync -----------------------------------------------------
async function fetchEvents(conn, timeMin, timeMax) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id)}/events`);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("maxResults", "250");
  if (conn.api_key) url.searchParams.set("key", conn.api_key);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Calendar ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.items || [];
}

function isAllDay(item) {
  return !!item.start?.date;
}

function normalizeStart(item) {
  if (item.start?.date) return `${item.start.date}T00:00:00`;
  return item.start?.dateTime || item.start?.date || null;
}

function normalizeEnd(item) {
  if (item.end?.date) return `${item.end.date}T00:00:00`;
  return item.end?.dateTime || item.end?.date || null;
}

async function syncConnection(conn) {
  if (!conn.enabled) return { skipped: 0 };

  const timeMin = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

  let items;
  try {
    items = await fetchEvents(conn, timeMin, timeMax);
  } catch (err) {
    // Leave cache intact on transient failure; admin sees error in sync result
    console.error(`[calendar] sync ${conn.id} (${conn.calendar_id}):`, err.message);
    return { skipped: 0, error: err.message };
  }

  const upsert = db.prepare(`
    INSERT INTO calendar_cache
      (connection_id, event_id, summary, location, description, start_at, end_at, all_day, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connection_id, event_id) DO UPDATE SET
      summary = excluded.summary,
      location = excluded.location,
      description = excluded.description,
      start_at = excluded.start_at,
      end_at = excluded.end_at,
      all_day = excluded.all_day,
      color = excluded.color
  `);
  const seen = new Set();
  for (const item of items) {
    if (!isAllDay(item) && !item.start?.dateTime) continue;
    seen.add(item.id);
    upsert.run(
      conn.id,
      item.id,
      item.summary || "(untitled)",
      item.location || null,
      item.description || null,
      normalizeStart(item),
      normalizeEnd(item),
      isAllDay(item) ? 1 : 0,
      item.colorId || conn.color || null
    );
  }

  // Remove events that disappeared from the source within our window
  if (seen.size > 0) {
    const placeholders = [...seen].map(() => "?").join(",");
    db.prepare(`DELETE FROM calendar_cache WHERE connection_id = ? AND event_id NOT IN (${placeholders})`).run(conn.id, ...seen);
  }

  broadcast("calendar");
  return { inserted: seen.size };
}

async function runSyncAll() {
  const conns = db.prepare("SELECT * FROM calendar_connections WHERE enabled = 1").all();
  const counts = [];
  const errors = [];
  for (const conn of conns) {
    const result = await syncConnection(conn);
    counts.push({ id: conn.id, calendar_id: conn.calendar_id, ...result });
    if (result.error) errors.push(result.error);
  }
  return { counts, errors };
}

const jobs = [
  {
    name: "google-calendar-sync",
    intervalMs: 15 * 60 * 1000,
    run: runSyncAll,
  },
];

export default {
  name: "calendar",
  navLabel: "Calendar",
  migrate,
  router,
  jobs,
};