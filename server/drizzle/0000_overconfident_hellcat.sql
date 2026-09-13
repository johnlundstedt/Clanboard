CREATE TABLE `calendar_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`event_id` text NOT NULL,
	`summary` text,
	`location` text,
	`description` text,
	`start_at` text,
	`end_at` text,
	`all_day` integer DEFAULT false NOT NULL,
	`color` text,
	FOREIGN KEY (`connection_id`) REFERENCES `calendar_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_calendar_cache_conn_event` ON `calendar_cache` (`connection_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `calendar_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text DEFAULT 'google' NOT NULL,
	`label` text,
	`calendar_id` text NOT NULL,
	`api_key` text,
	`color` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `list_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list_id` integer NOT NULL,
	`text` text NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`added_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meal_plan` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`meal_slot` text NOT NULL,
	`text` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meal_plan_date_slot` ON `meal_plan` (`date`,`meal_slot`);--> statement-breakpoint
CREATE TABLE `member_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_roles_name_unique` ON `member_roles` (`name`);--> statement-breakpoint
CREATE TABLE `modules` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_modules` (
	`role_id` integer NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`caps` text,
	PRIMARY KEY(`role_id`, `name`),
	FOREIGN KEY (`role_id`) REFERENCES `member_roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`sid` text PRIMARY KEY NOT NULL,
	`data` text,
	`expires_at` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `task_assignees` (
	`task_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_task_assignees_user` ON `task_assignees` (`user_id`);--> statement-breakpoint
CREATE TABLE `task_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_categories_name_unique` ON `task_categories` (`name`);--> statement-breakpoint
CREATE TABLE `task_priorities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_priorities_name_unique` ON `task_priorities` (`name`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category_id` integer,
	`priority_id` integer,
	`dollar_value` real,
	`due_at` text,
	`requires_adult_review` integer DEFAULT false NOT NULL,
	`completed_at` text,
	`reviewed_at` text,
	`recurrence_type` text,
	`recurrence_interval` integer DEFAULT 1 NOT NULL,
	`recurrence_period` text,
	`recurrence_days_of_week` text,
	`recurrence_start_date` text,
	`recurrence_end_date` text,
	`recurrence_count` integer,
	`due_time` text,
	`icon` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `task_categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`priority_id`) REFERENCES `task_priorities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `user_modules` (
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`user_id`, `name`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`photo_url` text,
	`birthday` text,
	`gender` text,
	`role_id` integer,
	`nav_scope` text DEFAULT 'all' NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`is_kiosk` integer DEFAULT false NOT NULL,
	`system_account` integer DEFAULT false NOT NULL,
	`password_hash` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `member_roles`(`id`) ON UPDATE no action ON DELETE set null
);
