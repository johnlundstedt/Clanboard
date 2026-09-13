import { Hono } from "hono";
import { notifyList } from "../../web/events.js";
import { containerDb } from "../../core/container-db.js";
import { numParam, readJson, requireCap, respond } from "../../web/helpers.js";
import * as core from "../../core/lists.js";

async function migrate(db) {
  await db.exec(`
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
  const count = (await db.prepare("SELECT COUNT(*) AS c FROM lists").get()).c;
  if (count === 0) {
    await db.prepare("INSERT INTO lists (name) VALUES ('Groceries')").run();
  }
}

const app = new Hono();

app.get("/", (c) => respond(c, () => core.listLists(containerDb)));

app.post("/:listId/items", requireCap(containerDb, "lists", "add_items"), (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const item = await core.addItem(containerDb, numParam(c, "listId"), body.text);
    notifyList();
    return item;
  }, { status: 201 })
);

app.patch("/items/:itemId", requireCap(containerDb, "lists", "complete_items"), (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const out = await core.toggleItem(containerDb, numParam(c, "itemId"), body.checked);
    notifyList();
    return out;
  })
);

app.delete("/items/:itemId", requireCap(containerDb, "lists", "remove_items"), (c) =>
  respond(c, async () => {
    await core.removeItem(containerDb, numParam(c, "itemId"));
    notifyList();
    return null;
  }, { status: 204 })
);

app.post("/", requireCap(containerDb, "lists", "create_lists"), (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const list = await core.createList(containerDb, body.name);
    notifyList();
    return list;
  }, { status: 201 })
);

app.delete("/:listId", requireCap(containerDb, "lists", "delete_lists"), (c) =>
  respond(c, async () => {
    await core.deleteList(containerDb, numParam(c, "listId"));
    notifyList();
    return null;
  }, { status: 204 })
);

export default {
  name: "lists",
  navLabel: "Lists",
  migrate,
  app,
};