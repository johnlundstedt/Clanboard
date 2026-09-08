import express from "express";
import { db } from "../../db.js";
import { broadcastMealPlan } from "../../realtime.js";
import { requireCap } from "../../caps.js";

const SLOTS = ["breakfast", "lunch", "dinner", "snack"];

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meal_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,             -- YYYY-MM-DD
      meal_slot TEXT NOT NULL,        -- breakfast | lunch | dinner | snack
      text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, meal_slot)
    );
  `);
}

const router = express.Router();

// Get the meal plan for a week. `start` is the Monday date (YYYY-MM-DD).
router.get("/week", (req, res) => {
  const start = req.query.start;
  if (!start) return res.status(400).json({ error: "start (YYYY-MM-DD) is required" });

  const end = new Date(`${start}T12:00:00`);
  end.setDate(end.getDate() + 6);
  const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;

  const rows = db.prepare(`
    SELECT * FROM meal_plan
    WHERE date >= ? AND date <= ?
    ORDER BY date
  `).all(start, endStr);

  res.json({ start, end: endStr, entries: rows, slots: SLOTS });
});

// Upsert a single meal slot entry (free text). Empty text clears the entry.
// Only members whose role allows editing the meal plan can modify it.
router.put("/:date/:slot", requireCap("meal-plan", "edit"), (req, res) => {
  const { date, slot } = req.params;
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: "invalid meal slot" });

  const text = (req.body.text || "").trim();

  if (!text) {
    db.prepare("DELETE FROM meal_plan WHERE date = ? AND meal_slot = ?").run(date, slot);
  } else {
    db.prepare(`
      INSERT INTO meal_plan (date, meal_slot, text) VALUES (?, ?, ?)
      ON CONFLICT(date, meal_slot) DO UPDATE SET text = excluded.text
    `).run(date, slot, text);
  }

  broadcastMealPlan();
  res.json({ ok: true });
});

export default {
  name: "meal-plan",
  navLabel: "Meals",
  migrate,
  router,
};