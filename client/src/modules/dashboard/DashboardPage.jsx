import { useCallback, useEffect, useState } from "react";
import { Sunrise, Sandwich, CookingPot, Apple } from "lucide-react";
import Avatar from "../../components/Avatar.jsx";
import { TaskIcon } from "../../components/IconPicker.jsx";
import { getDashboard, quickAddTask, completeTask, uncompleteTask } from "../../api.js";
import { usePolling } from "../../realtime.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MEAL_SLOTS = [
  ["breakfast", "Breakfast", Sunrise],
  ["lunch", "Lunch", Sandwich],
  ["dinner", "Dinner", CookingPot],
  ["snack", "Snack", Apple],
];

// Render a day's min/max temperature honoring the admin's units preference.
// The server returns either single-unit values (imperial/metric) or both.
function formatTemp(day, kind) {
  const val = kind === "max" ? "max" : "min";
  if (day.tempUnit === "both") {
    const imp = day[`${val}Imperial`];
    const met = day[`${val}Metric`];
    return (
      <>
        <strong>{imp}°F</strong> / {met}°C
      </>
    );
  }
  const unit = day.tempUnit === "F" ? "°F" : "°";
  return <strong>{day[val]}{unit}</strong>;
}

export default function DashboardPage({ user, memberId, member, onOpenMemberTasks, onOpenTask }) {
  const [data, setData] = useState(null);
  const [quick, setQuick] = useState("");

  const adult = !!user?.is_admin;
  const caps = user?.caps?.tasks || {};
  const canQuickAdd =
    adult || user?.is_kiosk ||
    (memberId ? !!caps.create : !!caps.create && !!caps.create_unassigned);

  // Opening an unassigned task lands on its editor via the Tasks page's edit
  // form, which requires the "edit" capability to save — gate the tap on it so
  // viewers who can't assign don't land on a form they can't submit.
  const canAssignUnassigned = adult || user?.is_kiosk || !!caps.edit;

  // A member row jumps straight to that member's Today view on the Tasks page.
  // Only viewers who can see everyone's tasks (kiosk, admin, or view_others) get
  // the link — otherwise the list is server-scoped to the viewer and the hop
  // would land on an empty page with no way back.
  const canOpenTasks = !!user?.is_kiosk || adult || !!caps.view_others;
  const openTasks = canOpenTasks && onOpenMemberTasks ? onOpenMemberTasks : null;

  const refresh = useCallback(async () => {
    setData(await getDashboard(memberId || undefined));
  }, [memberId]);

  // The dashboard aggregates tasks, users, meals and its own counters, so it
  // refreshes on any change to those tables (single shared poller, not four
  // independent timers hitting /api/dashboard on a schedule).
  usePolling(["dashboard", "meal_plan", "tasks", "users"], refresh);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleQuickAdd() {
    if (!quick.trim()) return;
    await quickAddTask(quick, memberId ? [memberId] : undefined);
    setQuick("");
    refresh();
  }

  async function toggleTask(task) {
    if (task.completed_at) await uncompleteTask(task.id);
    else await completeTask(task.id);
    refresh();
  }

  if (!data) return <div className="card">Loading…</div>;

  const today = data.date;
  const memberName = memberId
    ? member?.name?.split(" ")[0] || data.children?.[0]?.child?.name?.split(" ")[0] || "there"
    : user?.is_kiosk
      ? `${user.family_name || "Clanboard"} Clan`
      : user?.name?.split(" ")[0] || "there";

  const childRows = (data.children || []).filter((c) => c.todays.length > 0);
  const doneChildren = (data.children || []).filter(
    (c) => c.todays.length === 0 && c.completed_today_count > 0
  );

  return (
    <div>
      {/* Greeting + date */}
      <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>Hi, {memberName}</h1>
        <span className="muted">
          {today ? new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "short", day: "numeric" }) : ""}
        </span>
      </div>

      {/* Weather */}
      {data.weather && data.weather.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="weather-strip">
            {[data.weather[0], ...data.weather.slice(1, 3)].map((day, i) => (
              <div key={day.date} className="weather-day">
                <div className="weather-icon">{day.icon}</div>
                <div className="muted small">
                  {i === 0 ? "Today" : WEEKDAYS[new Date(`${day.date}T12:00:00`).getDay()]}
                </div>
                <div>
                  {formatTemp(day, "max")} / {formatTemp(day, "min")}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Today's meals */}
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Today's meals</h2>
<div className="row wrap" style={{ gap: "1rem" }}>
            {MEAL_SLOTS.map(([slot, label, Icon]) => (
              <div key={slot} style={{ minWidth: 140, flex: 1 }}>
                <div className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontSize: "0.7rem" }}>
                  <Icon size={14} style={{ verticalAlign: "-2px" }} /> {label}
                </div>
                <div style={{ fontSize: "1rem", fontWeight: 500, marginTop: "2px" }}>
                  {data.todayMeals?.[slot] ? data.todayMeals[slot] : <span className="muted">—</span>}
                </div>
              </div>
            ))}
          </div>
      </div>

      {/* Quick add */}
      {canQuickAdd && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="row">
            <input
              className="grow"
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
              placeholder="Quick add a task… (e.g. Take out the trash)"
            />
            <button className="primary" onClick={handleQuickAdd}>
              Add
            </button>
          </div>
        </div>
      )}

      {/* What needs to be done today */}
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Today's tasks</h2>

        {childRows.length === 0 && data.unassigned.length === 0 && (
          <p className="muted">Nothing due for anyone today 🎉</p>
        )}

        {childRows.map(({ child, todays }) => (
          <ChildSection key={child.id} child={child} todays={todays} onToggle={toggleTask} onOpen={openTasks} />
        ))}

        {doneChildren.map(({ child, completed_today_count }) => (
          <div
            key={child.id}
            className={`child-progress${openTasks ? " clickable" : ""}`}
            role={openTasks ? "button" : undefined}
            tabIndex={openTasks ? 0 : undefined}
            onClick={openTasks ? () => openTasks(child.id) : undefined}
            onKeyDown={openTasks ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTasks(child.id); } } : undefined}
          >
            <Avatar user={child} />
            <div>
              <strong>{child.name}</strong>
              <span className="badge green" style={{ marginLeft: "0.5rem" }}>
                {completed_today_count} done ✓
              </span>
            </div>
            <span style={{ color: "var(--green)" }}>✓</span>
          </div>
        ))}

        {/* Unassigned tasks needing an owner */}
        {data.unassigned.length > 0 && (
          <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
            <div className="small muted" style={{ marginBottom: "0.4rem" }}>Unassigned — needs an owner:</div>
            {data.unassigned.map((t) => {
              const clickable = canAssignUnassigned && !!onOpenTask;
              return (
                <div
                  key={t.id}
                  className={`row${clickable ? " clickable" : ""}`}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onOpenTask(t.id) : undefined}
                  onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenTask(t.id); } } : undefined}
                  title={clickable ? "Assign this task to a member" : undefined}
                  style={clickable ? { padding: "0.2rem 0", gap: "0.5rem", borderRadius: 6 } : { padding: "0.2rem 0", gap: "0.5rem" }}
                >
                  <TaskIcon name={t.icon} size={20} />
                  <span className="grow">{t.name}</span>
                  <span className="badge amber">unassigned</span>
                </div>
              );
            })}
            <div className="small muted" style={{ marginTop: "0.4rem" }}>
              {canAssignUnassigned && onOpenTask
                ? "Tap a task to open it and assign a member."
                : "Assign these on the Tasks page."}
            </div>
          </div>
        )}
      </div>

      {/* Birthdays */}
      {data.upcomingBirthdays.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Birthdays</h2>
          {data.upcomingBirthdays.map((b) => (
            <div key={b.name} className="row" style={{ padding: "0.3rem 0" }}>
              <span style={{ fontSize: "1.2rem" }}>🎂</span>
              <strong>{b.name}</strong>
              <span className="muted small">
                {b.days_until === 0 ? "today!" : `in ${b.days_until} day${b.days_until === 1 ? "" : "s"}`} · turning {b.turning_age}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChildSection({ child, todays, onToggle, onOpen }) {
  const done = todays.filter((t) => t.completed_at).length;
  const pct = todays.length ? Math.round((done / todays.length) * 100) : 100;
  // Right-hand list shows only what's still left to do. Done tasks are kept out
  // so the text stays short and the progress bar stays full-width on every row.
  // Hiding the list on phones (`.hide-narrow`) keeps the bar readable.
  const outstanding = todays.filter((t) => !t.completed_at);

  return (
    <div
      className={`child-progress${onOpen ? " clickable" : ""}`}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? () => onOpen(child.id) : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(child.id); } } : undefined}
    >
      <Avatar user={child} className="child-avatar" />
      <div className="child-meta">
        <strong>{child.name}</strong>
        <span className="muted small"> · {done}/{todays.length} done</span>
      </div>
      <span className="small muted child-tasks hide-narrow">{outstanding.map((t) => t.name).join(", ") || "—"}</span>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}