import { useCallback, useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import Avatar from "../../components/Avatar.jsx";
import { TaskIcon } from "../../components/IconPicker.jsx";
import AssigneeField from "../../components/AssigneeField.jsx";
import TaskForm from "./TaskForm.jsx";
import {
  getTasks, getMembers, createTask, updateTask, deleteTask,
  completeTask, uncompleteTask, reviewTask, unreviewTask, assignTask,
  getTaskSettings, getTaskCategories, getTaskPriorities,
} from "../../api.js";
import { usePolling } from "../../realtime.js";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const FILTERS = [
  ["all", "All"],
  ["today", "Due today"],
  ["done", "Done"],
  ["unassigned", "Unassigned"],
];

export default function TasksPage({ user, memberId, member }) {
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [showingForm, setShowingForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState("all");
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

  const today = todayStr();

  const filtered = useMemo(() => {
    let list = tasks;
    if (memberFilter) {
      list = list.filter((t) => (t.assignees || []).some((a) => a.id === memberFilter));
    }
    if (filter === "done") return list.filter((t) => t.completed_at);
    if (filter === "unassigned") return list.filter((t) => !(t.assignees || []).length && !t.completed_at);
    if (filter === "today")
      return list.filter((t) => !t.completed_at && (t.due_at ? t.due_at.slice(0, 10) <= today : false));
    return list;
  }, [tasks, filter, memberFilter, today]);

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

  async function handleAssign(task, userIds) {
    await assignTask(task.id, userIds);
    refresh();
  }

  async function handleDelete(task) {
    if (confirm(`Delete "${task.name}"?`)) {
      await deleteTask(task.id);
      if (editing?.id === task.id) cancelForm();
      refresh();
    }
  }

  const memberById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);
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
  const canAssignOthers = adult || user?.is_kiosk || !!caps.assign_others;
  const canViewOthers = adult || user?.is_kiosk || !!caps.view_others;

  // Standalone members with view_others can flip between everyone and a single
  // member's tasks. On the kiosk the memberId prop is already scoped server-side
  // and the left-hand sidebar is the member picker, so skip the extra avatar bar.
  const showMemberFilter = user?.is_kiosk ? false : !memberId && canViewOthers;
  const counts = useMemo(() => {
    const c = {};
    for (const m of members) {
      const mine = tasks.filter((t) => (t.assignees || []).some((a) => a.id === m.id));
      const dueUpToToday = mine.filter((t) => t.due_at && t.due_at.slice(0, 10) <= today);
      c[m.id] = {
        due: dueUpToToday.length,
        remaining: dueUpToToday.filter((t) => !t.completed_at).length,
      };
    }
    return c;
  }, [tasks, members, today]);

  // Avatar bar order: oldest first by birthday, members without a birthday last.
  const memberPicks = useMemo(
    () => [...members].sort((a, b) => {
      if (!a.birthday && !b.birthday) return 0;
      if (!a.birthday) return 1;
      if (!b.birthday) return -1;
      return a.birthday.localeCompare(b.birthday);
    }),
    [members]
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
            members={members}
            categories={categories}
            priorities={priorities}
            settings={settings}
            initial={editing}
            defaultAssigneeIds={memberFilter ? [memberFilter] : []}
            onSubmit={handleSubmit}
            onCancel={cancelForm}
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
              <Avatar user={m} />
              <span className="member-name">{m.name.split(" ")[0]}</span>
              {counts[m.id]?.due > 0 && (
                counts[m.id].remaining > 0
                  ? <span className="badge" title={`${counts[m.id].remaining} task${counts[m.id].remaining === 1 ? "" : "s"} due`}>{counts[m.id].remaining}</span>
                  : <span className="badge green" title="All due tasks done">✓</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="row wrap" style={{ marginBottom: "0.75rem", gap: "0.3rem" }}>
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            className={filter === key ? "navlink active" : "navlink"}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
        <span className="grow" />
        <span className="small muted">{filtered.length} task{filtered.length === 1 ? "" : "s"}</span>
      </div>

      <div style={{ display: "grid", gap: "0.6rem" }}>
        {filtered.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            user={user}
            memberById={memberById}
            adult={adult}
            today={today}
            canEdit={canEdit}
            canDelete={canDelete}
            canReview={canReview}
            canAssignOthers={canAssignOthers}
            onToggleComplete={toggleComplete}
            onToggleReview={toggleReview}
            onAssign={handleAssign}
            onEdit={() => { setEditing(t); setShowingForm(false); }}
            onDelete={handleDelete}
          />
        ))}
        {filtered.length === 0 && <div className="card muted">No tasks here.</div>}
      </div>
    </div>
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

function TaskRow({ task, user, memberById, adult, today, canEdit, canDelete, canReview, canAssignOthers, onToggleComplete, onToggleReview, onAssign, onEdit, onDelete }) {
  const overdue = task.due_at && task.due_at.slice(0, 10) < today && !task.completed_at;
  const awaitingReview = task.completed_at && task.requires_adult_review && !task.reviewed_at;
  const fullyDone = isFullyDone(task);

  const caps = user?.caps?.tasks || {};
  // Completing is allowed with either complete_own or complete_others (mirrors server assertCanComplete).
  const canComplete = adult || user?.is_kiosk || caps.complete_own || caps.complete_others;
  const myIds = new Set((task.assignees || []).map((a) => a.id));
  const assignedToSelf = myIds.has(user?.id);
  // Assigning to a specific member requires assign_self for self / assign_others for others.
  const canAssign =
    adult || user?.is_kiosk || (assignedToSelf ? caps.assign_self : caps.assign_others);

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
          {overdue && <span className="badge red">overdue</span>}
        </div>

        {task.description && <div className="small muted">{task.description}</div>}

        <div className="small muted">{dueLabel(task)}</div>
      </div>

      {canAssign && (
        <AssigneeField
          value={(task.assignees || []).map((a) => a.id)}
          members={Object.values(memberById)}
          onChange={(ids) => onAssign(task, ids)}
          addLabel={(task.assignees || []).length ? "+" : "+ assign"}
        />
      )}

      {canReview && awaitingReview && (
        <button className="" style={{ color: "var(--green)" }} onClick={() => onToggleReview(task)}>
          ✓ Review
        </button>
      )}
      {canReview && task.reviewed_at && (
        <button className="small" onClick={() => onToggleReview(task)}>Unreview</button>
      )}

      {canEdit && <button className="small" onClick={onEdit}>Edit</button>}
      {canDelete && <button className="small danger" onClick={() => onDelete(task)}>✕</button>}
    </div>
  );
}