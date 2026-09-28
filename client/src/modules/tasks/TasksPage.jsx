import { useCallback, useEffect, useMemo, useState } from "react";
import { Users, MoreVertical } from "lucide-react";
import Avatar from "../../components/Avatar.jsx";
import { TaskIcon } from "../../components/IconPicker.jsx";
import TaskForm from "./TaskForm.jsx";
import {
  getTasks, getMembers, createTask, updateTask, deleteTask,
  completeTask, uncompleteTask, skipTask, reviewTask, unreviewTask,
  getTaskSettings, getTaskCategories,
} from "../../api.js";
import { usePolling } from "../../realtime.js";
import { isFullyDone, isOutstanding, isSkippable, taskBucket, todayStr } from "./taskUtils.js";

// Whole-day difference `later` – `earlier` for YYYY-MM-DD strings.
function daysBetween(later, earlier) {
  const [ly, lm, ld] = later.split("-").map(Number);
  const [ey, em, ed] = earlier.split("-").map(Number);
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(ey, em - 1, ed)) / 86400000);
}

export default function TasksPage({ user, memberId, member, taskTarget, onTaskTargetConsumed }) {
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [showingForm, setShowingForm] = useState(false);
  const [editing, setEditing] = useState(null);
  // A dashboard "unassigned task" tap arrives with a taskId: open that task's
  // editor once its row is loaded, on the whole-family list so it's always
  // visible (it has no assignee to filter by).
  const [pendingEditId, setPendingEditId] = useState(taskTarget?.taskId || null);
  // null = everyone; defaults to the logged-in user, or to the member whose
  // dashboard row was tapped (taskTarget) if we're arriving via that hop. A
  // targeted unassigned task has no assignee, so keep the filter off.
  const [memberFilter, setMemberFilter] = useState(
    () => taskTarget?.taskId != null
      ? null
      : (taskTarget?.memberId ?? (user && !user.is_kiosk ? user.id : null))
  );
  const [categories, setCategories] = useState([]);
  const [settings, setSettings] = useState({});
  const [viewMode, setViewMode] = useState(taskTarget?.mode || "today"); // 'today' | 'upcoming' | 'all'
  // Task id whose options menu (⋮) is open, or null. One at a time, so a second
  // tap anywhere else just moves the menu.
  const [menuFor, setMenuFor] = useState(null);

  // The target is one-shot: consume it so the next plain "Tasks" nav starts at
  // the member's own default view instead of replaying the last dashboard tap.
  useEffect(() => {
    if (taskTarget) onTaskTargetConsumed?.();
  }, [taskTarget, onTaskTargetConsumed]);

  // When the target names a task, open its editor once the row has loaded so
  // the form is pre-filled (and the user can assign it right away).
  useEffect(() => {
    if (pendingEditId == null) return;
    const found = tasks.find((t) => t.id === pendingEditId);
    if (!found) return;
    setEditing(found);
    setShowingForm(false);
    setMemberFilter(null);
    setPendingEditId(null);
  }, [pendingEditId, tasks]);

  const refresh = useCallback(async () => {
    const [t, m, s, cats] = await Promise.all([
      getTasks(memberId || undefined), getMembers(), getTaskSettings(),
      getTaskCategories(),
    ]);
    setTasks(t);
    setMembers(m);
    setSettings(s);
    setCategories(cats);
  }, [memberId]);

  usePolling("tasks", refresh);
  usePolling("users", refresh);

  useEffect(() => { refresh(); }, [refresh]);

  // Bucket the list with the server's canonical "today" (stamped on each task
  // by /api/tasks) — the same day that drives the schedules and due_at values.
  // Falling back to the browser's local date around midnight made daily tasks
  // (due "tomorrow" per the server) vanish from every section while their
  // avatar badge still counted them.
  const today = (tasks[0] && tasks[0].today) || todayStr();

  // System accounts (kiosk/wall-display logins) don't take part in tasks, so
  // keep them out of the assignee picker, the member filter bar, and the
  // per-member due counters.
  const taskMembers = useMemo(
    () => members.filter((m) => !m.system_account),
    [members]
  );

  // The list is bucketed the same way on every view; the Today / Upcoming / All
  // toggle picks which buckets are shown. `taskBucket` owns the rule (shared with
  // the badges and the server tests) so this page and the dashboard's "today's
  // tasks" panel can never drift apart on what counts as due today:
  //   1. Today's Outstanding — not done, and today's work: an instance today, a
  //      due date today, no due date at all, or (non-repeating only) overdue.
  //      Overdue tasks render with an "Overdue X days" badge.
  //   2. Upcoming — not done and due within the next 7 days. A repeat still on
  //      today's board is already in "today", so what lands here is a repeat
  //      whose day was skipped.
  //   3. Today's Completed — anything finished sometime today (its instance or
  //      completed_at date matches today's local date).
  //   4. All Other — the remainder (completed earlier, due further out, etc.).
  // Repeating tasks are rolled to their next occurrence once a day passes, so
  // only non-repeating tasks can ever be "overdue" in this list.
  const sections = useMemo(() => {
    let list = tasks;
    if (memberFilter) {
      list = list.filter((t) => (t.assignees || []).some((a) => a.id === memberFilter));
    }
    const byDue = (a, b) => {
      const ad = a.due_at ? a.due_at.slice(0, 10) : "9999-99-99";
      const bd = b.due_at ? b.due_at.slice(0, 10) : "9999-99-99";
      return ad.localeCompare(bd) || a.id - b.id;
    };

    const outstanding = [];
    const upcoming = [];
    const completedToday = [];
    const rest = [];
    for (const t of list) {
      const bucket = taskBucket(t, today);
      if (bucket === "outstanding") outstanding.push(t);
      else if (bucket === "upcoming") upcoming.push(t);
      else if (bucket === "completedToday") completedToday.push(t);
      else rest.push(t);
    }
    outstanding.sort(byDue);
    upcoming.sort(byDue);
    completedToday.sort(
      (a, b) => String(b.completed_at).localeCompare(String(a.completed_at)) || a.id - b.id
    );
    rest.sort(byDue);
    return { outstanding, upcoming, completedToday, rest };
  }, [tasks, memberFilter, today]);

  const openNew = () => { setEditing(null); setShowingForm(true); };
  const cancelForm = () => { setShowingForm(false); setEditing(null); };

  async function handleSubmit(task) {
    const { _split, ...fields } = task;
    if (editing) {
      await updateTask(editing.id, fields);
    } else if (_split && (fields.assigned_ids || []).length > 1) {
      // Separate task per assignee: create one copy for each person
      await Promise.all(
        fields.assigned_ids.map((uid) => createTask({ ...fields, assigned_ids: [uid] }))
      );
    } else {
      await createTask(fields);
    }
    cancelForm();
    refresh();
  }

  async function toggleComplete(task) {
    if (task.completed_at) await uncompleteTask(task.id);
    else await completeTask(task.id);
    refresh();
  }

  async function toggleReview(task) {
    if (task.reviewed_at) await unreviewTask(task.id);
    else await reviewTask(task.id);
    refresh();
  }

  // Call off today's occurrence of a repeat: the task leaves today's list and
  // comes back on its next scheduled day. The checkbox is the reverse move
  // (unchecking), so this lives in the row's ⋮ menu rather than on the row.
  async function handleSkip(task) {
    setMenuFor(null);
    await skipTask(task.id);
    refresh();
  }

  function startEdit(task) {
    setMenuFor(null);
    setEditing(task);
    setShowingForm(false);
  }

  async function handleDelete(task) {
    if (confirm(`Delete "${task.name}"?`)) {
      await deleteTask(task.id);
      if (editing?.id === task.id) cancelForm();
      refresh();
    }
  }

  const memberById = useMemo(() => Object.fromEntries(taskMembers.map((m) => [m.id, m])), [taskMembers]);
  const adult = !!user?.is_admin;

  // Capability shortcuts for the current user (admins / kiosk have everything).
  const caps = user?.caps?.tasks || {};
  // Creating requires `create`; on a member-scoped view (kiosk member selected)
  // the task is created for that member, so `create` alone is the gate and the
  // "unassigned" flavour only matters on the whole-family view.
  const canCreate =
    adult || user?.is_kiosk ||
    (memberId ? !!caps.create : !!caps.create && !!caps.create_unassigned);
  const canCreateUnassigned = adult || user?.is_kiosk || !!caps.create_unassigned;
  const canEdit = adult || user?.is_kiosk || !!caps.edit;
  const canDelete = adult || user?.is_kiosk || !!caps.delete;
  const canReview = adult || user?.is_kiosk || !!caps.review;
  const canViewOthers = adult || user?.is_kiosk || !!caps.view_others;

  // Standalone members with view_others can flip between everyone and a single
  // member's tasks. On the kiosk the memberId prop is already scoped server-side
  // and the left-hand sidebar is the member picker, so skip the extra avatar bar.
  const showMemberFilter = user?.is_kiosk ? false : !memberId && canViewOthers;
  const counts = useMemo(() => {
    const c = {};
    for (const m of taskMembers) {
      const mine = tasks.filter((t) => (t.assignees || []).some((a) => a.id === m.id));
      c[m.id] = {
        total: mine.length,
        // All not-fully-done tasks (any due date), for the green "all done" ✓.
        incomplete: mine.filter((t) => !isFullyDone(t)).length,
        // The badge number: outstanding tasks (no due date, or due today or
        // overdue) — the same predicate the dashboard uses for "today's tasks".
        dueCount: mine.filter((t) => isOutstanding(t, today)).length,
      };
    }
    return c;
  }, [tasks, taskMembers, today]);

  // Avatar bar order: oldest first by birthday, members without a birthday last.
  const memberPicks = useMemo(
    () => [...taskMembers].sort((a, b) => {
      if (!a.birthday && !b.birthday) return 0;
      if (!a.birthday) return 1;
      if (!b.birthday) return -1;
      return a.birthday.localeCompare(b.birthday);
    }),
    [taskMembers]
  );

  // On the kiosk, the heading names whose tasks are shown (sidebar selection);
  // for a logged-in user it stays the generic module title.
  const title = user?.is_kiosk
    ? memberId
      ? `${member?.name || "Member"}’s Tasks`
      : `${user.family_name || "Clanboard"} Clan’s Tasks`
    : "Tasks";

  // Show the assignee avatars on each task only on the whole-family view.
  const showAssignees = showMemberFilter && memberFilter === null;

  return (
    <div>
      <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: "1rem", gap: "0.6rem" }}>
        <h1 style={{ margin: 0 }}>{title}</h1>
        <span className="row" style={{ gap: "0.6rem" }}>
          <div className="view-toggle" role="group" aria-label="Task view">
            {[
              { mode: "today", label: "Today" },
              { mode: "upcoming", label: "Upcoming" },
              { mode: "all", label: "All" },
            ].map(({ mode, label }) => (
              <button
                key={mode}
                className={viewMode === mode ? "active" : ""}
                onClick={() => setViewMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          {canCreate && <button className="primary" onClick={openNew}>+ New task</button>}
        </span>
      </div>

      {(showingForm || editing) && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <TaskForm
            key={editing?.id ?? "new"}
            members={taskMembers}
            categories={categories}
            settings={settings}
            initial={editing}
            defaultAssigneeIds={memberFilter ? [memberFilter] : []}
            canDelete={canDelete}
            onSubmit={handleSubmit}
            onCancel={cancelForm}
            onDelete={handleDelete}
          />
        </div>
      )}

      {showMemberFilter && (
        <div className="row wrap" style={{ gap: "0.6rem", marginBottom: "0.75rem" }}>
          <button
            className={`member-pick ${!memberFilter ? "active" : ""}`}
            onClick={() => setMemberFilter(null)}
            title="Show everyone's tasks"
          >
            <span className="avatar"><Users size={18} /></span>
            <span className="member-name">Everyone</span>
          </button>

          {memberPicks.map((m) => (
            <button
              key={m.id}
              className={`member-pick ${memberFilter === m.id ? "active" : ""}`}
              onClick={() => setMemberFilter(m.id)}
              title={m.name}
            >
              <span className="avatar-wrap">
                <Avatar user={m} />
                {counts[m.id]?.total > 0 && (
                  counts[m.id].dueCount > 0
                    ? <span className="avatar-badge" title={`${counts[m.id].dueCount} task${counts[m.id].dueCount === 1 ? "" : "s"} outstanding`}>{counts[m.id].dueCount}</span>
                    : counts[m.id].incomplete === 0
                      ? <span className="avatar-badge green" title="All tasks done">✓</span>
                      : null
                )}
              </span>
              <span className="member-name">{m.name.split(" ")[0]}</span>
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gap: "1.25rem" }}>
        {[
          { key: "outstanding", heading: "Today’s Outstanding Tasks", empty: "Nothing outstanding — all caught up!" },
          { key: "upcoming", heading: "Upcoming Tasks", empty: "No upcoming tasks." },
          { key: "completedToday", heading: "Today’s Completed Tasks", empty: "No tasks completed today yet." },
          { key: "rest", heading: "All Other Tasks", empty: "No other tasks." },
        ]
          .filter(({ key }) =>
            viewMode === "today" ? key === "outstanding" || key === "completedToday"
              : viewMode === "upcoming" ? key === "upcoming"
                : true
          )
          .map(({ key, heading, empty }) => (
            <TaskSection key={key} heading={heading} count={sections[key].length}>
              {sections[key].map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  user={user}
                  memberById={memberById}
                  adult={adult}
                  today={today}
                  showAssignees={showAssignees}
                  canEdit={canEdit}
                  canReview={canReview}
                  menuOpen={menuFor === t.id}
                  onToggleComplete={toggleComplete}
                  onToggleReview={toggleReview}
                  onSkip={handleSkip}
                  onEdit={startEdit}
                  onMenuToggle={() => setMenuFor(menuFor === t.id ? null : t.id)}
                  onMenuClose={() => setMenuFor(null)}
                />
              ))}
              {sections[key].length === 0 && (
                <div className="card muted">{empty}</div>
              )}
            </TaskSection>
          ))}
      </div>
    </div>
  );
}

function TaskSection({ heading, count, children }) {
  return (
    <section>
      <h2 className="small muted" style={{ margin: "0 0 0.4rem" }}>
        {heading}
        {count > 0 && <span> ({count})</span>}
      </h2>
      <div style={{ display: "grid", gap: "0.6rem" }}>
        {children}
      </div>
    </section>
  );
}

function dayShort(code) {
  return { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" }[code] || code;
}

function repeatLabel(task) {
  const t = task.recurrence_type;
  if (!t) return "";
  if (t === "daily") return "daily";
  if (t === "weekdays") return "weekdays";
  if (t === "weekends") return "weekends";
  const n = Number(task.recurrence_interval) || 1;
  const p = task.recurrence_period || "day";
  return `every ${n} ${n === 1 ? p : `${p}s`}`;
}

function repeatDays(task) {
  if (task.recurrence_type === "weekdays") return `${dayShort("MO")}–${dayShort("FR")}`;
  if (task.recurrence_type === "weekends") return `${dayShort("SA")}–${dayShort("SU")}`;
  if (task.recurrence_period !== "week") return "";
  try {
    return JSON.parse(task.recurrence_days_of_week || "[]").map(dayShort).join(" ");
  } catch {
    return "";
  }
}

function dueLabel(task) {
  if (!task.due_at && !task.due_time) return "No due date";
  let label = "";
  if (task.due_at) {
    const d = new Date(`${task.due_at.slice(0, 10)}T12:00:00`);
    label = `Due ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  } else {
    label = "Due";
  }
  if (task.due_time) {
    const [h, m] = task.due_time.split(":").map(Number);
    const t = new Date(2000, 0, 1, h, m);
    label += ` at ${t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return label;
}

function TaskRow({
  task, user, memberById, adult, today, showAssignees, canEdit, canReview,
  menuOpen, onToggleComplete, onToggleReview, onSkip, onEdit, onMenuToggle, onMenuClose,
}) {
  const dueDate = task.due_at ? task.due_at.slice(0, 10) : null;
  const overdue = !!dueDate && dueDate < today && !task.completed_at;
  const daysOverdue = overdue ? daysBetween(today, dueDate) : 0;
  const awaitingReview = task.completed_at && task.requires_adult_review && !task.reviewed_at;
  const fullyDone = isFullyDone(task);

  const caps = user?.caps?.tasks || {};
  // Completing is allowed with either complete_own or complete_others (mirrors server assertCanComplete).
  const canComplete = adult || user?.is_kiosk || caps.complete_own || caps.complete_others;
  // The menu's actions: skipping rides the same permission as ticking the box
  // off, editing keeps its own `edit` cap.
  const canSkip = canComplete && isSkippable(task, today);
  const hasMenu = canSkip || canEdit;

  return (
    <div className="card row wrap" style={{ gap: "0.75rem" }}>
      <input
        type="checkbox"
        className="check"
        checked={isFullyDone(task)}
        disabled={!canComplete}
        onChange={() => onToggleComplete(task)}
      />

      <TaskIcon name={task.icon} size={26} />

      <div className="grow" style={{ minWidth: 180 }}>
        <div className="row wrap" style={{ gap: "0.4rem" }}>
          <strong>{task.name}</strong>
{task.recurrence_type && (
        <span className="badge" title={repeatDays(task) || undefined}>
          {repeatLabel(task)}
          {repeatDays(task) ? ` · ${repeatDays(task)}` : ""}
        </span>
      )}
          {task.category_name && <span className="badge" style={{ background: "#f0fdf4", color: "#166534" }}>{task.category_name}</span>}
          {task.requires_adult_review && (
            fullyDone
              ? <span className="badge green">reviewed ✓</span>
              : awaitingReview
                ? <span className="badge amber">awaiting adult review</span>
                : <span className="badge">needs adult review</span>
          )}
          {overdue && (
            <span className="badge red">
              Overdue {daysOverdue} day{daysOverdue === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {task.description && <div className="small muted">{task.description}</div>}

        <div className="small muted">
          {dueLabel(task)}
          {showAssignees && (
            <>
              {task.assignees && task.assignees.length > 0
                ? <span className="task-assignee-names"> for {task.assignees.map((a) => a.name).join(" & ")}</span>
                : <span className="badge amber" style={{ marginLeft: "0.4rem" }}>unassigned</span>}
            </>
          )}
        </div>
      </div>

      {canReview && awaitingReview && (
        <button className="" style={{ color: "var(--green)" }} onClick={() => onToggleReview(task)}>
          ✓ Review
        </button>
      )}
      {canReview && task.reviewed_at && (
        <button className="small" onClick={() => onToggleReview(task)}>Unreview</button>
      )}

      {/* Row options: skip today's occurrence (repeats only) and edit. */}
      {hasMenu && (
        <span style={{ position: "relative" }}>
          <button
            className="icon-btn"
            title="Task options"
            aria-label={`Options for ${task.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={onMenuToggle}
          >
            <MoreVertical size={20} />
          </button>
          {menuOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={onMenuClose} />
              <div className="card list-menu task-menu" role="menu">
                {canSkip && (
                  <button
                    type="button"
                    onClick={() => onSkip(task)}
                    title="Not today — this occurrence moves to the next scheduled day"
                  >
                    Skip today
                  </button>
                )}
                {canEdit && (
                  <button type="button" onClick={() => onEdit(task)}>
                    Edit task
                  </button>
                )}
              </div>
            </>
          )}
        </span>
      )}
    </div>
  );
}