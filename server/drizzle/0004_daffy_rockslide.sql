DELETE FROM `settings` WHERE `key` IN ('tasks_enable_priorities', 'tasks_enable_dollar');

-- NOTE: the task_priorities table and the tasks.priority_id / tasks.dollar_value
-- columns are removed at boot by the guarded tasks module cleanup
-- (modules/tasks/task-schema-cleanup.js), not by drizzle here: SQLite refuses a
-- bare DROP COLUMN while priority_id is part of a FOREIGN KEY constraint.