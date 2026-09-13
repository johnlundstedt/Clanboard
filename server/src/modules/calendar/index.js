import { Hono } from "hono";
import { notifyCalendar } from "../../web/events.js";
import { containerDb } from "../../core/container-db.js";
import { numParam, readJson, respond } from "../../web/helpers.js";
import * as core from "../../core/calendar.js";

async function migrate(db) {
  await db.exec(`
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

const app = new Hono();

// --- Connections (admin-managed) ---------------------------------------------
app.get("/connections", (c) => respond(c, () => core.listConnections(containerDb)));

app.post("/connections", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const conn = await core.createConnection(containerDb, body);
    // Fire-and-forget first sync; the result surfaces in GET /sync runs.
    core.syncConnection(containerDb, conn).catch(() => {});
    return conn;
  }, { status: 201 })
);

app.patch("/connections/:id", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    return core.updateConnection(containerDb, numParam(c, "id"), body);
  })
);

app.delete("/connections/:id", (c) =>
  respond(c, async () => {
    await core.deleteConnection(containerDb, numParam(c, "id"));
    notifyCalendar();
    return null;
  }, { status: 204 })
);

// --- Events (read-only cache) ------------------------------------------------
app.get("/", (c) =>
  respond(c, () =>
    core.getEvents(containerDb, c.req.query("start") || new Date().toISOString(), c.req.query("end"))
  )
);

app.post("/sync", (c) =>
  respond(c, async () => {
    const result = await core.runSyncAll(containerDb);
    notifyCalendar();
    return { ok: true, counts: result.counts, errors: result.errors };
  })
);

const jobs = [
  {
    name: "google-calendar-sync",
    intervalMs: 15 * 60 * 1000,
    run: async () => {
      const result = await core.runSyncAll(containerDb);
      notifyCalendar();
      return result;
    },
  },
];

export default {
  name: "calendar",
  navLabel: "Calendar",
  migrate,
  app,
  jobs,
};