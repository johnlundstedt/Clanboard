import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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

function assigneesOf(hist: ReturnType<typeof core.taskOccurrenceHistory> extends Promise<infer T> ? T : never, taskId: number) {
  return hist.rows.find((r) => r.task_id === taskId)?.assignees ?? [];
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

    it("completing a repeating task keeps its due date and marks the instance", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const dueAt = todayStr();
      const task = await core.createTask(db.db, user, {
        name: "Feed the cat",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: dueAt,
        due_at: dueAt,
        assigned_ids: [admin.id],
      });
      // Admin can complete anyone's task, so completion works regardless.
      expect(await core.completeTask(db.db, user, task.id)).toEqual({ ok: true });
      const rows = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      // No eager roll on the due day: the row stays on today's instance, now completed.
      expect(rows[0].dueAt).toBe(dueAt);
      expect(rows[0].completedAt).toBeTruthy();
      expect(rows[0].recurrenceType).toBe("daily");
      const occ = await db.db
        .select()
        .from(s.taskOccurrences)
        .where(eq(s.taskOccurrences.taskId, task.id))
        .all();
      expect(occ.find((o) => o.completedAt)).toMatchObject({
        occurrenceDate: dueAt,
        completedBy: admin.id,
      });
    });

    it("recurring completion records its instance; uncomplete clears it", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const dueAt = todayStr();
      const task = await core.createTask(db.db, user, {
        name: "Brush teeth",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: dueAt,
        assigned_ids: [admin.id],
      });

      // Materialized ahead: the instance for today is scheduled (pending).
      expect(task.due_at).toBe(dueAt);

      await core.completeTask(db.db, user, task.id);

      const occs = await db.db.select().from(s.taskOccurrences).all();
      expect(occs.filter((o) => o.taskId === task.id && o.completedAt)).toHaveLength(1);
      expect(occs.some((o) => o.occurrenceDate === dueAt && o.completedAt)).toBe(true);

      // The completed row still shows checked today (no roll yet).
      const listed = await core.listTasks(db.db, user);
      expect(listed.find((t) => t.id === task.id)!.completed_at).toBeTruthy();
      expect(listed.find((t) => t.id === task.id)!.due_at).toBe(dueAt);

      // Unchecking clears the instance completion (the scheduled row stays).
      await core.uncompleteTask(db.db, user, task.id);
      const relisted = await core.listTasks(db.db, user);
      expect(relisted.find((t) => t.id === task.id)!.completed_at).toBeNull();
      const day = await db.db
        .select()
        .from(s.taskOccurrences)
        .where(and(eq(s.taskOccurrences.taskId, task.id), eq(s.taskOccurrences.occurrenceDate, dueAt)))
        .all();
      expect(day).toHaveLength(1);
      expect(day[0].completedAt).toBeNull();
    });

    it("auto-fills the due date for a repeating task created without one", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const today = todayStr();
      const task = await core.createTask(db.db, user, {
        name: "Music lesson",
        recurrence_type: "custom",
        recurrence_interval: 1,
        recurrence_period: "week",
        recurrence_days_of_week: ["TH"],
        recurrence_start_date: today,
        assigned_ids: [admin.id],
      });
      // A weekly-Thursday task is due on its first scheduled occurrence from
      // today — this coming Thursday (or today, when created on a Thursday) —
      // never some past date.
      const dow = new Date(`${today}T12:00:00`).getDay();
      const expected = addDays(today, (4 - dow + 7) % 7);
      expect(task.due_at).toBe(expected);
    });

    it("resolves a legacy dateless repeating task to its current/next occurrence", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      // Simulate a row created before the auto-fill existed: no due date, but
      // a daily recurrence. Materializing must point it at "today" so it never
      // vanishes from the list (daily tasks are excluded from Upcoming).
      const [task] = await db.db
        .insert(s.tasks)
        .values({
          name: "Legacy daily",
          recurrenceType: "daily",
          recurrenceInterval: 1,
          createdAt: todayStr(),
        })
        .returning()
        .all();
      await db.db.insert(s.taskAssignees).values({ taskId: task.id, userId: admin.id }).run();

      const res = await core.materializeTaskOccurrences(db.db);
      const [after] = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      expect(after.dueAt).toBe(todayStr());
      expect(res.inserted).toBeGreaterThan(0);
    });

    it("materializes pending instances ahead of the rolling row", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const task = await core.createTask(db.db, user, {
        name: "Laundry",
        recurrence_type: "custom",
        recurrence_interval: 1,
        recurrence_period: "week",
        recurrence_days_of_week: ["MO", "WE", "FR"],
        recurrence_start_date: addDays(todayStr(), -20),
        assigned_ids: [admin.id],
      });

      const occs = await db.db
        .select({ date: s.taskOccurrences.occurrenceDate })
        .from(s.taskOccurrences)
        .where(eq(s.taskOccurrences.taskId, task.id))
        .all();
      // Enough instances to cover the coming week, all pending, all on the
      // chosen weekdays, no duplicates.
      const dates = occs.map((o) => o.date);
      expect(dates.length).toBeGreaterThanOrEqual(10);
      expect(new Set(dates).size).toBe(dates.length);
      const dow = dates.map((d) => new Date(`${d}T12:00:00`).getDay());
      expect(dow.every((d) => [1, 3, 5].includes(d))).toBe(true);
      const pending = await db.db
        .select()
        .from(s.taskOccurrences)
        .where(eq(s.taskOccurrences.taskId, task.id))
        .all();
      expect(pending.every((p) => p.completedAt === null)).toBe(true);
    });

    it("rolls a completed instance forward once its day has passed", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const today = todayStr();
      const task = await core.createTask(db.db, user, {
        name: "Water plants",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: today,
        assigned_ids: [admin.id],
      });
      // Simulate arriving the next morning: the row still points at yesterday
      // but someone had checked it off.
      const yesterday = addDays(today, -1);
      await db.db
        .update(s.tasks)
        .set({ dueAt: yesterday, completedAt: `${yesterday} 08:30:00`, reviewedAt: null })
        .where(eq(s.tasks.id, task.id))
        .run();

      const res = await core.materializeTaskOccurrences(db.db, { task_id: task.id });
      expect(res.advanced).toBeGreaterThan(0);
      const rows = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      // Rolled forward to today, cleared for the fresh instance.
      expect(rows[0].completedAt).toBeNull();
      expect(rows[0].dueAt).toBe(today);
      // And that instance already exists as a pending occurrence for the audit.
      const day = await db.db
        .select()
        .from(s.taskOccurrences)
        .where(and(eq(s.taskOccurrences.taskId, task.id), eq(s.taskOccurrences.occurrenceDate, today)))
        .all();
      expect(day).toHaveLength(1);
      expect(day[0].completedAt).toBeNull();
    });

    it("rolls a missed (uncompleted) occurrence forward once its day has passed", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const start = addDays(todayStr(), -10);
      const task = await core.createTask(db.db, user, {
        name: "Missed daily",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: start,
        due_at: start,
        assigned_ids: [admin.id],
      });

      // An uncompleted daily row never lingers as overdue: creating it far in
      // the past already rolled it to today, so it keeps appearing in the
      // "today" list instead of dropping out.
      const [after] = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      expect(after.dueAt).toBe(todayStr());
      expect(after.completedAt).toBeNull();

      // The missed days remain in task_occurrences as pending instances (the
      // "review yesterday's tasks" audit still sees them as not done).
      const occs = await db.db
        .select({ date: s.taskOccurrences.occurrenceDate, done: s.taskOccurrences.completedAt })
        .from(s.taskOccurrences)
        .where(eq(s.taskOccurrences.taskId, task.id))
        .all();
      const missed = occs.find((o) => o.date === start);
      expect(missed).toBeDefined();
      expect(missed!.done).toBeNull();
    });

    it("history returns completed and skipped instances for a day", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const bob = await seedUser(db, { name: "Bob" });
      const dueAt = todayStr();
      const done = await core.createTask(db.db, snakeUser(admin), {
        name: "Done chore",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: dueAt,
        assigned_ids: [bob.id],
      });
      const skipped = await core.createTask(db.db, snakeUser(admin), {
        name: "Skipped chore",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: dueAt,
        assigned_ids: [bob.id],
      });
      await core.completeTask(db.db, snakeUser(admin), done.id);

      const hist = await core.taskOccurrenceHistory(db.db, dueAt);
      expect(hist.rows.map((r) => r.task_id).sort((a, b) => a - b)).toEqual(
        [done.id, skipped.id].sort((a, b) => a - b)
      );
      const doneRow = hist.rows.find((r) => r.task_id === done.id)!;
      const skippedRow = hist.rows.find((r) => r.task_id === skipped.id)!;
      expect(doneRow.completed_at).toBeTruthy();
      expect(skippedRow.completed_at).toBeNull();
      expect(assigneesOf(hist, done.id).map((a) => a.id)).toContain(bob.id);
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