// Shared client-side helpers for computing a task's "outstanding" state.
// The server stamps each task with its canonical `today` (YYYY-MM-DD), so
// consumers can bucket consistently around midnight in the viewer's timezone.

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Fully done = completed AND (when it requires an adult) reviewed.
export function isFullyDone(task) {
  return !!task.completed_at && (!task.requires_adult_review || task.reviewed_at);
}

// An "outstanding" task for badges: not fully done AND (no due date, or due
// today or overdue). This mirrors the dashboard's "today's tasks" predicate
// (open tasks with no due date or due <= today), so the count by a member's
// avatar matches what the dashboard lists for them. Recurring tasks are rolled
// forward to their next occurrence server-side, so only non-recurring tasks can
// ever be overdue here.
export function isOutstanding(task, today) {
  if (isFullyDone(task)) return false;
  const due = task.due_at ? task.due_at.slice(0, 10) : null;
  return !due || due <= today;
}