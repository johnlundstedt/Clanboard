// Minimal express-session store backed by the SQLite `sessions` table.
// Keeps logins alive across server restarts (single process, WAL db).
import session from "express-session";
import { db } from "./db.js";

export default class SqliteStore extends session.Store {
  constructor() {
    super();
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        data TEXT,
        expires_at INTEGER
      );
    `);
  }

  get(sid, callback) {
    const row = db.prepare("SELECT data, expires_at FROM sessions WHERE sid = ?").get(sid);
    if (!row) return callback(null, null);
    if (row.expires_at && Date.now() > row.expires_at) {
      db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      return callback(null, null);
    }
    try {
      callback(null, JSON.parse(row.data));
    } catch {
      callback(null, null);
    }
  }

  set(sid, session, callback) {
    const ttl = session.cookie?.maxAge || 30 * 24 * 3600 * 1000;
    const expiresAt = Date.now() + ttl;
    db.prepare(`
      INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
    `).run(sid, JSON.stringify(session), expiresAt);
    callback?.(null);
  }

  destroy(sid, callback) {
    db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
    callback?.(null);
  }

  touch(sid, session, callback) {
    const ttl = session.cookie?.maxAge || 30 * 24 * 3600 * 1000;
    db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?").run(Date.now() + ttl, sid);
    callback?.(null);
  }
}