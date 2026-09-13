import { and, eq, exists, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { DbClient } from "./db.js";
import { getSetting } from "./db.js";
import { taskAssignees, taskCategories, taskPriorities, tasks, users } from "../schema.js";
import { badRequest, forbidden, notFound } from "./errors.js";
import { hasCap, canAssign, type LoggedInUser } from "./caps.js";
import { autoAssignIcon } from "../modules/tasks/icon-catalog.js";
import { nextOccurrence, withinRange, occurrenceIndex, todayStr } from "../modules/tasks/recurrence.js";

// ---------------------------------------------------------------------------
// Wire shapes. The rest of the app consumes snake_case rows, so Drizzle rows
// (camelCase) are mapped to the exact shape the old raw-SQL handlers sent.
// ---------------------------------------------------------------------------

export interface TaskWire {
  id: number;
  name: string;
  description: string | null;
  category_id: number | null;
  priority_id: number | null;
  dollar_value: number | null;
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
  assignees?: { id: number; name: string }[];
  assigned_to?: number | null;
  category_name?: string | null;
  priority_name?: string | null;
}

type DrizzleTask = typeof tasks.$inferSelect;

export function mapTaskRow(t: DrizzleTask): TaskWire {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category_id: t.categoryId,
    priority_id: t.priorityId,
    dollar_value: t.dollarValue,
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

interface PriorityWire {
  id: number;
  name: string;
  sort: number;
  created_at: string;
}

function mapPriorityRow(p: typeof taskPriorities.$inferSelect): PriorityWire {
  return { id: p.id, name: p.name, sort: p.sort, created_at: p.createdAt };
}

// ---------------------------------------------------------------------------
// Task read/write helpers
// ---------------------------------------------------------------------------

export async function listTasks(db: DbClient, user: LoggedInUser, query: { user_id?: string | number } = {}) {
  const requestedUser = query.user_id ? Number(query.user_id) : null;

  if (requestedUser && !(await hasCap(db, user, "tasks", "view_others")) && requestedUser !== user.id) {
    throw forbidden("Your role doesn't allow viewing that member's tasks.");
  }

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

  return attachAssignees(db, rows.map(mapTaskRow));
}

// Task settings flags (admin-managed); any authenticated user may read them.
export async function taskSettings(db: DbClient) {
  return {
    enable_categories: (await getSetting(db, "tasks_enable_categories")) !== "0",
    enable_priorities: (await getSetting(db, "tasks_enable_priorities")) !== "0",
    enable_dollar: (await getSetting(db, "tasks_enable_dollar")) === "1",
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

// Attach assignees/category/priority names to wire tasks, mirroring the old
// raw-SQL join helpers. Adds `assignees`, `assigned_to`, `category_name`,
// `priority_name`.
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

  const priIds = [...new Set(tasksOut.map((t) => t.priority_id).filter((v): v is number => !!v))];
  const priNames = new Map<number, string>();
  if (priIds.length) {
    const pris = await db
      .select({ id: taskPriorities.id, name: taskPriorities.name })
      .from(taskPriorities)
      .where(inArray(taskPriorities.id, priIds))
      .all();
    for (const p of pris) priNames.set(p.id, p.name);
  }

  for (const t of tasksOut) {
    const list = byTask.get(t.id) ?? [];
    t.assignees = list;
    t.assigned_to = list.length ? list[0].id : null;
    t.category_name = catNames.get(t.category_id ?? -1) ?? null;
    t.priority_name = priNames.get(t.priority_id ?? -1) ?? null;
  }
  return tasksOut;
}

// Recurrence helpers read the legacy snake_case DB row shape.
function recurrenceTask(t: DrizzleTask): TaskWire & { created_at: string } {
  const wire = mapTaskRow(t);
  return { ...wire, created_at: wire.created_at };
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
// Priorities
// ---------------------------------------------------------------------------

export async function listPriorities(db: DbClient): Promise<PriorityWire[]> {
  const rows = await db.select().from(taskPriorities).orderBy(taskPriorities.sort, taskPriorities.id).all();
  return rows.map(mapPriorityRow);
}

export async function createPriority(
  db: DbClient,
  input: { name: string; sort?: number }
): Promise<PriorityWire> {
  const { name } = input;
  if (!name || !name.trim()) throw badRequest("name is required");
  const existing = await db.select({ id: taskPriorities.id }).from(taskPriorities).where(eq(taskPriorities.name, name.trim())).get();
  if (existing) throw badRequest("That priority already exists");

  let nextSort = input.sort !== undefined ? Number(input.sort) : NaN;
  if (Number.isNaN(nextSort)) {
    const max = await db.select({ m: sql<number>`COALESCE(MAX(sort), 0)` }).from(taskPriorities).get();
    nextSort = (max?.m ?? 0) + 1;
  }
  const [row] = await db.insert(taskPriorities).values({ name: name.trim(), sort: nextSort }).returning().all();
  return mapPriorityRow(row);
}

export async function updatePriority(
  db: DbClient,
  id: number,
  input: { name?: string; sort?: number }
): Promise<PriorityWire> {
  const existing = await db.select().from(taskPriorities).where(eq(taskPriorities.id, id)).get();
  if (!existing) throw notFound("Not found");

  const { name, sort } = input;
  await db
    .update(taskPriorities)
    .set({
      name: name !== undefined ? name.trim() : existing.name,
      sort: sort !== undefined ? (Number(sort) || existing.sort) : existing.sort,
    })
    .where(eq(taskPriorities.id, id))
    .run();
  const updated = await db.select().from(taskPriorities).where(eq(taskPriorities.id, id)).get();
  return mapPriorityRow(updated!);
}

export async function deletePriority(db: DbClient, id: number): Promise<void> {
  await db.delete(taskPriorities).where(eq(taskPriorities.id, id)).run();
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

export interface TaskInput {
  name?: string;
  description?: string | null;
  category_id?: number | string | null;
  priority_id?: number | string | null;
  dollar_value?: number | string | null | undefined;
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
      priorityId:
        body.priority_id !== undefined
          ? body.priority_id
            ? Number(body.priority_id)
            : null
          : null,
      dollarValue:
        body.dollar_value !== undefined && body.dollar_value !== null && body.dollar_value !== ""
          ? Number(body.dollar_value) || null
          : null,
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

  const [out] = await attachAssignees(db, [mapTaskRow(row)]);
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
// does NOT count as fully done until an adult also reviews it.
export async function completeTask(db: DbClient, user: LoggedInUser, id: number) {
  const task = await getTaskOr404(db, id);
  await assertCanComplete(db, user, task);

  const rec = recurrenceTask(task);
  const nowDate = todayStr();
  const next = task.recurrenceType ? nextOccurrence(rec, nowDate) : null;

  const afterN = task.recurrenceCount;
  const reachedCount = afterN !== null && afterN > 0 && next !== null && (occurrenceIndex(rec, next) || 0) > afterN;

  if (next && withinRange(rec, next) && !reachedCount) {
    // Roll over: same row becomes the next instance
    await db
      .update(tasks)
      .set({ dueAt: next, completedAt: null, reviewedAt: null })
      .where(eq(tasks.id, id))
      .run();
  } else {
    await db.update(tasks).set({ completedAt: sql`datetime('now')` }).where(eq(tasks.id, id)).run();
  }
  return { ok: true } as const;
}

// Undo completion (also usable for a recurring task that already rolled over).
export async function uncompleteTask(db: DbClient, user: LoggedInUser, id: number) {
  const task = await getTaskOr404(db, id);
  await assertCanComplete(db, user, task);
  await db.update(tasks).set({ completedAt: null, reviewedAt: null }).where(eq(tasks.id, id)).run();
  return { ok: true } as const;
}

export async function reviewTask(db: DbClient, user: LoggedInUser, id: number) {
  if (!(await hasCap(db, user, "tasks", "review"))) throw forbidden("Your role doesn't allow this action.");
  await db.update(tasks).set({ reviewedAt: sql`datetime('now')` }).where(eq(tasks.id, id)).run();
  return { ok: true } as const;
}

export async function unreviewTask(db: DbClient, user: LoggedInUser, id: number) {
  if (!(await hasCap(db, user, "tasks", "review"))) throw forbidden("Your role doesn't allow this action.");
  await db.update(tasks).set({ reviewedAt: null }).where(eq(tasks.id, id)).run();
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
      priorityId: body.priority_id !== undefined
        ? body.priority_id
          ? Number(body.priority_id)
          : null
        : task.priorityId,
      dollarValue:
        body.dollar_value !== undefined
          ? body.dollar_value === null || body.dollar_value === ""
            ? null
            : Number(body.dollar_value) || null
          : task.dollarValue,
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

  return { ok: true } as const;
}

export async function deleteTask(db: DbClient, user: LoggedInUser, id: number) {
  if (!(await hasCap(db, user, "tasks", "delete"))) throw forbidden("Your role doesn't allow this action.");
  await db.delete(taskAssignees).where(eq(taskAssignees.taskId, id)).run();
  await db.delete(tasks).where(eq(tasks.id, id)).run();
  return { ok: true } as const;
}

// Dashboard helper: tasks "due today or overdue" plus unassigned tasks needing
// an owner. `date` is a YYYY-MM-DD local date (defaults to today).
export async function tasksToday(db: DbClient, date: string = todayStr()) {
  const dueToday = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNull(tasks.completedAt),
        or(isNull(tasks.dueAt), eq(sql`substr(due_at, 1, 10)`, date))
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

  return {
    date,
    dueToday: await attachAssignees(db, dueToday.map(mapTaskRow)),
    unassigned: await attachAssignees(db, unassigned.map(mapTaskRow)),
  };
}