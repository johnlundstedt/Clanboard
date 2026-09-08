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

export default function DashboardPage({ user, memberId }) {
  const [data, setData] = useState(null);
  const [quick, setQuick] = useState("");

  const adult = !!user?.is_admin;
  const caps = user?.caps?.tasks || {};
  const canQuickAdd =
    adult || user?.is_kiosk ||
    (memberId ? !!caps.create : !!caps.create && !!caps.create_unassigned);

  const refresh = useCallback(async () => {
    setData(await getDashboard(memberId || undefined));
  }, [memberId]);

  usePolling("dashboard", refresh, 60000);
  usePolling("meal_plan", refresh, 60000);
  usePolling("tasks", refresh, 10000);
  usePolling("users", refresh, 10000);

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
    ? data.children?.[0]?.child?.name?.split(" ")[0] || "there"
    : user?.name?.split(" ")[0];

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
          {today ? new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : ""}
        </span>
      </div>

      {/* Weather */}
      {data.weather && data.weather.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="row wrap">
            {[data.weather[0], ...data.weather.slice(1, 3)].map((day, i) => (
              <div key={day.date} className="row" style={{ gap: "0.75rem", padding: "0 1rem 0 0" }}>
                <span style={{ fontSize: "1.4rem" }}>{day.icon}</span>
                <div>
                  <div className={i === 0 ? "" : "muted small"}>
                    {i === 0 ? "Today" : WEEKDAYS[new Date(`${day.date}T12:00:00`).getDay()]}
                  </div>
                  <div>
                    {formatTemp(day, "max")} / {formatTemp(day, "min")} {day.label}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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

      {/* What needs to be done today */}
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Today's tasks</h2>

        {childRows.length === 0 && data.unassigned.length === 0 && (
          <p className="muted">Nothing due for anyone today 🎉</p>
        )}

        {childRows.map(({ child, todays }) => (
          <ChildSection key={child.id} child={child} todays={todays} onToggle={toggleTask} />
        ))}

        {doneChildren.map(({ child, completed_today_count }) => (
          <div key={child.id} className="child-progress">
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
            {data.unassigned.map((t) => (
              <div key={t.id} className="row" style={{ padding: "0.2rem 0", gap: "0.5rem" }}>
                <TaskIcon name={t.icon} size={20} />
                <span className="grow">{t.name}</span>
                <span className="badge amber">unassigned</span>
              </div>
            ))}
            <div className="small muted" style={{ marginTop: "0.4rem" }}>
              Assign these on the Tasks page.
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

function ChildSection({ child, todays, onToggle }) {
  const done = todays.filter((t) => t.completed_at).length;
  const pct = todays.length ? Math.round((done / todays.length) * 100) : 100;

  return (
    <div className="child-progress">
      <Avatar user={child} />
      <div>
        <strong>{child.name}</strong>
        <span className="muted small"> · {done}/{todays.length} done</span>
        <div className="progress-track" style={{ marginTop: "4px" }}>
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="small muted">{todays.map((t) => t.name).join(", ") || "—"}</span>
    </div>
  );
}