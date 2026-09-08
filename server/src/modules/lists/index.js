import express from "express";
import { db } from "../../db.js";
import { broadcastList } from "../../realtime.js";
import { requireCap } from "../../caps.js";

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      added_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed a default "Groceries" list if none exist yet
  const count = db.prepare("SELECT COUNT(*) AS c FROM lists").get().c;
  if (count === 0) {
    db.prepare("INSERT INTO lists (name) VALUES ('Groceries')").run();
  }
}

const router = express.Router();

router.get("/", (req, res) => {
  const lists = db.prepare("SELECT * FROM lists ORDER BY id").all();
  for (const list of lists) {
    list.items = db
      .prepare("SELECT * FROM list_items WHERE list_id = ? ORDER BY id")
      .all(list.id);
  }
  res.json(lists);
});

router.post("/:listId/items", requireCap("lists", "add_items"), (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  const info = db
    .prepare("INSERT INTO list_items (list_id, text) VALUES (?, ?)")
    .run(req.params.listId, text.trim());
  const item = db
    .prepare("SELECT * FROM list_items WHERE id = ?")
    .get(info.lastInsertRowid);
  broadcastList();
  res.status(201).json(item);
});

router.patch("/items/:itemId", requireCap("lists", "complete_items"), (req, res) => {
  const { checked } = req.body;
  db.prepare("UPDATE list_items SET checked = ? WHERE id = ?").run(
    checked ? 1 : 0,
    req.params.itemId
  );
  broadcastList();
  res.json({ ok: true });
});

router.delete("/items/:itemId", requireCap("lists", "remove_items"), (req, res) => {
  db.prepare("DELETE FROM list_items WHERE id = ?").run(req.params.itemId);
  broadcastList();
  res.status(204).end();
});

router.post("/", requireCap("lists", "create_lists"), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const info = db.prepare("INSERT INTO lists (name) VALUES (?)").run(name.trim());
  const list = db.prepare("SELECT * FROM lists WHERE id = ?").get(info.lastInsertRowid);
  list.items = [];
  broadcastList();
  res.status(201).json(list);
});

router.delete("/:listId", requireCap("lists", "delete_lists"), (req, res) => {
  db.prepare("DELETE FROM lists WHERE id = ?").run(req.params.listId);
  broadcastList();
  res.status(204).end();
});

export default {
  name: "lists",
  navLabel: "Lists",
  migrate,
  router,
};
