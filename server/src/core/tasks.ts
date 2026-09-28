import { and, eq, exists, inArray, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { DbClient } from "./db.js";
import { getSetting, setSetting } from "./db.js";
import { taskAssignees, taskCategories, taskOccurrences, tasks, users } from "../schema.js";
import { badRequest, forbidden, notFound } from "./errors.js";
import { hasCap, canAssign, type LoggedInUser } from "./caps.js";
import { autoAssignIcon } from "../modules/tasks/icon-catalog.js";
import {
  addDays,
  isDailyCadence,
  localDayStr,
  nextOccurrence,
  occurrenceIndex,
  todayStr,
  withinRange,
} from "../modules/tasks/recurrence.js";

// ---------------------------------------------------------------------------
// Wire shapes. The rest of the app consumes snake_case rows, so Drizzle rows
// (camelCase) are mapped to the exact shape the old raw-SQL handlers sent.
// ---------------------------------------------------------------------------

export interface TaskWire {
  id: number;
  name: string;
  description: string | null;
  category_id: number | null;
  due_at: string | null;
  requires_adult_review: 0 | 1;
  completed_at: string | null;
  reviewed_at: string | null;
  recurrence_type: string | null;
  recurrence_interval: number;
  recurrence_period: string | null;
  recurrence_days_of_week: string | null;
  recurrence_start_date: string | null;
  recurrence_end_date: string | null;
  recurrence_count: number | null;
  due_time: string | null;
  icon: string | null;
  created_at: string;
  // completed_at / reviewed_at are absolute instants stored in UTC (SQLite's
  // datetime('now')). Their first 10 characters are therefore the *UTC* day, not
  // the day the task was actually done on, and the two disagree for the last
  // |UTC offset| hours of every evening. `completed_day` / `reviewed_day` carry
  // the viewer's own calendar day for the same instant, so the client can group
  // by day without converting. Null when the timestamp is absent.
  completed_day?: string | null;
  reviewed_day?: string | null;
  // True when the task has a materialized occurrence on the canonical `today`.
  // A repeat whose rolling `due_at` sits on a later day still has an instance
  // scheduled for today, and the dashboard counts that as due today — the client
  // needs the same fact or it files the task under "upcoming" and drops it from
  // today's list and badges.
  due_today?: boolean;
  // Canonical "today" (YYYY-MM-DD) in the viewer's timezone, stamped on every row
  // by listTasks so the client buckets the list with the same day the schedule
  // and due_at values were computed against.
  today?: string;
  assignees?: { id: number; name: string }[];
  assigned_to?: number | null;
  category_name?: string | null;
}

type DrizzleTask = typeof tasks.$inferSelect;

export function mapTaskRow(t: DrizzleTask): TaskWire {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category_id: t.categoryId,
    due_at: t.dueAt,
    requires_adult_review: t.requiresAdultReview ? 1 : 0,
    completed_at: t.completedAt,
    reviewed_at: t.reviewedAt,
    recurrence_type: t.recurrenceType,
    recurrence_interval: t.recurrenceInterval,
    recurrence_period: t.recurrencePeriod,
    recurrence_days_of_week: t.recurrenceDaysOfWeek,
    recurrence_start_date: t.recurrenceStartDate,
    recurrence_end_date: t.recurrenceEndDate,
    recurrence_count: t.recurrenceCount,
    due_time: t.dueTime,
    icon: t.icon,
    created_at: t.createdAt,
    due_today: false,
    completed_day: null,
    reviewed_day: null,
  };
}

interface CategoryWire {
  id: number;
  name: string;
  color: string | null;
  is_default: 0 | 1;
  created_at: string;
}

function mapCategoryRow(c: typeof taskCategories.$inferSelect): CategoryWire {
  return {
    id: c.id,
    name: c.name,
    color: c.color,
    is_default: c.isDefault ? 1 : 0,
    created_at: c.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Task read/write helpers
// ---------------------------------------------------------------------------

export async function listTasks(
  db: DbClient,
  user: LoggedInUser,
  query: { user_id?: string | number; timezone?: string } = {}
) {
  const requestedUser = query.user_id ? Number(query.user_id) : null;

  if (requestedUser && !(await hasCap(db, user, "tasks", "view_others")) && requestedUser !== user.id) {
    throw forbidden("Your role doesn't allow viewing that member's tasks.");
  }

  await materializeTaskOccurrences(db, { timezone: query.timezone });

  const canViewAll = await hasCap(db, user, "tasks", "view_others");
  const userId = requestedUser || (!canViewAll ? user.id : null);

  const rows = await db
    .select()
    .from(tasks)
    .where(
      userId
        ? exists(
            db
              .select({ one: sql`1` })
              .from(taskAssignees)
              .where(and(eq(taskAssignees.taskId, tasks.id), eq(taskAssignees.userId, userId)))
          )
        : undefined
    )
    .orderBy(sql`due_at IS NULL`, tasks.dueAt, tasks.id)
    .all();

  const today = query.timezone ? todayStr(query.timezone) : todayStr();
  const wired = await annotateTodayOccurrences(
    db,
    await attachAssignees(db, rows.map(mapTaskRow)),
    today,
    query.timezone
  );
  // Stamp the canonical "today" (the same day the schedule and occurrence
  // annotations were computed against) on every row so the client buckets the
  // list with one consistent day — the browser's local date can lag or lead
  // the server's by a day around midnight, which made daily tasks due
  // "tomorrow-per-server" invisible to every section.
  return wired.map((t) => ({ ...t, today }));
}

// Task settings flags (admin-managed); any authenticated user may read them.
export async function taskSettings(db: DbClient) {
  return {
    enable_categories: (await getSetting(db, "tasks_enable_categories")) !== "0",
  };
}

function normalizeUserIds(value: unknown): number[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

async function setAssignees(db: DbClient, taskId: number, userIds: unknown) {
  const ids = normalizeUserIds(userIds);
  await db.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId)).run();
  if (ids.length) {
    await db
      .insert(taskAssignees)
      .values(ids.map((userId) => ({ taskId, userId })))
      .onConflictDoNothing()
      .run();
  }
}

async function defaultCategoryId(db: DbClient): Promise<number | null> {
  const def = await db
    .select({ id: taskCategories.id })
    .from(taskCategories)
    .where(eq(taskCategories.isDefault, true))
    .orderBy(taskCategories.id)
    .limit(1)
    .get();
  if (def) return def.id;
  const first = await db
    .select({ id: taskCategories.id })
    .from(taskCategories)
    .orderBy(taskCategories.id)
    .limit(1)
    .get();
  return first?.id ?? null;
}

// Reject when the request may not assign to the given user ids (self →
// assign_self, anyone else → assign_others).
async function assertCanAssign(db: DbClient, user: LoggedInUser, userIds: number[]) {
  for (const id of userIds) {
    if (!(await canAssign(db, user, id))) {
      throw forbidden("Your role doesn't allow assigning tasks to that person.");
    }
  }
}

// Attach assignees/category names to wire tasks, mirroring the old raw-SQL
// join helpers. Adds `assignees`, `assigned_to`, `category_name`.
async function attachAssignees(db: DbClient, tasksOut: TaskWire[]): Promise<TaskWire[]> {
  if (!tasksOut.length) return tasksOut;
  const ids = tasksOut.map((t) => t.id);

  const assignees = await db
    .select({ task_id: taskAssignees.taskId, user_id: taskAssignees.userId, name: users.name })
    .from(taskAssignees)
    .innerJoin(users, eq(taskAssignees.userId, users.id))
    .where(inArray(taskAssignees.taskId, ids))
    .orderBy(users.id)
    .all();
  const byTask = new Map<number, { id: number; name: string }[]>();
  for (const r of assignees) {
    const list = byTask.get(r.task_id) ?? [];
    list.push({ id: r.user_id, name: r.name });
    byTask.set(r.task_id, list);
  }

  const catIds = [...new Set(tasksOut.map((t) => t.category_id).filter((v): v is number => !!v))];
  const catNames = new Map<number, string>();
  if (catIds.length) {
    const cats = await db
      .select({ id: taskCategories.id, name: taskCategories.name })
      .from(taskCategories)
      .where(inArray(taskCategories.id, catIds))
      .all();
    for (const c of cats) catNames.set(c.id, c.name);
  }

  for (const t of tasksOut) {
    const list = byTask.get(t.id) ?? [];
    t.assignees = list;
    t.assigned_to = list.length ? list[0].id : null;
    t.category_name = catNames.get(t.category_id ?? -1) ?? null;
  }
  return tasksOut;
}

// Surface recurring-task completions as "done today": when the rolling row has
// already advanced to the next occurrence, the wire's completed_at is set from
// the stored occurrence for today's local date so list/dashboard taps render
// the check that "stuck". Non-recurring tasks have no occurrences and are left
// untouched (their row completed_at is authoritative).
//
// It also stamps the viewer-frame facts the client buckets on: `due_today` (an
// instance exists for today) and `completed_day`/`reviewed_day` (the viewer's
// calendar day for a UTC completion timestamp). Doing it in one pass keeps every
// read path agreeing on what "today" means.
export async function annotateTodayOccurrences(
  db: DbClient,
  tasksOut: TaskWire[],
  today: string,
  timezone?: string
): Promise<TaskWire[]> {
  if (!tasksOut.length) return tasksOut;
  const occs = await db
    .select({
      taskId: taskOccurrences.taskId,
      completedAt: taskOccurrences.completedAt,
      reviewedAt: taskOccurrences.reviewedAt,
      skippedAt: taskOccurrences.skippedAt,
    })
    .from(taskOccurrences)
    .where(eq(taskOccurrences.occurrenceDate, today))
    .all();
  const byTask = new Map<number, { completedAt: string | null; reviewedAt: string | null }>();
  for (const o of occs) {
    // A skipped day is not on the board: it must not read as due today, and its
    // (empty) completion must not blank out the repeat's rolling marker either.
    if (o.skippedAt) continue;
    byTask.set(o.taskId, { completedAt: o.completedAt, reviewedAt: o.reviewedAt });
  }

  for (const t of tasksOut) {
    const o = byTask.get(t.id);
    if (o) {
      // An instance scheduled for today means the task is due today even when the
      // rolling `due_at` already points at a later occurrence (a repeat matching
      // several days a week, or a row created with a future start date). The
      // dashboard treats that as due today, so the flag keeps the list sections
      // and the member badges in step with it.
      t.due_today = true;
      // That instance is the whole truth for the day, pending included. The
      // parent row's completed_at is a rolling marker left by whenever the repeat
      // was last ticked, and it must not stand in for an instance that is still
      // outstanding — otherwise tomorrow's pending instance inherits last night's
      // completion and reports itself done before anyone has done anything.
      t.completed_at = o.completedAt;
      t.reviewed_at = o.reviewedAt;
    }
    // Last, once completed_at/reviewed_at are final: the day the viewer did the
    // task, which is not the UTC day the timestamp was written in.
    t.completed_day = localDayStr(t.completed_at, timezone);
    t.reviewed_day = localDayStr(t.reviewed_at, timezone);
  }
  return tasksOut;
}

// Recurrence helpers read the legacy snake_case DB row shape.
function recurrenceTask(t: DrizzleTask): TaskWire & { created_at: string } {
  const wire = mapTaskRow(t);
  return { ...wire, created_at: wire.created_at };
}

// ---------------------------------------------------------------------------
// Recurring-task instances
// ---------------------------------------------------------------------------

// Days of upcoming instances to keep materialized ahead of the rolling row.
const MATERIALIZE_LOOKAHEAD_DAYS = 60;
// Days of past instances to backfill (the "review yesterday's list" window).
const MATERIALIZE_BACKFILL_DAYS = 31;
// Watermark tracking how far forward the schedule has been materialized, so
// read paths (task list, dashboard) don't re-walk and re-insert the whole
// window on every request.
const MATERIALIZE_WATERMARK = "task_occ_materialized_through";
// Cap each multi-row insert: D1's SQLite binds at most 100 variables per
// statement (3 per date row), so long daily windows are flushed in chunks
// well below that.
const MATERIALIZE_BATCH_ROWS = 30;

// Materialize per-day instance rows for every recurring task, and roll a
// completed row forward to its next occurrence once its own day has passed.
// Idempotent and cheap (mostly no-op inserts) so it can ride on every task
// read as well as the background job; a lingering completed-at of NULL means
// "scheduled but not done yet", which is exactly the audit a later history
// view needs.
export async function materializeTaskOccurrences(
  db: DbClient,
  opts: { task_id?: number; timezone?: string } = {}
): Promise<{ inserted: number; advanced: number }> {
  const today = todayStr(opts.timezone);
  const through = addDays(today, MATERIALIZE_LOOKAHEAD_DAYS);
  const from = addDays(today, -MATERIALIZE_BACKFILL_DAYS);

  const rows =
    opts.task_id !== undefined
      ? await db.select().from(tasks).where(eq(tasks.id, opts.task_id)).all()
      : await db.select().from(tasks).where(isNotNull(tasks.recurrenceType)).all();

  // A watermark lets the near-daily read paths skip everything an earlier pass
  // already materialized: each new day only adds a handful of new dates to
  // insert instead of re-walking the whole lookahead window.
  const watermark =
    opts.task_id === undefined ? await getSetting(db, MATERIALIZE_WATERMARK) : null;

  let inserted = 0;
  let advanced = 0;
  const flush = async (taskId: number, dates: string[]) => {
    if (!dates.length) return;
    const res = await db
      .insert(taskOccurrences)
      .values(dates.map((occurrenceDate) => ({ taskId, occurrenceDate, completedAt: null })))
      .onConflictDoNothing()
      .run();
    inserted += Number(
      (res as { meta?: { changes?: unknown } })?.meta?.changes ??
        (res as { changes?: unknown })?.changes ??
        0
    );
  };

  for (const task of rows) {
    if (!task.recurrenceType) continue;
    const rec = recurrenceTask(task);
    const anchor = task.recurrenceStartDate || task.createdAt.slice(0, 10) || from;
    // Walk from the task's own anchor upward, but never before what an earlier
    // global pass already materialized. Task-scoped passes always go the full
    // window so a freshly created/edited repeat gets all of its instances.
    const floor = watermark && watermark >= from ? addDays(watermark, 1) : from;
    const seed = anchor > floor ? anchor : floor;

    // Walk the new slice of the schedule forward, inserting-or-ignoring each
    // occurrence in one batched statement per task (existing completions are
    // left untouched — this pass never re-writes them).
    let date = nextOccurrence(rec, addDays(seed, -1));
    let steps = 0;
    let dates: string[] = [];
    while (date && date <= through && steps < 2000) {
      steps += 1;
      if (!withinRange(rec, date)) break;
      if (task.recurrenceCount) {
        const idx = occurrenceIndex(rec, date);
        if (idx !== null && idx > task.recurrenceCount) break;
      }
      dates.push(date);
      if (dates.length >= MATERIALIZE_BATCH_ROWS) {
        await flush(task.id, dates);
        dates = [];
      }
      date = nextOccurrence(rec, date);
    }
    await flush(task.id, dates);

    // Advance the row once its instance day has passed — whether completed OR
    // missed. A missed instance stays in task_occurrences as pending (history
    // still shows it as not done), but the live row points at the next
    // occurrence so a repeating task never silently drops out of the list
    // (daily tasks read as "due today", weekly ones as upcoming). Completed
    // rows additionally clear completed_at/reviewed_at as the finished day
    // moves out of "today". Overdue-non-repeating rows never appear here and
    // keep accumulating overdue days.
    //
    // ...but only for a pass that knows whose day "passed" means. The 15-minute
    // module job sweeps the whole household with neither a task nor a zone, so
    // its `today` is a bare UTC date — already tomorrow for the Americas all
    // evening. Rolling on that pushed every household's row a day early and
    // stranded the still-pending instance the UI lists as today's work. Every
    // viewer-driven pass (a read, or a task-scoped create/update) still rolls,
    // because it has a real zone. Materializing the rows themselves is
    // timezone-agnostic and always happens.
    const rollable = opts.task_id !== undefined || Boolean(opts.timezone);
    let rollSteps = 0;
    while (rollable && task.dueAt && task.dueAt.slice(0, 10) < today && rollSteps < 100) {
      const next = nextOccurrence(rec, task.dueAt.slice(0, 10));
      const afterN = task.recurrenceCount;
      const reached =
        afterN !== null &&
        afterN > 0 &&
        next !== null &&
        (occurrenceIndex(rec, next) || 0) > afterN;
      if (!next || !withinRange(rec, next) || reached) break;
      await db
        .update(tasks)
        .set({
          dueAt: next,
          ...(task.completedAt ? { completedAt: null, reviewedAt: null } : {}),
        })
        .where(eq(tasks.id, task.id))
        .run();
      task.dueAt = next;
      task.completedAt = null;
      advanced += 1;
      rollSteps += 1;
    }

    // A repeating task with no due date yet (legacy rows created before the
    // auto-fill existed) resolves to its current/next occurrence so it never
    // silently drops out of the list: a daily chore lands on "today", a
    // weekly one on its next scheduled day. Same reasoning as the roll above —
    // picking *today's* date needs to know whose today that is.
    if (rollable && task.recurrenceType && !task.dueAt) {
      const next = nextOccurrence(rec, addDays(today, -1));
      if (next && next <= through && withinRange(rec, next)) {
        await db.update(tasks).set({ dueAt: next }).where(eq(tasks.id, task.id)).run();
        task.dueAt = next;
      }
    }
  }

  // The whole lookahead window is covered now; remember it so the next pass
  // (normally a no-op on the read paths) doesn't re-walk the same dates.
  if (opts.task_id === undefined) {
    await setSetting(db, MATERIALIZE_WATERMARK, through);
  }
  return { inserted, advanced };
}

// Per-day audit read: every scheduled instance for `date` (YYYY-MM-DD),
// completed or not, with assignees. Used today by scripts/tests and later by
// the "review yesterday's tasks" UI.
export async function taskOccurrenceHistory(db: DbClient, date?: string, timezone?: string) {
  const day = (date || todayStr(timezone)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest("date must be YYYY-MM-DD");

  const rows = await db
    .select({ occ: taskOccurrences, task: tasks })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(eq(taskOccurrences.occurrenceDate, day))
    .orderBy(tasks.name, tasks.id)
    .all();

  if (!rows.length) return { date: day, rows: [] };

  const ids = [...new Set(rows.map((r) => r.task.id))];
  const assigneeRows = await db
    .select({ taskId: taskAssignees.taskId, id: users.id, name: users.name })
    .from(taskAssignees)
    .innerJoin(users, eq(taskAssignees.userId, users.id))
    .where(inArray(taskAssignees.taskId, ids))
    .orderBy(users.id)
    .all();
  const byTask = new Map<number, { id: number; name: string }[]>();
  for (const a of assigneeRows) {
    const list = byTask.get(a.taskId) ?? [];
    list.push({ id: a.id, name: a.name });
    byTask.set(a.taskId, list);
  }

  return {
    date: day,
    rows: rows.map((r) => ({
      id: r.occ.id,
      task_id: r.occ.taskId,
      name: r.task.name,
      icon: r.task.icon,
      due_time: r.task.dueTime,
      recurrence_type: r.task.recurrenceType,
      occurrence_date: r.occ.occurrenceDate,
      assignees: byTask.get(r.occ.taskId) ?? [],
      completed_at: r.occ.completedAt,
      // The viewer's day for the UTC completion stamp, so a review screen groups
      // by when it was actually done rather than by the UTC day.
      completed_day: localDayStr(r.occ.completedAt, timezone),
      completed_by: r.occ.completedBy,
      reviewed_at: r.occ.reviewedAt,
      reviewed_day: localDayStr(r.occ.reviewedAt, timezone),
      // A day the family took off on purpose. Consumers can render it apart from
      // a missed day instead of reporting it as not done.
      skipped_at: r.occ.skippedAt,
      skipped_day: localDayStr(r.occ.skippedAt, timezone),
    })),
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function listCategories(db: DbClient): Promise<CategoryWire[]> {
  const rows = await db.select().from(taskCategories).orderBy(taskCategories.id).all();
  return rows.map(mapCategoryRow);
}

export async function createCategory(
  db: DbClient,
  input: { name: string; color?: string | null; is_default?: boolean }
): Promise<CategoryWire> {
  const { name, color } = input;
  if (!name || !name.trim()) throw badRequest("name is required");
  const existing = await db.select({ id: taskCategories.id }).from(taskCategories).where(eq(taskCategories.name, name.trim())).get();
  if (existing) throw badRequest("A category with that name already exists");

  const isDefault = !!input.is_default;
  const [row] = await db
    .insert(taskCategories)
    .values({ name: name.trim(), color: color || null, isDefault })
    .returning()
    .all();
  if (isDefault) {
    await db.update(taskCategories).set({ isDefault: false }).where(ne(taskCategories.id, row.id)).run();
  }
  return mapCategoryRow(row);
}

export async function updateCategory(
  db: DbClient,
  id: number,
  input: { name?: string; color?: string | null; is_default?: boolean }
): Promise<CategoryWire> {
  const existing = await db.select().from(taskCategories).where(eq(taskCategories.id, id)).get();
  if (!existing) throw notFound("Not found");

  const { name, color, is_default } = input;
  await db
    .update(taskCategories)
    .set({
      name: name !== undefined ? name.trim() : existing.name,
      color: color !== undefined ? color : existing.color,
      isDefault: is_default !== undefined ? !!is_default : existing.isDefault,
    })
    .where(eq(taskCategories.id, id))
    .run();
  if (is_default) {
    await db.update(taskCategories).set({ isDefault: false }).where(ne(taskCategories.id, id)).run();
  }
  const updated = await db.select().from(taskCategories).where(eq(taskCategories.id, id)).get();
  return mapCategoryRow(updated!);
}

export async function deleteCategory(db: DbClient, id: number): Promise<void> {
  await db.delete(taskCategories).where(eq(taskCategories.id, id)).run();
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

export interface TaskInput {
  name?: string;
  description?: string | null;
  category_id?: number | string | null;
  due_at?: string | null;
  due_time?: string | null;
  requires_adult_review?: boolean;
  assigned_to?: unknown;
  assigned_ids?: unknown;
  recurrence_type?: string | null;
  recurrence_interval?: number;
  recurrence_period?: string | null;
  recurrence_days_of_week?: string[] | null;
  recurrence_start_date?: string | null;
  recurrence_end_date?: string | null;
  recurrence_count?: number | null;
  icon?: string | null;
}

// Quick-add: name only, everything else optional/filled in later. New quick-add
// tasks are assigned the default task category. Creating an unassigned task
// requires the `create_unassigned` capability; assigning it needs assign caps.
export async function quickAddTask(db: DbClient, user: LoggedInUser, body: TaskInput) {
  if (!body.name || !body.name.trim()) throw badRequest("name is required");
  const ids = normalizeUserIds(body.assigned_ids);
  if (ids.length === 0 && !(await hasCap(db, user, "tasks", "create_unassigned"))) {
    throw forbidden("Your role doesn't allow creating unassigned tasks.");
  }
  if (ids.length) {
    await assertCanAssign(db, user, ids);
  }

  const trimmed = body.name.trim();
  const icon = autoAssignIcon(trimmed);
  const [row] = await db
    .insert(tasks)
    .values({ name: trimmed, icon, categoryId: await defaultCategoryId(db) })
    .returning()
    .all();
  if (ids.length) await setAssignees(db, row.id, body.assigned_ids);
  const [out] = await attachAssignees(db, [mapTaskRow(row)]);
  return out;
}

// Full create, for the detailed task form.
export async function createTask(db: DbClient, user: LoggedInUser, body: TaskInput) {
  if (!body.name || !body.name.trim()) throw badRequest("name is required");

  const targetIds = normalizeUserIds(body.assigned_ids !== undefined ? body.assigned_ids : body.assigned_to);
  await assertCanAssign(db, user, targetIds);

  const trimmedName = body.name.trim();
  const iconName = body.icon || autoAssignIcon(trimmedName);

  const [row] = await db
    .insert(tasks)
    .values({
      name: trimmedName,
      description: body.description || null,
      categoryId:
        body.category_id !== undefined
          ? body.category_id
            ? Number(body.category_id)
            : null
          : await defaultCategoryId(db),
      dueAt: body.due_at || null,
      dueTime: body.due_time || null,
      requiresAdultReview: !!body.requires_adult_review,
      recurrenceType: body.recurrence_type || null,
      recurrenceInterval: body.recurrence_interval !== undefined ? Number(body.recurrence_interval) || 1 : 1,
      recurrencePeriod: body.recurrence_period || null,
      recurrenceDaysOfWeek: body.recurrence_days_of_week ? JSON.stringify(body.recurrence_days_of_week) : null,
      recurrenceStartDate: body.recurrence_start_date || null,
      recurrenceEndDate: body.recurrence_end_date || null,
      recurrenceCount: body.recurrence_count !== undefined ? Number(body.recurrence_count) || null : null,
      icon: iconName,
    })
    .returning()
    .all();

  // Back-compat: a bare assigned_to (single id/null) behaves like assigned_ids
  if (body.assigned_ids !== undefined) await setAssignees(db, row.id, body.assigned_ids);
  else if (body.assigned_to !== undefined) await setAssignees(db, row.id, body.assigned_to);

  // A repeat pattern with no explicit due date resolves to its first scheduled
  // occurrence (e.g. a weekly-Thursday task created today is due this Thursday).
  await materializeTaskOccurrences(db, { task_id: row.id });
  let savedRow = (await db.select().from(tasks).where(eq(tasks.id, row.id)).get())!;
  if (savedRow.recurrenceType && !savedRow.dueAt) {
    const first = await db
      .select({ d: sql<string | null>`MIN(occurrence_date)` })
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, row.id))
      .get();
    if (first?.d) {
      await db.update(tasks).set({ dueAt: first.d }).where(eq(tasks.id, row.id)).run();
      savedRow = { ...savedRow, dueAt: first.d };
    }
  }

  const [out] = await attachAssignees(db, [mapTaskRow(savedRow)]);
  return out;
}

async function assertCanComplete(db: DbClient, user: LoggedInUser, task: DrizzleTask): Promise<void> {
  const mine = await db
    .select({ userId: taskAssignees.userId })
    .from(taskAssignees)
    .where(and(eq(taskAssignees.taskId, task.id), eq(taskAssignees.userId, user.id)))
    .get();
  if (mine) {
    if (await hasCap(db, user, "tasks", "complete_own")) return;
  } else if (await hasCap(db, user, "tasks", "complete_others")) {
    return;
  }
  throw forbidden("Your role doesn't allow completing that task.");
}

async function getTaskOr404(db: DbClient, id: number): Promise<DrizzleTask> {
  const row = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) throw notFound("Not found");
  return row;
}

// Mark complete (assignee checks it off) — if requires_adult_review, this
// does NOT count as fully done until an adult also reviews it. A recurring
// task is marked on its own instance row WITHOUT advancing the rolling row, so
// today's stays checked and tomorrow's is a fresh, uncompleted occurrence.
// Which instance a complete/undo/review acts on.
//
// The rolling `due_at` is NOT a safe stand-in for "the one the family is
// looking at". A repeat gets its row advanced once the instance day has passed,
// and the background job decides that on a bare UTC day — which is already
// tomorrow for the Americas during the evening. That leaves today's instance
// still pending while `due_at` points at the next one, and the list/dashboard
// correctly show the task under "today" on the strength of that pending row
// (that is what `due_today` reports). Completing `due_at`'s date in that state
// marks tomorrow's instance done and leaves today's untouched, so the day's
// total never moves. Prefer today's row, and only fall back to the rolling date
// when today has no instance of its own.
async function activeOccurrenceDate(
  db: DbClient,
  task: DrizzleTask,
  timezone?: string
): Promise<string> {
  const today = todayStr(timezone);
  if (task.recurrenceType) {
    const todays = await db
      .select({ occurrenceDate: taskOccurrences.occurrenceDate })
      .from(taskOccurrences)
      .where(
        and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.occurrenceDate, today))
      )
      .get();
    if (todays) return today;
  }
  return task.dueAt ? task.dueAt.slice(0, 10) : today;
}

export async function completeTask(db: DbClient, user: LoggedInUser, id: number, timezone?: string) {
  const task = await getTaskOr404(db, id);
  await assertCanComplete(db, user, task);

  if (task.recurrenceType && task.dueAt) {
    const occDate = await activeOccurrenceDate(db, task, timezone);
    await db
      .insert(taskOccurrences)
      .values({ taskId: id, occurrenceDate: occDate, completedAt: null })
      .onConflictDoNothing()
      .run();
    await db
      .update(taskOccurrences)
      // A real completion overrides a previous "skip today" on the same day.
      .set({ completedAt: sql`datetime('now')`, completedBy: user.id, skippedAt: null })
      .where(and(eq(taskOccurrences.taskId, id), eq(taskOccurrences.occurrenceDate, occDate)))
      .run();
    await db
      .update(tasks)
      .set({ completedAt: sql`datetime('now')`, reviewedAt: null })
      .where(eq(tasks.id, id))
      .run();
  } else {
    await db.update(tasks).set({ completedAt: sql`datetime('now')` }).where(eq(tasks.id, id)).run();
  }
  return { ok: true } as const;
}

// Undo completion. Clears the row and the completion on the current instance
// (the row is not deleted, so the pending/scheduled audit stays intact).
export async function uncompleteTask(db: DbClient, user: LoggedInUser, id: number, timezone?: string) {
  const task = await getTaskOr404(db, id);
  await assertCanComplete(db, user, task);
  await db.update(tasks).set({ completedAt: null, reviewedAt: null }).where(eq(tasks.id, id)).run();
  const occDate = await activeOccurrenceDate(db, task, timezone);
  await db
    .update(taskOccurrences)
    .set({ completedAt: null, completedBy: null, reviewedAt: null })
    .where(and(eq(taskOccurrences.taskId, id), eq(taskOccurrences.occurrenceDate, occDate)))
    .run();
  return { ok: true } as const;
}

// "Skip today": today's occurrence of a repeating task is called off, so the
// family stops seeing it today and the task picks up again on its next
// scheduled day. Same permission as completing it (a member can skip their own
// chore, not someone else's).
//
// The day is MARKED skipped, not deleted and not left merely pending. Both
// alternatives are wrong here: an instance row for today is exactly what makes a
// repeat read as "due today" (annotateTodayOccurrences), so a pending row would
// keep nagging today, and the materializer re-inserts any missing date on the
// next read, so deleting it would silently come back. The marker is also what
// keeps the day off the occurrence history: nobody should be nagged tomorrow
// about the one day they deliberately took off. Missed days stay untouched and
// remain auditable.
export async function skipTask(db: DbClient, user: LoggedInUser, id: number, timezone?: string) {
  const task = await getTaskOr404(db, id);
  await assertCanComplete(db, user, task);
  const rec = recurrenceTask(task);
  if (!isDailyCadence(rec)) {
    throw badRequest(
      task.recurrenceType
        ? "Only a daily repeating task can be skipped."
        : "Only a repeating task can be skipped."
    );
  }

  // Which day "today" is for this task, and whether it is still on the board.
  // A skipped instance no longer counts, so a second tap is refused instead of
  // quietly rolling the task another day. A repeat with no instance of its own
  // (a legacy dateless row) resolves through the rolling `due_at`, which is the
  // day the list is showing; anything else simply isn't scheduled today and must
  // not have a day taken off it.
  const today = todayStr(timezone);
  const todays = await db
    .select({ skippedAt: taskOccurrences.skippedAt })
    .from(taskOccurrences)
    .where(and(eq(taskOccurrences.taskId, id), eq(taskOccurrences.occurrenceDate, today)))
    .get();
  if (todays?.skippedAt) throw badRequest("Today's already been skipped.");
  const occDate = todays ? today : task.dueAt ? task.dueAt.slice(0, 10) : today;
  if (occDate !== today) throw badRequest("That task isn't scheduled for today.");
  await db
    .insert(taskOccurrences)
    .values({ taskId: id, occurrenceDate: occDate, completedAt: null })
    .onConflictDoNothing()
    .run();
  await db
    .update(taskOccurrences)
    .set({
      completedAt: null,
      completedBy: null,
      reviewedAt: null,
      skippedAt: sql`datetime('now')`,
    })
    .where(and(eq(taskOccurrences.taskId, id), eq(taskOccurrences.occurrenceDate, occDate)))
    .run();

  // Advance the rolling row to the next scheduled day, honouring the same end
  // date / occurrence-count limits the background roll does. No next day (a
  // schedule that has run out) clears the row's due date, which is the honest
  // end state for "this repeat is over".
  const next = nextOccurrence(rec, occDate);
  const reached =
    next !== null &&
    task.recurrenceCount !== null &&
    task.recurrenceCount > 0 &&
    (occurrenceIndex(rec, next) || 0) > task.recurrenceCount;
  const nextDueAt = next && withinRange(rec, next) && !reached ? next : null;
  await db
    .update(tasks)
    .set({ dueAt: nextDueAt, completedAt: null, reviewedAt: null })
    .where(eq(tasks.id, id))
    .run();
  return { ok: true, due_at: nextDueAt, skipped: occDate } as const;
}

export async function reviewTask(db: DbClient, user: LoggedInUser, id: number, timezone?: string) {
  if (!(await hasCap(db, user, "tasks", "review"))) throw forbidden("Your role doesn't allow this action.");
  const task = await getTaskOr404(db, id);
  await db.update(tasks).set({ reviewedAt: sql`datetime('now')` }).where(eq(tasks.id, id)).run();
  const occDate = await activeOccurrenceDate(db, task, timezone);
  await db
    .update(taskOccurrences)
    .set({ reviewedAt: sql`datetime('now')` })
    .where(and(eq(taskOccurrences.taskId, id), eq(taskOccurrences.occurrenceDate, occDate)))
    .run();
  return { ok: true } as const;
}

export async function unreviewTask(db: DbClient, user: LoggedInUser, id: number, timezone?: string) {
  if (!(await hasCap(db, user, "tasks", "review"))) throw forbidden("Your role doesn't allow this action.");
  const task = await getTaskOr404(db, id);
  await db.update(tasks).set({ reviewedAt: null }).where(eq(tasks.id, id)).run();
  const occDate = await activeOccurrenceDate(db, task, timezone);
  await db
    .update(taskOccurrences)
    .set({ reviewedAt: null })
    .where(and(eq(taskOccurrences.taskId, id), eq(taskOccurrences.occurrenceDate, occDate)))
    .run();
  return { ok: true } as const;
}

export interface AssignInput {
  user_ids?: unknown;
  assigned_to?: unknown;
}

// PATCH /assign sets the assignee list for a task. Fine-grained rules:
//  - Unassigned task → volunteer (for self) or assign_others (for anyone else)
//  - Already-assigned task → reassign
//  - Each target still needs the usual assign_self/assign_others grant.
export async function assignTask(db: DbClient, user: LoggedInUser, id: number, body: AssignInput) {
  const task = await getTaskOr404(db, id);
  let userIds: number[];
  if (body.user_ids !== undefined) userIds = normalizeUserIds(body.user_ids);
  else userIds = normalizeUserIds(body.assigned_to !== undefined ? body.assigned_to : []);

  const current = await db
    .select({ userId: taskAssignees.userId })
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, task.id))
    .all();
  const wasUnassigned = current.length === 0;

  if (wasUnassigned) {
    const selfOnly = userIds.length === 1 && userIds[0] === user.id;
    if (selfOnly) {
      if (!(await hasCap(db, user, "tasks", "volunteer")) && !(await hasCap(db, user, "tasks", "assign_self"))) {
        throw forbidden("Your role doesn't allow volunteering for unassigned tasks.");
      }
    } else if (!(await hasCap(db, user, "tasks", "assign_others"))) {
      throw forbidden("Your role doesn't allow assigning tasks to other people.");
    }
  } else if (!(await hasCap(db, user, "tasks", "reassign"))) {
    throw forbidden("Your role doesn't allow reassigning tasks.");
  }

  await assertCanAssign(db, user, userIds);
  await setAssignees(db, task.id, userIds);
  return { ok: true } as const;
}

// Patch task details (name, description, due_at, etc.)
export async function updateTask(db: DbClient, user: LoggedInUser, id: number, body: TaskInput) {
  if (!(await hasCap(db, user, "tasks", "edit"))) throw forbidden("Your role doesn't allow this action.");
  const task = await getTaskOr404(db, id);

  if (body.assigned_ids !== undefined || body.assigned_to !== undefined) {
    const targetIds = normalizeUserIds(body.assigned_ids !== undefined ? body.assigned_ids : body.assigned_to);
    await assertCanAssign(db, user, targetIds);
  }

  await db
    .update(tasks)
    .set({
      name: body.name !== undefined ? body.name.trim() : task.name,
      description: body.description !== undefined ? body.description : task.description,
      categoryId: body.category_id !== undefined
        ? body.category_id
          ? Number(body.category_id)
          : null
        : task.categoryId,
      dueAt: body.due_at !== undefined ? body.due_at : task.dueAt,
      dueTime: body.due_time !== undefined ? body.due_time : task.dueTime,
      requiresAdultReview: body.requires_adult_review !== undefined ? !!body.requires_adult_review : task.requiresAdultReview,
      recurrenceType: body.recurrence_type !== undefined ? body.recurrence_type : task.recurrenceType,
      recurrenceInterval:
        body.recurrence_interval !== undefined
          ? Number(body.recurrence_interval) || 1
          : task.recurrenceInterval,
      recurrencePeriod: body.recurrence_period !== undefined ? body.recurrence_period : task.recurrencePeriod,
      recurrenceDaysOfWeek:
        body.recurrence_days_of_week !== undefined
          ? body.recurrence_days_of_week
            ? JSON.stringify(body.recurrence_days_of_week)
            : null
          : task.recurrenceDaysOfWeek,
      recurrenceStartDate:
        body.recurrence_start_date !== undefined ? body.recurrence_start_date : task.recurrenceStartDate,
      recurrenceEndDate:
        body.recurrence_end_date !== undefined ? body.recurrence_end_date : task.recurrenceEndDate,
      recurrenceCount:
        body.recurrence_count !== undefined
          ? body.recurrence_count
            ? Number(body.recurrence_count)
            : null
          : task.recurrenceCount,
      icon: body.icon !== undefined ? body.icon : task.icon,
    })
    .where(eq(tasks.id, id))
    .run();

  if (body.assigned_ids !== undefined) await setAssignees(db, task.id, body.assigned_ids);
  else if (body.assigned_to !== undefined) await setAssignees(db, task.id, body.assigned_to);

  // Re-materialize the schedule for this task and auto-resolve an empty due
  // date for recurring tasks, mirroring createTask's behaviour.
  await materializeTaskOccurrences(db, { task_id: id });
  const latest = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (latest?.recurrenceType && !latest.dueAt) {
    const first = await db
      .select({ d: sql<string | null>`MIN(occurrence_date)` })
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, id))
      .get();
    if (first?.d) await db.update(tasks).set({ dueAt: first.d }).where(eq(tasks.id, id)).run();
  }

  return { ok: true } as const;
}

export async function deleteTask(db: DbClient, user: LoggedInUser, id: number) {
  if (!(await hasCap(db, user, "tasks", "delete"))) throw forbidden("Your role doesn't allow this action.");
  await db.delete(taskAssignees).where(eq(taskAssignees.taskId, id)).run();
  await db.delete(tasks).where(eq(tasks.id, id)).run();
  return { ok: true } as const;
}

// Dashboard helper: tasks "due today or overdue" plus unassigned tasks needing
// an owner. `date` is a YYYY-MM-DD local date; when omitted it derives today in
// the viewer's timezone (from the X-Timezone header, threaded through the route).
export async function tasksToday(db: DbClient, date?: string, timezone?: string) {
  const today = date || todayStr(timezone);
  await materializeTaskOccurrences(db, { timezone });
  const dueToday = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNull(tasks.completedAt),
        or(isNull(tasks.dueAt), eq(sql`substr(due_at, 1, 10)`, today))
      )
    )
    .orderBy(sql`due_at IS NULL`, tasks.dueAt, tasks.id)
    .all();

  const unassigned = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNull(tasks.completedAt),
        notExists(
          db.select({ one: sql`1` }).from(taskAssignees).where(eq(taskAssignees.taskId, tasks.id))
        )
      )
    )
    .orderBy(tasks.id)
    .all();

  const dueTodayMapped = await annotateTodayOccurrences(
    db,
    await attachAssignees(db, dueToday.map(mapTaskRow)),
    today,
    timezone
  );
  const unassignedMapped = await annotateTodayOccurrences(
    db,
    await attachAssignees(db, unassigned.map(mapTaskRow)),
    today,
    timezone
  );

  return {
    date: today,
    dueToday: dueTodayMapped,
    unassigned: unassignedMapped,
  };
}