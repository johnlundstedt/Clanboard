import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../src/schema.js";
import * as meals from "../src/core/mealplan.js";
import * as listsCore from "../src/core/lists.js";
import {
  closeD1,
  makeD1Database,
  makeSqliteDatabase,
  type TestDatabase,
} from "./helpers/db.js";

// mealplan + lists cores, exercised against both backends so container (SQLite)
// and Cloudflare (D1) behaviour is proven identical.

const backends = [
  { name: "sqlite", make: makeSqliteDatabase },
  { name: "d1", make: makeD1Database },
];

afterAll(async () => {
  await closeD1();
});

for (const backend of backends) {
  describe(`core/mealplan (${backend.name})`, () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await backend.make();
    });

    afterAll(async () => {
      await db.close();
    });

    beforeEach(async () => {
      if (backend.name === "d1") {
        await closeD1();
        db = await backend.make();
      } else {
        await db.reset();
      }
    });

    it("rejects a missing start date", async () => {
      await expect(meals.getWeek(db.db, undefined)).rejects.toMatchObject({ status: 400 });
    });

    it("returns empty entries with slot list and a computed week end", async () => {
      const week = await meals.getWeek(db.db, "2026-09-07");
      expect(week.slots).toEqual(["breakfast", "lunch", "dinner", "snack"]);
      expect(week.end).toBe("2026-09-13");
      expect(week.entries).toEqual([]);
    });

    it("upserts entries and exposes the wire shape", async () => {
      await meals.setEntry(db.db, "2026-09-07", "dinner", "Spaghetti");
      await meals.setEntry(db.db, "2026-09-07", "lunch", "Soup");

      const week = await meals.getWeek(db.db, "2026-09-07");
      expect(week.entries.length).toBe(2);
      const dinner = week.entries.find((e) => e.meal_slot === "dinner");
      expect(dinner).toMatchObject({ date: "2026-09-07", meal_slot: "dinner", text: "Spaghetti" });
      expect(dinner!.created_at).toBeTruthy();

      // Upsert replaces, doesn't duplicate
      await meals.setEntry(db.db, "2026-09-07", "dinner", "Pizza");
      const again = await meals.getWeek(db.db, "2026-09-07");
      expect(again.entries.filter((e) => e.meal_slot === "dinner")).toHaveLength(1);
      expect(again.entries.find((e) => e.meal_slot === "dinner")!.text).toBe("Pizza");

      // Empty text clears the entry
      await meals.setEntry(db.db, "2026-09-07", "dinner", "   ");
      const cleared = await meals.getWeek(db.db, "2026-09-07");
      expect(cleared.entries.filter((e) => e.meal_slot === "dinner")).toHaveLength(0);
    });

    it("rejects an invalid slot", async () => {
      await expect(meals.setEntry(db.db, "2026-09-07", "brunch", "x")).rejects.toMatchObject({
        status: 400,
      });
    });

    it("only returns entries inside the requested week", async () => {
      await meals.setEntry(db.db, "2026-09-06", "breakfast", "Sunday cereal");
      await meals.setEntry(db.db, "2026-09-07", "breakfast", "Monday oats");
      const week = await meals.getWeek(db.db, "2026-09-07");
      expect(week.entries.map((e) => e.date)).toEqual(["2026-09-07"]);
    });
  });

  describe(`core/lists (${backend.name})`, () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await backend.make();
    });

    afterAll(async () => {
      await db.close();
    });

    beforeEach(async () => {
      if (backend.name === "d1") {
        await closeD1();
        db = await backend.make();
      } else {
        await db.reset();
      }
    });

    it("starts empty; createList returns the snake_case wire shape", async () => {
      expect(await listsCore.listLists(db.db)).toEqual([]);
      const list = await listsCore.createList(db.db, "Groceries");
      expect(list).toMatchObject({ name: "Groceries", items: [] });
      expect(list.id).toBeGreaterThan(0);

      const all = await listsCore.listLists(db.db);
      expect(all).toHaveLength(1);
      expect(all[0].items).toEqual([]);
    });

    it("rejects a blank list name", async () => {
      await expect(listsCore.createList(db.db, "   ")).rejects.toMatchObject({ status: 400 });
    });

    it("addItem returns the wire shape and listLists nests items in order", async () => {
      const list = await listsCore.createList(db.db, "Groceries");
      const item = await listsCore.addItem(db.db, list.id, "Milk");
      expect(item).toMatchObject({ list_id: list.id, text: "Milk", checked: 0 });

      await listsCore.addItem(db.db, list.id, "Eggs");
      const all = await listsCore.listLists(db.db);
      expect(all[0].items!.map((i) => i.text)).toEqual(["Milk", "Eggs"]);

      const milk = all[0].items!.find((i) => i.text === "Milk")!;
      expect(milk.checked).toBe(0);
      expect(milk.created_at).toBeTruthy();
    });

    it("rejects addItem without text or to a missing list", async () => {
      await expect(listsCore.addItem(db.db, 999, "x")).rejects.toMatchObject({ status: 404 });
      const list = await listsCore.createList(db.db, "Groceries");
      await expect(listsCore.addItem(db.db, list.id, "  ")).rejects.toMatchObject({ status: 400 });
    });

    it("toggleItem flips checked; removeItem deletes", async () => {
      const list = await listsCore.createList(db.db, "Groceries");
      const item = await listsCore.addItem(db.db, list.id, "Milk");

      await listsCore.toggleItem(db.db, item.id, true);
      let all = await listsCore.listLists(db.db);
      expect(all[0].items![0].checked).toBe(1);

      await listsCore.toggleItem(db.db, item.id, false);
      all = await listsCore.listLists(db.db);
      expect(all[0].items![0].checked).toBe(0);

      await listsCore.removeItem(db.db, item.id);
      all = await listsCore.listLists(db.db);
      expect(all[0].items).toEqual([]);
      const rows = await db.queryAll("SELECT * FROM list_items");
      expect(rows).toHaveLength(0);
    });

    it("deleteList removes the list", async () => {
      const list = await listsCore.createList(db.db, "Groceries");
      await listsCore.addItem(db.db, list.id, "Milk");
      await listsCore.deleteList(db.db, list.id);
      expect(await listsCore.listLists(db.db)).toEqual([]);
    });

    it("toggleItem stamps checked_at on check and clears it on uncheck", async () => {
      const list = await listsCore.createList(db.db, "Groceries");
      const item = await listsCore.addItem(db.db, list.id, "Milk");

      await listsCore.toggleItem(db.db, item.id, true);
      const [checked] = await db.queryAll("SELECT * FROM list_items WHERE id = " + item.id);
      expect(checked.checked_at).toBeTruthy();

      await listsCore.toggleItem(db.db, item.id, false);
      const [unchecked] = await db.queryAll("SELECT * FROM list_items WHERE id = " + item.id);
      expect(unchecked.checked_at).toBeNull();
    });

    it("deleteCheckedItemsOlderThan soft-deletes only stale checked items", async () => {
      const list = await listsCore.createList(db.db, "Groceries");
      const stale = await listsCore.addItem(db.db, list.id, "Stale");
      const fresh = await listsCore.addItem(db.db, list.id, "Fresh");
      const open = await listsCore.addItem(db.db, list.id, "Open");

      await listsCore.toggleItem(db.db, stale.id, true);
      await listsCore.toggleItem(db.db, fresh.id, true);
      await db.db
        .update(s.listItems)
        .set({ checkedAt: sql`datetime('now', '-2 hours')` })
        .where(eq(s.listItems.id, stale.id))
        .run();

      const removed = await listsCore.deleteCheckedItemsOlderThan(db.db, 60);
      expect(removed).toBe(1);

      const all = await listsCore.listLists(db.db);
      expect(all[0].items!.map((i) => i.text)).toEqual(["Fresh", "Open"]);

      // Tombstoned, not hard-deleted: the row is still in the table.
      const [row] = await db.queryAll("SELECT * FROM list_items WHERE id = " + stale.id);
      expect(row.deleted_at).toBeTruthy();
    });

    it("autoDeleteCheckedItems respects the admin setting + threshold", async () => {
      const list = await listsCore.createList(db.db, "Groceries");
      const item = await listsCore.addItem(db.db, list.id, "Milk");
      await listsCore.toggleItem(db.db, item.id, true);
      await db.db
        .update(s.listItems)
        .set({ checkedAt: sql`datetime('now', '-2 hours')` })
        .where(eq(s.listItems.id, item.id))
        .run();

      // Disabled by default → no-op.
      expect(await listsCore.autoDeleteCheckedItems(db.db)).toBe(0);

      await db.db
        .insert(s.settings)
        .values({ key: "lists_autodelete_enabled", value: "1" })
        .onConflictDoUpdate({ target: s.settings.key, set: { value: "1" } })
        .run();
      await db.db
        .insert(s.settings)
        .values({ key: "lists_autodelete_minutes", value: "60" })
        .onConflictDoUpdate({ target: s.settings.key, set: { value: "60" } })
        .run();

      expect(await listsCore.autoDeleteCheckedItems(db.db)).toBe(1);
      const all = await listsCore.listLists(db.db);
      expect(all[0].items).toEqual([]);
    });
  });
}