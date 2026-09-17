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

// An "outstanding" task for a badge: not fully done AND due today or overdue.
// Recurring tasks are rolled forward to their next occurrence server-side, so
// only non-recurring tasks can ever be overdue here.
export function isOutstandingDueTodayOrOverdue(task, today) {
  if (isFullyDone(task)) return false;
  const due = task.due_at ? task.due_at.slice(0, 10) : null;
  return !!due && (due === today || (due < today && !task.recurrence_type));
}