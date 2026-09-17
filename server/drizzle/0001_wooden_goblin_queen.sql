CREATE TABLE `task_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`occurrence_date` text NOT NULL,
	`completed_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_by` integer,
	`reviewed_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`completed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_occurrences_task_date` ON `task_occurrences` (`task_id`,`occurrence_date`);