import { useCallback, useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import Avatar from "../../components/Avatar.jsx";
import { TaskIcon } from "../../components/IconPicker.jsx";
import TaskForm from "./TaskForm.jsx";
import {
  getTasks, getMembers, createTask, updateTask, deleteTask,
  completeTask, uncompleteTask, reviewTask, unreviewTask,
  getTaskSettings, getTaskCategories, getTaskPriorities,
} from "../../api.js";
import { usePolling } from "../../realtime.js";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysStr(day, n) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Whole-day difference `later` – `earlier` for YYYY-MM-DD strings.
function daysBetween(later, earlier) {
  const [ly, lm, ld] = later.split("-").map(Number);
  const [ey, em, ed] = earlier.split("-").map(Number);
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(ey, em - 1, ed)) / 86400000);
}

export default function TasksPage({ user, memberId, member }) {
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [showingForm, setShowingForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [memberFilter, setMemberFilter] = useState(null); // null = everyone
  const [categories, setCategories] = useState([]);
  const [priorities, setPriorities] = useState([]);
  const [settings, setSettings] = useState({});

  const refresh = useCallback(async () => {
    const [t, m, s, cats, pris] = await Promise.all([
      getTasks(memberId || undefined), getMembers(), getTaskSettings(),
      getTaskCategories(), getTaskPriorities(),
    ]);
    setTasks(t);
    setMembers(m);
    setSettings(s);
    setCategories(cats);
    setPriorities(pris);
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

  // The list is split into three buckets:
  //   1. Today's Outstanding — not done, and either due today or (non-repeating
  //      only) overdue. Overdue tasks render with an "Overdue X days" badge.
  //   2. Upcoming — not done, no due date or due within the next 7 days, and
  //      daily repeats are excluded (they live in "today").
  //   3. Today's Completed — anything finished sometime today (its instance or
  //      completed_at date matches today's local date).
  // Repeating tasks are rolled to their next occurrence once a day passes, so
  // only non-repeating tasks can ever be "overdue" in this list.
  const sections = useMemo(() => {
    let list = tasks;
    if (memberFilter) {
      list = list.filter((t) => (t.assignees || []).some((a) => a.id === memberFilter));
    }
    const todayPlus7 = addDaysStr(today, 7);
    const byDue = (a, b) => {
      const ad = a.due_at ? a.due_at.slice(0, 10) : "9999-99-99";
      const bd = b.due_at ? b.due_at.slice(0, 10) : "9999-99-99";
      return ad.localeCompare(bd) || a.id - b.id;
    };

    const outstanding = [];
    const upcoming = [];
    const completedToday = [];
    for (const t of list) {
      const due = t.due_at ? t.due_at.slice(0, 10) : null;
      if (!t.completed_at) {
        if (due === today || (due && due < today && !t.recurrence_type)) outstanding.push(t);
        else if (t.recurrence_type !== "daily" && (!due || (due > today && due <= todayPlus7))) upcoming.push(t);
      } else if ((t.completed_at || "").slice(0, 10) === today) {
        completedToday.push(t);
      }
    }
    outstanding.sort(byDue);
    upcoming.sort(byDue);
    completedToday.sort(
      (a, b) => String(b.completed_at).localeCompare(String(a.completed_at)) || a.id - b.id
    );
    return { outstanding, upcoming, completedToday };
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
      // A task counts as incomplete until it's completed AND, when it requires
      // an adult, reviewed — matching the "fully done" state used in TaskRow.
      const fullyDone = (t) => t.completed_at && (!t.requires_adult_review || t.reviewed_at);
      c[m.id] = {
        total: mine.length,
        incomplete: mine.filter((t) => !fullyDone(t)).length,
      };
    }
    return c;
  }, [tasks, taskMembers]);

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

  return (
    <div>
      <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>{title}</h1>
        {canCreate && <button className="primary" onClick={openNew}>+ New task</button>}
      </div>

      {(showingForm || editing) && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <TaskForm
            key={editing?.id ?? "new"}
            members={taskMembers}
            categories={categories}
            priorities={priorities}
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
                  counts[m.id].incomplete > 0
                    ? <span className="avatar-badge" title={`${counts[m.id].incomplete} incomplete task${counts[m.id].incomplete === 1 ? "" : "s"}`}>{counts[m.id].incomplete}</span>
                    : <span className="avatar-badge green" title="All tasks done">✓</span>
                )}
              </span>
              <span className="member-name">{m.name.split(" ")[0]}</span>
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gap: "1.25rem" }}>
        <TaskSection heading="Today’s Outstanding Tasks" count={sections.outstanding.length}>
          {sections.outstanding.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              user={user}
              memberById={memberById}
              adult={adult}
              today={today}
              canEdit={canEdit}
              canReview={canReview}
              onToggleComplete={toggleComplete}
              onToggleReview={toggleReview}
              onEdit={() => { setEditing(t); setShowingForm(false); }}
            />
          ))}
          {sections.outstanding.length === 0 && (
            <div className="card muted">Nothing outstanding — all caught up!</div>
          )}
        </TaskSection>

        <TaskSection heading="Upcoming Tasks" count={sections.upcoming.length}>
          {sections.upcoming.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              user={user}
              memberById={memberById}
              adult={adult}
              today={today}
              canEdit={canEdit}
              canReview={canReview}
              onToggleComplete={toggleComplete}
              onToggleReview={toggleReview}
              onEdit={() => { setEditing(t); setShowingForm(false); }}
            />
          ))}
          {sections.upcoming.length === 0 && (
            <div className="card muted">No upcoming tasks.</div>
          )}
        </TaskSection>

        <TaskSection heading="Today’s Completed Tasks" count={sections.completedToday.length}>
          {sections.completedToday.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              user={user}
              memberById={memberById}
              adult={adult}
              today={today}
              canEdit={canEdit}
              canReview={canReview}
              onToggleComplete={toggleComplete}
              onToggleReview={toggleReview}
              onEdit={() => { setEditing(t); setShowingForm(false); }}
            />
          ))}
          {sections.completedToday.length === 0 && (
            <div className="card muted">No tasks completed today yet.</div>
          )}
        </TaskSection>
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

function isFullyDone(task) {
  return task.completed_at && (!task.requires_adult_review || task.reviewed_at);
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

function TaskRow({ task, user, memberById, adult, today, canEdit, canReview, onToggleComplete, onToggleReview, onEdit }) {
  const dueDate = task.due_at ? task.due_at.slice(0, 10) : null;
  const overdue = !!dueDate && dueDate < today && !task.completed_at;
  const daysOverdue = overdue ? daysBetween(today, dueDate) : 0;
  const awaitingReview = task.completed_at && task.requires_adult_review && !task.reviewed_at;
  const fullyDone = isFullyDone(task);

  const caps = user?.caps?.tasks || {};
  // Completing is allowed with either complete_own or complete_others (mirrors server assertCanComplete).
  const canComplete = adult || user?.is_kiosk || caps.complete_own || caps.complete_others;

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
          {task.priority_name && (
            <span
              className="badge"
              style={
                task.priority_name === "High"
                  ? { background: "#fee2e2", color: "#991b1b" }
                  : task.priority_name === "Low"
                    ? { background: "#e0f2fe", color: "#0c4a6e" }
                    : {}
              }
            >
              {task.priority_name}
            </span>
          )}
          {task.dollar_value != null && <span className="badge amber">${Number(task.dollar_value).toFixed(2)}</span>}
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

        <div className="small muted">{dueLabel(task)}</div>
      </div>

      {canReview && awaitingReview && (
        <button className="" style={{ color: "var(--green)" }} onClick={() => onToggleReview(task)}>
          ✓ Review
        </button>
      )}
      {canReview && task.reviewed_at && (
        <button className="small" onClick={() => onToggleReview(task)}>Unreview</button>
      )}

      {canEdit && <button className="small" onClick={onEdit}>Edit</button>}
    </div>
  );
}