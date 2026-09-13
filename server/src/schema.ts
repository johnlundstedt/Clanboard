import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Clanboard schema — single source of truth for BOTH deploy targets.
// Container (better-sqlite3) and Cloudflare (D1) share these table definitions;
// migrations are generated from here via `npm run db:generate`.

// ---------------------------------------------------------------------------
// Household (core)
// ---------------------------------------------------------------------------

export const membersRoles = sqliteTable("member_roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  photoUrl: text("photo_url"),
  birthday: text("birthday"),
  gender: text("gender"),
  roleId: integer("role_id").references(() => membersRoles.id, {
    onDelete: "set null",
  }),
  navScope: text("nav_scope").notNull().default("all"),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  isKiosk: integer("is_kiosk", { mode: "boolean" }).notNull().default(false),
  systemAccount: integer("system_account", { mode: "boolean" })
    .notNull()
    .default(false),
  passwordHash: text("password_hash"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const roleModules = sqliteTable(
  "role_modules",
  {
    roleId: integer("role_id")
      .notNull()
      .references(() => membersRoles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    caps: text("caps"),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.name] })]
);

export const modules = sqliteTable("modules", {
  name: text("name").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

export const userModules = sqliteTable(
  "user_modules",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.name] })]
);

export const sessions = sqliteTable("sessions", {
  sid: text("sid").primaryKey(),
  data: text("data"),
  expiresAt: integer("expires_at"),
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const taskCategories = sqliteTable("task_categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  color: text("color"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const taskPriorities = sqliteTable("task_priorities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  sort: integer("sort").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  categoryId: integer("category_id").references(() => taskCategories.id, {
    onDelete: "set null",
  }),
  priorityId: integer("priority_id").references(() => taskPriorities.id, {
    onDelete: "set null",
  }),
  dollarValue: real("dollar_value"),
  dueAt: text("due_at"),
  requiresAdultReview: integer("requires_adult_review", { mode: "boolean" })
    .notNull()
    .default(false),
  completedAt: text("completed_at"),
  reviewedAt: text("reviewed_at"),
  recurrenceType: text("recurrence_type"),
  recurrenceInterval: integer("recurrence_interval").notNull().default(1),
  recurrencePeriod: text("recurrence_period"),
  recurrenceDaysOfWeek: text("recurrence_days_of_week"),
  recurrenceStartDate: text("recurrence_start_date"),
  recurrenceEndDate: text("recurrence_end_date"),
  recurrenceCount: integer("recurrence_count"),
  dueTime: text("due_time"),
  icon: text("icon"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const taskAssignees = sqliteTable(
  "task_assignees",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index("idx_task_assignees_user").on(t.userId),
  ]
);

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export const lists = sqliteTable("lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const listItems = sqliteTable("list_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  listId: integer("list_id")
    .notNull()
    .references(() => lists.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  checked: integer("checked", { mode: "boolean" }).notNull().default(false),
  addedBy: text("added_by"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ---------------------------------------------------------------------------
// Meal plan
// ---------------------------------------------------------------------------

export const mealPlan = sqliteTable(
  "meal_plan",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    mealSlot: text("meal_slot").notNull(),
    text: text("text"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [uniqueIndex("idx_meal_plan_date_slot").on(t.date, t.mealSlot)]
);

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const calendarConnections = sqliteTable("calendar_connections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull().default("google"),
  label: text("label"),
  calendarId: text("calendar_id").notNull(),
  apiKey: text("api_key"),
  color: text("color"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const calendarCache = sqliteTable(
  "calendar_cache",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => calendarConnections.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    summary: text("summary"),
    location: text("location"),
    description: text("description"),
    startAt: text("start_at"),
    endAt: text("end_at"),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    color: text("color"),
  },
  (t) => [uniqueIndex("idx_calendar_cache_conn_event").on(t.connectionId, t.eventId)]
);