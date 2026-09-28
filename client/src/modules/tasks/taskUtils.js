// Shared client-side helpers for computing a task's "outstanding" state.
// The server stamps each task with its canonical `today` (YYYY-MM-DD), so
// consumers can bucket consistently around midnight in the viewer's timezone.

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Shift a YYYY-MM-DD day by n days. Noon-anchored so a DST jump can't slide the
// result onto the neighbouring day.
export function addDaysStr(day, n) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Fully done = completed AND (when it requires an adult) reviewed.
export function isFullyDone(task) {
  return !!task.completed_at && (!task.requires_adult_review || task.reviewed_at);
}

// Due today = the server found an instance scheduled for today (`due_today`),
// or `due_at` itself lands on today. The flag matters for repeats: once a
// rolling row has advanced to a later day, `due_at` alone would file a task
// that is still scheduled for today under "upcoming".
export function isDueToday(task, today) {
  if (task.due_today) return true;
  const due = task.due_at ? task.due_at.slice(0, 10) : null;
  return due === today;
}

// An "outstanding" task for badges: not fully done AND (scheduled for today, no
// due date, or due today or overdue). This mirrors the dashboard's "today's
// tasks" predicate (open tasks with no due date or due <= today, plus anything
// with an instance today), so the count by a member's avatar matches what the
// dashboard lists for them. Recurring tasks are rolled forward to their next
// occurrence server-side, so only non-recurring tasks can ever be overdue here.
export function isOutstanding(task, today) {
  if (isFullyDone(task)) return false;
  if (isDueToday(task, today)) return true;
  const due = task.due_at ? task.due_at.slice(0, 10) : null;
  return !due || due <= today;
}

// "Skip today" is offered for a daily-cadence repeat that is actually on the
// board for today (its row may already have rolled to tomorrow while an instance
// for today is still pending, which `isDueToday` covers). Weekly/monthly/yearly
// patterns are left out on purpose: there "skip today" would really mean "skip
// this week's", which is a different decision than the one the button names.
export function isSkippable(task, today) {
  if (!task.recurrence_type) return false;
  const daily =
    task.recurrence_type === "daily" ||
    task.recurrence_type === "weekdays" ||
    task.recurrence_type === "weekends" ||
    (task.recurrence_type === "custom" && (task.recurrence_period || "day") === "day");
  return daily && isDueToday(task, today);
}

// Which list section a task belongs to, using the same notion of "today" as the
// dashboard's "today's tasks" panel — an open task is today's work when it has
// an instance today, carries no due date at all, or its due date has arrived.
//   outstanding    - not done, and today's work (overdue only when non-repeating,
//                    since repeats roll to their next occurrence server-side)
//   upcoming       - not done and due within the next 7 days (a repeat that is
//                    still on today's board is already filed as outstanding)
//   completedToday - finished today
//   rest           - everything else (finished earlier, due further out)
export function taskBucket(task, today) {
  if (task.completed_at) {
    // completed_at is a UTC instant, so its first 10 characters are the UTC day,
    // not the day the task was done on — they disagree for the last |UTC offset|
    // hours of every evening. The server sends the viewer's own day alongside it.
    const day = task.completed_day || task.completed_at.slice(0, 10);
    return day === today ? "completedToday" : "rest";
  }
  const due = task.due_at ? task.due_at.slice(0, 10) : null;
  if (!due || isDueToday(task, today) || (due < today && !task.recurrence_type)) {
    return "outstanding";
  }
  // A repeat is normally on today's board (an instance for today), which the
  // branch above already filed as outstanding. The ones that reach here are the
  // days a skip took off, so a daily task can legitimately sit in "upcoming"
  // until its next turn.
  if (due > today && due <= addDaysStr(today, 7)) return "upcoming";
  return "rest";
}