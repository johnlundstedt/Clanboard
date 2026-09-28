import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "../src/schema.js";
import * as core from "../src/core/tasks.js";
import { autoAssignIcon } from "../src/modules/tasks/icon-catalog.js";
import { addDays, localDayStr, localTimeStr, todayStr } from "../src/modules/tasks/recurrence.js";
// The client-side badge/section predicate, so the tests prove the two views
// ("today" on the dashboard, and the list/badges) agree on the same task.
import { isOutstanding, taskBucket } from "../../client/src/modules/tasks/taskUtils.js";
import * as dashboard from "../src/core/dashboard.js";
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
      const user = snakeUser(admin);

      const task = await core.createTask(db.db, user, {
        name: "Take out trash",
        description: "before Tuesday",
        category_id: cat.id,
        due_at: "2026-09-12",
        assigned_ids: [bob.id],
        icon: "trash",
      });

      expect(task.name).toBe("Take out trash");
      expect(task.category_id).toBe(cat.id);
      expect(task.category_name).toBe("Chores");
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
      // The rows themselves are timezone-agnostic and still get materialized...
      expect(res.inserted).toBeGreaterThan(0);
      // ...but the background sweep has no viewer, so it must not guess which
      // day this repeat belongs to. On a bare UTC date it would pick tomorrow's
      // for the Americas in the evening and re-create the drift.
      const [unresolved] = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      expect(unresolved.dueAt).toBeNull();

      // A viewer's read resolves it, on their own clock.
      const ZONE = "America/Chicago";
      await core.listTasks(db.db, user, { timezone: ZONE });
      const [after] = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      expect(after.dueAt).toBe(todayStr(ZONE));
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

    it("flags due_today for a repeat whose row sits on a later day", async () => {
      // A repeat on several weekdays a week, created with a start date of
      // tomorrow: today still has a pending instance, so the dashboard counts it
      // as due today ("0 of 1 done") even though the rolling due_at is tomorrow.
      // Without the flag the list filed it under "upcoming" and the member badge
      // showed nothing outstanding.
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const today = todayStr();
      const tomorrow = addDays(today, 1);
      const CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
      const dow = (d: string) => CODES[new Date(`${d}T12:00:00`).getDay()];
      await core.createTask(db.db, user, {
        name: "Feed the fish",
        due_at: tomorrow,
        recurrence_type: "custom",
        recurrence_interval: 1,
        recurrence_period: "week",
        recurrence_days_of_week: [dow(today), dow(tomorrow)],
        recurrence_start_date: today,
        assigned_ids: [admin.id],
      });

      const [listed] = await core.listTasks(db.db, user, {});
      expect(listed.due_at?.slice(0, 10)).toBe(tomorrow);
      expect(listed.due_today).toBe(true);
      // The client badge/section predicate reads that same flag, so the two
      // views agree on what is due today.
      expect(isOutstanding(listed, listed.today)).toBe(true);
    });

    it("leaves due_today false for a repeat with no instance today", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const today = todayStr();
      await core.createTask(db.db, user, {
        name: "Water the plants",
        // Starts in a week, so nothing is scheduled for today.
        recurrence_type: "daily",
        recurrence_interval: 7,
        recurrence_period: "day",
        recurrence_start_date: addDays(today, 7),
        assigned_ids: [admin.id],
      });

      const [listed] = await core.listTasks(db.db, user, {});
      expect(listed.due_today).toBe(false);
      expect(isOutstanding(listed, listed.today)).toBe(false);
    });

    it("stamps completed_day in the viewer's day, and the section follows it", async () => {
      // completeTask writes datetime('now') — a UTC instant. The "completed
      // today" section has to group by the day the family experienced, which
      // for the last few hours of the evening in the Americas is a day earlier
      // than the UTC date those timestamps start with. Pinned to a zone well
      // behind UTC so the gap is real regardless of when the suite runs.
      const ZONE = "America/Chicago";
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const task = await core.createTask(db.db, user, {
        name: "Walk the dog",
        due_at: todayStr(ZONE),
        assigned_ids: [admin.id],
      });
      await core.completeTask(db.db, user, task.id);

      const [listed] = await core.listTasks(db.db, user, { timezone: ZONE });
      expect(listed.completed_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
      // The day it was actually done, on the viewer's clock.
      expect(listed.completed_day).toBe(todayStr(ZONE));
      expect(listed.reviewed_day).toBeNull();
      // ...which is what keeps the task under "completed today" and off "rest".
      expect(taskBucket(listed, listed.today)).toBe("completedToday");
    });

    it("recomputes completed_day per viewer rather than once at completion", async () => {
      // The stored instant is fixed and shared by everyone; the stamped day is
      // the only per-viewer part, so the same row reads as done today in Iceland
      // and done yesterday in Chicago on the same evening.
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const task = await core.createTask(db.db, user, {
        name: "Put away laundry",
        assigned_ids: [admin.id],
      });
      await core.completeTask(db.db, user, task.id);

      const [chicago] = await core.listTasks(db.db, user, { timezone: "America/Chicago" });
      const [reykjavik] = await core.listTasks(db.db, user, { timezone: "Atlantic/Reykjavik" });
      expect(chicago.completed_at).toBe(reykjavik.completed_at);
      expect(chicago.completed_day).toBe(localDayStr(chicago.completed_at, "America/Chicago"));
      expect(reykjavik.completed_day).toBe(todayStr("Atlantic/Reykjavik"));
    });

    it("buckets every open task the same way the dashboard panel does", async () => {
      // The regression this file exists for: the dashboard's "today's tasks" and
      // the list sections/badges once disagreed, so a task showed as "0 of 2
      // done" on the dashboard while the Tasks page filed it under "upcoming"
      // with no badge. One shared rule now backs both, so pin them against each
      // other across every shape a task can take.
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const siggi = await seedUser(db, { name: "Siggi" });
      const user = snakeUser(admin);
      const today = todayStr();
      const tomorrow = addDays(today, 1);
      const CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
      const dow = (d: string) => CODES[new Date(`${d}T12:00:00`).getDay()];
      const make = (over: Partial<core.TaskInput>) =>
        core.createTask(db.db, user, { assigned_ids: [siggi.id], ...over });

      await make({ name: "No due date" });
      await make({ name: "Due today", due_at: today });
      await make({ name: "Due in three days", due_at: addDays(today, 3) });
      await make({ name: "Due in ten days", due_at: addDays(today, 10) });
      await make({ name: "Overdue", due_at: addDays(today, -2) });
      await make({
        name: "Daily chore",
        recurrence_type: "daily",
        recurrence_period: "day",
        recurrence_interval: 1,
        recurrence_start_date: today,
      });
      const rolled = await make({
        name: "Multi-day repeat",
        due_at: tomorrow,
        recurrence_type: "custom",
        recurrence_period: "week",
        recurrence_interval: 1,
        recurrence_days_of_week: [dow(today), dow(tomorrow)],
        recurrence_start_date: today,
      });
      const finished = await make({ name: "Finished earlier", due_at: today });
      await core.completeTask(db.db, user, finished.id);

      const listed = await core.listTasks(db.db, user, {});
      const bucketOf = (t: core.TaskWire) => taskBucket(t, t.today);
      const clientOutstanding = listed
        .filter((t) => bucketOf(t) === "outstanding")
        .map((t) => t.name)
        .sort();
      const rows = await dashboard.childTodayRows(db.db, [siggi.id]);
      const dashboardOpen = rows[0].todays
        .filter((t) => !t.completed_at)
        .map((t) => t.name)
        .sort();

      // A dateless open task is today's work on the dashboard, so it is today's
      // work here too; a finished task belongs to neither.
      expect(clientOutstanding).toEqual(dashboardOpen);
      expect(clientOutstanding).toEqual([
        "Daily chore",
        "Due today",
        "Multi-day repeat",
        "No due date",
        "Overdue",
      ]);
      expect(bucketOf(listed.find((t) => t.name === "No due date")!)).toBe("outstanding");
      expect(bucketOf(listed.find((t) => t.name === "Due in three days")!)).toBe("upcoming");
      expect(bucketOf(listed.find((t) => t.name === "Due in ten days")!)).toBe("rest");
      // A finished task is nobody's outstanding work, whichever day it counts as.
      expect(bucketOf(listed.find((t) => t.name === "Finished earlier")!)).not.toBe("outstanding");
      expect(bucketOf(listed.find((t) => t.id === rolled.id)!)).toBe("outstanding");
    });

    it("does not let a pending instance inherit the repeat's last completion", async () => {
      // Every completion leaves a rolling completed_at on the parent row, and
      // that marker outlives the day it was set. It survives the roll-forward
      // (which only fires once due_at is in the past), so a repeat sitting on
      // today's date with the marker still set has today's instance pending.
      // Only overwriting on an actual completion let that marker stand in for it
      // — the task reported itself done before anyone had done anything, and the
      // day's total never moved.
      const ZONE = "America/Chicago";
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const today = todayStr(ZONE);
      const task = await core.createTask(db.db, user, {
        name: "Feed tortoise",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: addDays(today, -2),
        due_at: today,
        assigned_ids: [admin.id],
      });
      // The marker, as a completion on an earlier day would have left it.
      await db.db
        .update(s.tasks)
        .set({ completedAt: `${addDays(today, -1)} 18:00:00` })
        .where(eq(s.tasks.id, task.id))
        .run();

      // Today's instance is pending, so that is what the wire must report.
      const [listed] = await core.listTasks(db.db, user, { timezone: ZONE });
      expect(listed.due_today).toBe(true);
      expect(listed.completed_at).toBeNull();
      expect(listed.completed_day).toBeNull();
      expect(isOutstanding(listed, listed.today)).toBe(true);
      expect(taskBucket(listed, listed.today)).toBe("outstanding");

      // The dashboard must agree, or the badge and the panel diverge again.
      const [child] = await dashboard.childTodayRows(db.db, [admin.id], ZONE);
      expect(child.done).toBe(0);
      expect(child.completed_today_count).toBe(0);
      expect(child.todays.map((t) => t.name)).toEqual(["Feed tortoise"]);

      // And once the instance is genuinely done, its own stamp is what shows.
      await core.completeTask(db.db, user, task.id, ZONE);
      const [done] = await core.listTasks(db.db, user, { timezone: ZONE });
      expect(done.completed_at).not.toBeNull();
      expect(done.completed_at).not.toBe(`${addDays(today, -1)} 18:00:00`);
      expect(taskBucket(done, done.today)).toBe("completedToday");
    });

    it("leaves a pending instance alone when the background pass has no viewer", async () => {
      // The 15-minute module job sweeps the household with neither a task nor a
      // zone, so its `today` is a bare UTC date — already tomorrow for the
      // Americas all evening. Rolling on that advanced the rolling row a day
      // early and stranded the still-pending instance that the list and the
      // dashboard both show as today's work. Completing it then marked
      // *tomorrow's* instance done and today's total never moved.
      const ZONE = "America/Chicago";
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const today = todayStr(ZONE);
      const task = await core.createTask(db.db, user, {
        name: "Brush teeth",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: addDays(today, -10),
        due_at: today,
        assigned_ids: [admin.id],
      });
      // Backdate it after creation (which rolls on its own) to a chore three
      // days stale, as one nobody has ticked off yet. Every missed day is still
      // a pending occurrence, so advancing the row is exactly what strands the
      // instance the UI is showing.
      const stale = addDays(today, -3);
      await db.db
        .update(s.tasks)
        .set({ dueAt: stale, completedAt: null })
        .where(eq(s.tasks.id, task.id))
        .run();

      // The background pass (what the cron calls every 15 minutes) must not
      // decide the household's day has passed. On a bare UTC date it does so
      // for the whole evening, pushing the row a day early every night.
      const swept = await core.materializeTaskOccurrences(db.db);
      expect(swept.advanced).toBe(0);
      const [untouched] = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      expect(untouched.dueAt).toBe(stale);

      // A viewer's read still rolls it, using their own zone — the sweep only
      // defers that decision, it never cancels it.
      await core.listTasks(db.db, user, { timezone: ZONE });
      const [rolled] = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      expect(rolled.dueAt).toBe(today);
    });

    it("completes the instance it is showing, not the one due_at has rolled to", async () => {
      // The state the background pass used to create: today's instance is still
      // pending while the rolling row already points at tomorrow. Both views
      // list the task under "today" on the strength of that row, so completing
      // it has to mark that row — the dashboard's "done today" total is read
      // straight off today's occurrence.
      const ZONE = "America/Chicago";
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const today = todayStr(ZONE);
      const tomorrow = addDays(today, 1);
      const task = await core.createTask(db.db, user, {
        name: "Brush teeth",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: today,
        due_at: tomorrow,
        assigned_ids: [admin.id],
      });
      // Today's instance exists and is pending; that is what makes it due today.
      await db.db
        .insert(s.taskOccurrences)
        .values({ taskId: task.id, occurrenceDate: today, completedAt: null })
        .onConflictDoNothing()
        .run();
      await db.db
        .insert(s.taskOccurrences)
        .values({ taskId: task.id, occurrenceDate: tomorrow, completedAt: null })
        .onConflictDoNothing()
        .run();

      const [listed] = await core.listTasks(db.db, user, { timezone: ZONE });
      expect(listed.due_today).toBe(true);
      expect(listed.completed_at).toBeNull();

      await core.completeTask(db.db, user, task.id, ZONE);

      const done = await db.db
        .select({ date: s.taskOccurrences.occurrenceDate, at: s.taskOccurrences.completedAt })
        .from(s.taskOccurrences)
        .where(eq(s.taskOccurrences.taskId, task.id))
        .all();
      const byDay = Object.fromEntries(done.map((o) => [o.date, o.at]));
      expect(byDay[today]).toBeTruthy();
      // Tomorrow's instance is untouched — the old code marked this one instead.
      expect(byDay[tomorrow]).toBeNull();

      // And the dashboard agrees: the wire and the tally both move.
      const [after] = await core.listTasks(db.db, user, { timezone: ZONE });
      expect(after.completed_at).toBeTruthy();
      expect(taskBucket(after, after.today)).toBe("completedToday");
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

    it("skips today's occurrence of a daily repeat and takes the day off the board", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const bob = await seedUser(db, { name: "Bob" });
      const user = snakeUser(admin);
      const today = todayStr();
      const task = await core.createTask(db.db, user, {
        name: "Feed pets",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: today,
        assigned_ids: [bob.id],
      });

      // Tick it off first, so the skip has to undo today's completion rather
      // than merely move an untouched task forward.
      await core.completeTask(db.db, user, task.id);
      const skipped = await core.skipTask(db.db, user, task.id);
      expect(skipped.skipped).toBe(today);
      expect(skipped.due_at).toBe(addDays(today, 1));

      // The row is back on tomorrow's date and not completed: today's list no
      // longer nags, tomorrow's instance is fresh.
      const [after] = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      expect(after.dueAt).toBe(addDays(today, 1));
      expect(after.completedAt).toBeNull();
      expect(after.reviewedAt).toBeNull();

      // Today leaves the board: the day is recorded as skipped rather than left
      // pending, so the repeat is no longer "due today" — including after the
      // next materializer pass, which must not resurrect a taken-off day.
      const hist = await core.taskOccurrenceHistory(db.db, today);
      const row = hist.rows.find((r) => r.task_id === task.id)!;
      expect(row).toBeDefined();
      expect(row.completed_at).toBeNull();
      expect(row.skipped_at).toBeTruthy();
      await core.materializeTaskOccurrences(db.db, {});
      const afterPass = await core.listTasks(db.db, user, {});
      const reWire = afterPass.find((t) => t.id === task.id)!;
      expect(reWire.due_today).toBeFalsy();
      expect(reWire.completed_at).toBeNull();

      // The list reflects the skip: not outstanding today, and the repeat files
      // itself under "upcoming" until its next turn instead of vanishing.
      const listed = await core.listTasks(db.db, user, {});
      const wire = listed.find((t) => t.id === task.id)!;
      expect(wire.due_at?.slice(0, 10)).toBe(addDays(today, 1));
      expect(wire.due_today).toBeFalsy();
      expect(isOutstanding(wire, wire.today)).toBe(false);
      expect(taskBucket(wire, wire.today)).toBe("upcoming");

      // The dashboard's per-child "today's tasks" leaves it out too.
      const board = await dashboard.childTodayRows(db.db, [bob.id]);
      expect(board[0].todays.map((t) => t.id)).not.toContain(task.id);

      // A second skip has nothing left to take off, so it is refused rather than
      // quietly eating tomorrow's day too.
      await expect(core.skipTask(db.db, user, task.id)).rejects.toThrow(/today/i);
      const [still] = await db.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)).all();
      expect(still.dueAt).toBe(addDays(today, 1));
    });

    it("refuses to skip a non-repeating task, and stops at the end of a schedule", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const today = todayStr();
      const once = await core.createTask(db.db, user, { name: "Mow lawn", due_at: today });
      await expect(core.skipTask(db.db, user, once.id)).rejects.toThrow(/repeating task/i);

      // A weekly repeat is refused too: skipping one day there would really mean
      // skipping the week, which isn't what the action says.
      const monday = (() => {
        const d = new Date(`${today}T12:00:00`);
        d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      })();
      const weekly = await core.createTask(db.db, user, {
        name: "Bins",
        recurrence_type: "custom",
        recurrence_period: "week",
        recurrence_interval: 1,
        recurrence_days_of_week: ["MO"],
        recurrence_start_date: monday,
        due_at: today,
      });
      await expect(core.skipTask(db.db, user, weekly.id)).rejects.toThrow(/daily/i);

      // A repeat whose schedule has no day left after today: skipping the final
      // occurrence clears the row instead of inventing a date past the end.
      const ending = await core.createTask(db.db, user, {
        name: "Last water",
        recurrence_type: "daily",
        recurrence_interval: 1,
        recurrence_start_date: today,
        recurrence_end_date: today,
      });
      const out = await core.skipTask(db.db, user, ending.id);
      expect(out.due_at).toBeNull();
      const [row] = await db.db.select().from(s.tasks).where(eq(s.tasks.id, ending.id)).all();
      expect(row.dueAt).toBeNull();
      expect(row.completedAt).toBeNull();
    });

    it("skips a weekday repeat onto the next weekday", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const user = snakeUser(admin);
      const today = todayStr();
      const task = await core.createTask(db.db, user, {
        name: "School run",
        recurrence_type: "weekdays",
        recurrence_interval: 1,
        recurrence_start_date: today,
        due_at: today,
      });
      const out = await core.skipTask(db.db, user, task.id);
      expect(out.skipped).toBe(today);
      expect(out.due_at).not.toBeNull();
      // The next occurrence is a weekday strictly after today, whatever today is.
      const next = new Date(`${out.due_at}T12:00:00`);
      expect(next.getDay()).toBeGreaterThan(0);
      expect(next.getDay()).toBeLessThan(6);
      expect(out.due_at! > today).toBe(true);
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

describe("autoAssignIcon keywords", () => {
  it("maps grooming keywords to the toothbrush and mirror icons", () => {
    expect(autoAssignIcon("Brush teeth")).toBe("toothbrush-sparkles");
    expect(autoAssignIcon("brush your teeth")).toBe("toothbrush-sparkles");
    expect(autoAssignIcon("Brush hair")).toBe("mirror-round");
    expect(autoAssignIcon("comb hair")).toBe("mirror-round");
    // The generic shower/scrub keywords still keep their shower icon
    expect(autoAssignIcon("Brush the floor")).toBe("shower-head");
  });

  it("maps pet / animal keywords to their icons", () => {
    expect(autoAssignIcon("Feed the cat")).toBe("cat");
    expect(autoAssignIcon("Give the kitten water")).toBe("cat");
    expect(autoAssignIcon("Hold the rabbit")).toBe("rabbit");
    expect(autoAssignIcon("Clean the turtle tank")).toBe("turtle");
    expect(autoAssignIcon("Feed the chickens")).toBe("bird");
    // Small-furry pets (guinea pigs etc.) get the rat icon, even with "clean"
    expect(autoAssignIcon("Clean the guinea pig cage")).toBe("rat");
    expect(autoAssignIcon("Clean the hamster cage")).toBe("rat");
    expect(autoAssignIcon("Catch the rat")).toBe("rat");
    expect(autoAssignIcon("Walk the dog")).toBe("paw-print");
  });

  it("keeps existing keyword behaviour", () => {
    expect(autoAssignIcon("Take out the trash")).toBe("trash");
    expect(autoAssignIcon("Wash the dishes")).toBe("shirt");
    expect(autoAssignIcon("Clean the kitchen")).toBe("sparkles");
    expect(autoAssignIcon("Fix the computer mouse")).toBe("wrench");
  });
});

// Pure date conversions. These pin the exact bug this exists for: a completion
// timestamp is written in UTC, so the day it lands on depends on the viewer's
// offset, and for the last |offset| hours of the evening that is *not* the day
// the family experienced.
describe("UTC instant -> viewer's day", () => {
  // 03:12 UTC on the 26th is 22:12 on the 25th in Chicago: the case that put an
  // evening chore on the following day.
  const EVENING_UTC = "2026-09-26 03:12:00";

  it("returns the viewer's calendar day, not the UTC day", () => {
    expect(localDayStr(EVENING_UTC, "America/Chicago")).toBe("2026-09-25");
    expect(localDayStr(EVENING_UTC, "UTC")).toBe("2026-09-26");
    expect(localDayStr(EVENING_UTC, "Pacific/Auckland")).toBe("2026-09-26");
  });

  it("reads every timestamp shape the app stores", () => {
    // SQLite datetime('now'), toISOString(), and Google's dateTime all mean the
    // same instant and must all resolve to the same local day.
    expect(localDayStr("2026-09-26T03:12:00.000Z", "America/Chicago")).toBe("2026-09-25");
    expect(localDayStr("2026-09-26T03:12:00Z", "America/Chicago")).toBe("2026-09-25");
    expect(localDayStr(EVENING_UTC, "America/Chicago")).toBe("2026-09-25");
    // An explicit offset is authoritative rather than assumed to be UTC.
    expect(localDayStr("2026-09-26T03:12:00+02:00", "America/Chicago")).toBe("2026-09-25");
  });

  it("returns the viewer's clock time for a synced event", () => {
    expect(localTimeStr("2026-09-25T23:00:00Z", "America/Los_Angeles")).toBe("16:00");
    expect(localTimeStr("2026-09-26T00:30:00Z", "Europe/London")).toBe("01:30");
    // Midnight must read "00", not "24".
    expect(localTimeStr("2026-09-26T00:00:00Z", "UTC")).toBe("00:00");
  });

  it("follows the offset across a DST change rather than a fixed one", () => {
    // 2026-11-01 01:30 happens twice in Chicago; the instant is unambiguous, so
    // it must resolve with the pre-transition offset (-5), not the -6 that a
    // hardcoded winter offset would give.
    expect(localDayStr("2026-11-01 05:30:00", "America/Chicago")).toBe("2026-11-01");
    expect(localTimeStr("2026-11-01 05:30:00", "America/Chicago")).toBe("00:30");
    // And the spring-forward side: still on standard time at 04:30 UTC.
    expect(localDayStr("2026-03-08 04:30:00", "America/Chicago")).toBe("2026-03-07");
    expect(localTimeStr("2026-03-08 04:30:00", "America/Chicago")).toBe("22:30");
  });

  it("falls back to the stored (UTC) day when no zone is known", () => {
    // Cron jobs and direct API callers send no X-Timezone; the server's own frame
    // is UTC, which is what todayStr() reports for them too.
    expect(localDayStr(EVENING_UTC, undefined)).toBe("2026-09-26");
    expect(localTimeStr(EVENING_UTC, undefined)).toBe("03:12");
  });

  it("survives a zone this runtime doesn't know instead of throwing", () => {
    // The zone arrives off a request header. Intl throws a RangeError on an
    // unrecognised one, and runtimes only accept canonical names, so a legacy
    // alias would otherwise 500 every date-sensitive route.
    for (const zone of ["Not/AZone", "Europe/Reykjavik", "totally bogus"]) {
      expect(() => localDayStr(EVENING_UTC, zone)).not.toThrow();
      expect(localDayStr(EVENING_UTC, zone)).toBe("2026-09-26");
      expect(todayStr(zone)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("returns null for a missing or unparseable timestamp", () => {
    expect(localDayStr(null, "America/Chicago")).toBeNull();
    expect(localDayStr("", "America/Chicago")).toBeNull();
    expect(localDayStr("not a date", "America/Chicago")).toBeNull();
    expect(localTimeStr(null, "America/Chicago")).toBeNull();
  });
});