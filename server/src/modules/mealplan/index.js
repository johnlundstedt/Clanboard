import { Hono } from "hono";
import { notifyMealPlan } from "../../web/events.js";
import { containerDb } from "../../core/container-db.js";
import { readJson, requireCap, respond } from "../../web/helpers.js";
import * as core from "../../core/mealplan.js";

async function migrate(db) {
  await db.exec(`
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

const app = new Hono();

// Get the meal plan for a week. `start` is the Monday date (YYYY-MM-DD).
app.get("/week", (c) => respond(c, () => core.getWeek(containerDb, c.req.query("start"))));

// Upsert a single meal slot entry (free text). Empty text clears the entry.
// Only members whose role allows editing the meal plan can modify it.
app.put("/:date/:slot", requireCap(containerDb, "meal-plan", "edit"), (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const out = await core.setEntry(containerDb, c.req.param("date"), c.req.param("slot"), body.text);
    notifyMealPlan();
    return out;
  })
);

export default {
  name: "meal-plan",
  navLabel: "Meals",
  migrate,
  app,
};