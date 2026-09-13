import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../src/schema.js";
import * as core from "../src/core/tasks.js";
import { addDays, todayStr } from "../src/modules/tasks/recurrence.js";
import {
  closeD1,
  makeD1Database,
  makeSqliteDatabase,
  type TestDatabase,
} from "./helpers/db.js";

// The tasks business logic (core/tasks.ts) is the first module ported off raw
// SQL. These parity tests run the SAME functions against better-sqlite3 and D1
// so behaviour is proven identical before the framework swap.

const backends = [
  { name: "sqlite", make: makeSqliteDatabase },
  { name: "d1", make: makeD1Database },
];

afterAll(async () => {
  await closeD1();
});

function snakeUser(u: typeof s.users.$inferSelect, extra: Partial<{ role_id: number | null }> = {}) {
  return {
    id: u.id,
    role_id: extra.role_id !== undefined ? extra.role_id : u.roleId,
    is_admin: u.isAdmin as unknown as boolean,
    is_kiosk: u.isKiosk as unknown as boolean,
  };
}

async function seedCategory(db: TestDatabase, opts: { name?: string; is_default?: boolean } = {}) {
  const [c] = await db.db
    .insert(s.taskCategories)
    .values({ name: opts.name ?? "Chores", isDefault: opts.is_default ?? true })
    .returning()
    .all();
  return c;
}

async function seedPriority(db: TestDatabase, name = "High") {
  const [p] = await db.db.insert(s.taskPriorities).values({ name, sort: 1 }).returning().all();
  return p;
}

async function seedUser(
  db: TestDatabase,
  opts: { name?: string; is_admin?: boolean; role_id?: number | null } = {}
) {
  const [u] = await db.db
    .insert(s.users)
    .values({
      name: opts.name ?? "Ada",
      isAdmin: opts.is_admin ?? false,
      roleId: opts.role_id ?? null,
    })
    .returning()
    .all();
  return u;
}

for (const backend of backends) {
  describe(`core/tasks (${backend.name})`, () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await backend.make();
    });

    afterAll(async () => {
      await db.close();
    });

    beforeEach(async () => {
      if (backend.name === "d1") {
        // Miniflare's sync D1 bridge can desync within a long-lived process
        // (intermittent id-mismatch assertion). A fresh binding per test gives
        // each D1 test an isolated, race-free bridge; sqlite just truncates.
        await closeD1();
        db = await backend.make();
      } else {
        await db.reset();
      }
    });

    it("creates a task with assignees and returns the wire shape", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const bob = await seedUser(db, { name: "Bob" });
      const cat = await seedCategory(db);
      const pri = await seedPriority(db);
      const user = snakeUser(admin);

      const task = await core.createTask(db.db, user, {
        name: "Take out trash",
        description: "before Tuesday",
        category_id: cat.id,
        priority_id: pri.id,
        due_at: "2026-09-12",
        assigned_ids: [bob.id],
        icon: "trash",
      });

      expect(task.name).toBe("Take out trash");
      expect(task.category_id).toBe(cat.id);
      expect(task.category_name).toBe("Chores");
      expect(task.priority_name).toBe("High");
      expect(task.requires_adult_review).toBe(0);
      expect(task.assignees).toEqual([{ id: bob.id, name: "Bob" }]);
      expect(task.assigned_to).toBe(bob.id);

      const listed = await core.listTasks(db.db, user);
      expect(listed.length).toBe(1);
      expect(listed[0].assignees).toEqual([{ id: bob.id, name: "Bob" }]);
    });

    it("quick-add auto-assigns an icon and the default category", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      await seedCategory(db, { name: "Chores", is_default: true });
      const task = await core.quickAddTask(db.db, snakeUser(admin), { name: "Wash the dishes" });
      expect(task.icon).toBe("shirt");
      expect(task.category_id).not.toBeNull();
    });

    it("rejects a missing name", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      await expect(
        core.createTask(db.db, snakeUser(admin), { name: "  " })
      ).rejects.toMatchObject({ status: 400 });
    });

    it("requires create_unassigned (or an assignee) for quick-add", async () => {
      // Role with task caps but no create_unassigned
      const [role] = await db.db.insert(s.membersRoles).values({ name: "Kid" }).returning().all();
      await db.db.insert(s.roleModules).values({
        roleId: role.id,
        name: "tasks",
        caps: JSON.stringify({ create: true, create_unassigned: false, assign_self: true }),
      });
      const kid = await seedUser(db, { name: "Kid", role_id: role.id });

      await expect(
        core.quickAddTask(db.db, snakeUser(kid), { name: "Math homework" })
      ).rejects.toMatchObject({ status: 403 });

      // Assigning to self works
      const task = await core.quickAddTask(db.db, snakeUser(kid), {
        name: "Math homework",
        assigned_ids: [kid.id],
      });
      expect(task.assigned_to).toBe(kid.id);
    });

    it("categories: default uniqueness and name conflict", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const first = await core.createCategory(db.db, { name: "Chores", is_default: true });
      const second = await core.createCategory(db.db, { name: "School", is_default: true });

      expect(first.is_default).toBe(1);
      expect(second.is_default).toBe(1);
      const cats = await core.listCategories(db.db);
      expect(cats.find((c) => c.id === first.id)!.is_default).toBe(0);
      expect(cats.find((c) => c.id === second.id)!.is_default).toBe(1);

      // Name lookup is exact-match (SQLite binary collation), like the old raw
      // handler: differing case is a distinct category, an exact duplicate is not.
      const diffCase = await core.createCategory(db.db, { name: "chores" });
      expect(diffCase.id).toBeGreaterThan(second.id);
      await expect(core.createCategory(db.db, { name: "chores" })).rejects.toMatchObject({ status: 400 });
    });

    it("priorities auto-increment sort order", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const low = await core.createPriority(db.db, { name: "Low" });
      const high = await core.createPriority(db.db, { name: "High" });
      expect(high.sort).toBeGreaterThan(low.sort);
      await core.updatePriority(db.db, high.id, { name: "Urgent" });
      const ups = await core.listPriorities(db.db);
      expect(ups.find((p) => p.id === high.id)!.name).toBe("Urgent");
    });

    it("complete/rollover of a repeating task keeps recurrence fields", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const task = await core.createTask(db.db, user, {
        name: "Feed the cat",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: "2026-09-01",
        due_at: "2026-09-10",
        assigned_ids: [admin.id],
      });
      // Admin can complete anyone's task, so completion works regardless.
      expect(await core.completeTask(db.db, user, task.id)).toEqual({ ok: true });
      const rows = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      // Daily tasks roll one day forward **from today** (legacy behaviour), so
      // the expected date is derived from the clock rather than due_at.
      expect(rows[0].dueAt).toBe(addDays(todayStr(), 1));
      expect(rows[0].completedAt).toBeNull();
      expect(rows[0].recurrenceType).toBe("daily");
    });

    it("list respects view_others and member scoping", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      // Alice gets a role that grants the tasks module but NOT view_others.
      const [role] = await db.db.insert(s.membersRoles).values({ name: "Scoped" }).returning().all();
      await db.db.insert(s.roleModules).values({
        roleId: role.id,
        name: "tasks",
        caps: JSON.stringify({ view_others: false, create: true, create_unassigned: true }),
      });
      const alice = await seedUser(db, { name: "Alice", role_id: role.id });
      const bob = await seedUser(db, { name: "Bob" });

      await core.createTask(db.db, snakeUser(admin), { name: "For Alice", assigned_ids: [alice.id] });
      await core.createTask(db.db, snakeUser(admin), { name: "For Bob", assigned_ids: [bob.id] });

      // Member without view_others can't list another member's tasks
      await expect(
        core.listTasks(db.db, snakeUser(alice), { user_id: String(bob.id) })
      ).rejects.toMatchObject({ status: 403 });

      // ... but sees their own
      const mine = await core.listTasks(db.db, snakeUser(alice));
      expect(mine.map((t) => t.name)).toEqual(["For Alice"]);

      // Admin sees all
      const all = await core.listTasks(db.db, snakeUser(admin));
      expect(all.length).toBe(2);
    });

    it("tasksToday separates due and unassigned", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const bob = await seedUser(db, { name: "Bob" });

      await core.createTask(db.db, user, { name: "Due today", due_at: "2026-09-10", assigned_ids: [bob.id] });
      await core.createTask(db.db, user, { name: "Unassigned", due_at: "2026-09-10" });

      const out = await core.tasksToday(db.db, "2026-09-10");
      expect(out.dueToday.map((t) => t.name)).toEqual(["Due today", "Unassigned"]);
      expect(out.unassigned.map((t) => t.name)).toEqual(["Unassigned"]);
    });

    it("assign replaces assignees; delete cascades junction rows", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const a = await seedUser(db, { name: "A" });
      const b = await seedUser(db, { name: "B" });
      const user = snakeUser(admin);

      const task = await core.createTask(db.db, user, { name: "Chore", assigned_ids: [a.id] });
      expect(task.assigned_to).toBe(a.id);

      await core.assignTask(db.db, user, task.id, { user_ids: [b.id, a.id] });
      const listed = await core.listTasks(db.db, user);
      expect(listed[0].assignees!.map((x) => x.id).sort()).toEqual([a.id, b.id]);

      await core.deleteTask(db.db, user, task.id);
      const leftovers = await db.db
        .select()
        .from(s.taskAssignees)
        .where(eq(s.taskAssignees.taskId, task.id))
        .all();
      expect(leftovers.length).toBe(0);
    });
  });
}