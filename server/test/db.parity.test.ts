import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../src/schema.js";
import {
  closeD1,
  makeD1Database,
  makeSqliteDatabase,
  type TestDatabase,
} from "./helpers/db.js";

// The same schema migration and the same Drizzle queries must behave the same
// on the container backend (better-sqlite3) and the Cloudflare backend (D1).

const backends = [
  { name: "sqlite", make: makeSqliteDatabase },
  { name: "d1", make: makeD1Database },
];

afterAll(async () => {
  await closeD1();
});

for (const backend of backends) {
  describe(`backend: ${backend.name}`, () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await backend.make();
    });

    afterAll(async () => {
      await db.close();
    });

    beforeEach(async () => {
      if (backend.name === "d1") {
        // Fresh Miniflare D1 binding per test: the sync bridge desyncs
        // intermittently in a long-lived host process (id-mismatch assert).
        await closeD1();
        db = await backend.make();
      } else {
        await db.reset();
      }
    });

    it("creates the full table set from the generated migration", async () => {
      const rows = await db.queryAll(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      );
      const tables = new Set(rows.map((r) => String(r.name)));
      for (const t of [
        "users", "member_roles", "role_modules", "modules", "settings",
        "user_modules", "sessions", "task_categories", "task_priorities",
        "tasks", "task_assignees", "lists", "list_items", "meal_plan",
        "calendar_connections", "calendar_cache",
      ]) {
        expect(tables).toContain(t);
      }
    });

    it("round-trips a user with boolean flags and a role", async () => {
      const [role] = await db.db
        .insert(s.membersRoles)
        .values({ name: "Parent" })
        .returning();
      const id = Number(role.id);

      await db.db.insert(s.users).values({
        name: "Ada",
        birthday: "1990-04-01",
        roleId: id,
        isAdmin: true,
        systemAccount: false,
        navScope: "all",
      });

      const rows = await db.db
        .select()
        .from(s.users)
        .where(eq(s.users.name, "Ada"));

      expect(rows.length).toBe(1);
      expect(rows[0].isAdmin).toBe(true);
      expect(rows[0].systemAccount).toBe(false);
      expect(rows[0].roleId).toBe(id);
      expect(rows[0].createdAt).toBeTruthy(); // datetime('now') default
    });

    it("cascades deletes through task_assignees", async () => {
      const [user] = await db.db.insert(s.users).values({ name: "Bob" }).returning();
      const [task] = await db.db
        .insert(s.tasks)
        .values({ name: "Take out trash" })
        .returning();

      await db.db.insert(s.taskAssignees).values({
        taskId: Number(task.id),
        userId: Number(user.id),
      });

      await db.db.delete(s.tasks).where(eq(s.tasks.id, Number(task.id)));

      const leftovers = await db.db
        .select()
        .from(s.taskAssignees)
        .where(eq(s.taskAssignees.taskId, Number(task.id)));
      expect(leftovers.length).toBe(0);
    });

    it("enforces the meal_plan (date, meal_slot) uniqueness", async () => {
      await db.db.insert(s.mealPlan).values({ date: "2026-09-10", mealSlot: "dinner", text: "Spaghetti" });
      await expect(
        db.db.insert(s.mealPlan).values({ date: "2026-09-10", mealSlot: "dinner", text: "Pizza" })
      ).rejects.toThrow();
    });

    it.skipIf(backend.name === "d1")(
      "supports a transaction writing multiple tables",
      () => {
        // better-sqlite3 transactions are synchronous. D1 is excluded because
        // miniflare backs D1 with Durable Object storage, which rejects raw SQL
        // BEGIN/COMMIT; real D1 on Workers supports transactions normally.
        db.db.transaction((tx) => {
          tx.insert(s.users).values({ name: "Cara", isKiosk: true }).run();
          tx.insert(s.settings).values({ key: "family_name", value: "Lundstedt" }).run();
        });

        const users = db.db.select().from(s.users).all();
        const setting = db.db
          .select()
          .from(s.settings)
          .where(eq(s.settings.key, "family_name"))
          .all();
        expect(users.length).toBe(1);
        expect(setting[0].value).toBe("Lundstedt");
      }
    );

    it("rejects duplicate junction rows (task_assignees composite PK)", async () => {
      const [user] = await db.db.insert(s.users).values({ name: "Dan" }).returning();
      const [task] = await db.db
        .insert(s.tasks)
        .values({ name: "Water plants" })
        .returning();
      const values = { taskId: Number(task.id), userId: Number(user.id) };
      await db.db.insert(s.taskAssignees).values(values);
      await expect(db.db.insert(s.taskAssignees).values(values)).rejects.toThrow();
    });
  });
}