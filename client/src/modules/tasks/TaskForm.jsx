import { useState } from "react";
import { IconPicker } from "../../components/IconPicker.jsx";
import AssigneeField from "../../components/AssigneeField.jsx";

const DAYS = [
  ["MO", "Mon"],
  ["TU", "Tue"],
  ["WE", "Wed"],
  ["TH", "Thu"],
  ["FR", "Fri"],
  ["SA", "Sat"],
  ["SU", "Sun"],
];

const PATTERNS = [
  ["", "Do not repeat"],
  ["daily", "Daily"],
  ["weekdays", "Weekdays"],
  ["weekends", "Weekends"],
  ["custom", "Custom"],
];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDaysOfWeek(value) {
  try {
    const a = JSON.parse(value || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function initialPattern(initial) {
  const rt = initial?.recurrence_type;
  if (rt === "custom" || rt === "weekly") return "custom";
  return rt || "";
}

function initialPeriod(initial) {
  const rt = initial?.recurrence_type;
  if (rt === "daily") return "day";
  if (rt === "weekdays" || rt === "weekends" || rt === "weekly") return "week";
  return initial?.recurrence_period || "day";
}

function initialInterval(initial) {
  const n = Number(initial?.recurrence_interval);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export default function TaskForm({ members, initial, defaultAssigneeIds, onSubmit, onCancel, categories, priorities, settings }) {
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [categoryId, setCategoryId] = useState(initial?.category_id || "");
  const [priorityId, setPriorityId] = useState(initial?.priority_id || "");
  const [dollarValue, setDollarValue] = useState(initial?.dollar_value ?? "");
  const [assignedIds, setAssignedIds] = useState(() => {
    if (initial?.assignees?.length) return initial.assignees.map((a) => a.id);
    return defaultAssigneeIds || [];
  });
  const [separateTasks, setSeparateTasks] = useState(false);
  const [requiresAdultReview, setRequiresAdultReview] = useState(!!initial?.requires_adult_review);
  const [icon, setIcon] = useState(initial?.icon || null);

  const hadRepeat = !!initial?.recurrence_type;
  const [pattern, setPattern] = useState(() => initialPattern(initial));
  const [interval, setInterval] = useState(() => initialInterval(initial));
  const [period, setPeriod] = useState(() => initialPeriod(initial));
  const [days, setDays] = useState(() => parseDaysOfWeek(initial?.recurrence_days_of_week));
  const [startDate, setStartDate] = useState(initial?.recurrence_start_date || "");
  const [ends, setEnds] = useState(
    initial?.recurrence_end_date ? "on" : initial?.recurrence_count ? "after" : "never"
  );
  const [endsDate, setEndsDate] = useState(initial?.recurrence_end_date || "");
  const [endsCount, setEndsCount] = useState(initial?.recurrence_count || "");

  // Deadline: a date for one-off tasks, a time-of-day for repeating ones.
  // (Legacy datetime due_at values get their time carried into the time field.)
  const [deadlineDate, setDeadlineDate] = useState(initial?.due_at?.slice(0, 10) || "");
  const [deadlineTime, setDeadlineTime] = useState(
    initial?.due_time ||
      (initial?.due_at && initial.due_at.length > 10 ? initial.due_at.slice(11, 16) : "")
  );

  const hasRepeat = !!pattern;

  function toggleDay(d) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  function handlePatternChange(value) {
    if (value && !startDate) setStartDate(todayStr());
    if (!value) {
      setEnds("never");
      setEndsDate("");
      setEndsCount("");
    }
    setPattern(value);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;

    const payload = {
      name,
      description,
      category_id: categoryId ? Number(categoryId) : null,
      priority_id: priorityId ? Number(priorityId) : null,
      dollar_value: dollarValue !== "" ? (Number(dollarValue) || null) : null,
      assigned_ids: assignedIds.length ? assignedIds : null,
      requires_adult_review: requiresAdultReview,
      icon,
    };

    if (hasRepeat) {
      payload.recurrence_type = pattern;
      payload.due_time = deadlineTime || null;
      payload.recurrence_start_date = startDate || null;
      payload.recurrence_end_date = ends === "on" ? endsDate || null : null;
      payload.recurrence_count = ends === "after" ? (Number(endsCount) || null) : null;
      payload.recurrence_interval = pattern === "custom" ? (Number(interval) || 1) : 1;
      payload.recurrence_period =
        pattern === "custom" ? period : pattern === "daily" ? "day" : "week";
      payload.recurrence_days_of_week =
        pattern === "custom" && period === "week" ? days : null;
      // Starting fresh from a one-off: clear any old deadline date so the
      // occurrence schedule (set on completion) starts clean. Repeating → repeating
      // keeps the current occurrence. Server maps due_time onto each occurrence.
      if (!hadRepeat) payload.due_at = null;
    } else {
      payload.recurrence_type = null;
      payload.recurrence_interval = null;
      payload.recurrence_period = null;
      payload.recurrence_days_of_week = null;
      payload.recurrence_start_date = null;
      payload.recurrence_end_date = null;
      payload.recurrence_count = null;
      payload.due_at = deadlineDate || null;
      payload.due_time = initial?.due_time || null;
    }

    // "Separate task for each person" only applies to new tasks
    if (!initial && separateTasks && assignedIds.length > 1) payload._split = true;
    onSubmit(payload);
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.6rem" }}>
      <div className="row wrap">
        <input
          className="grow"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Task name (required)"
          autoFocus
        />
        <IconPicker value={icon} onChange={setIcon} />
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description / details (optional)"
        rows={2}
      />

      <div className="row wrap" style={{ gap: "1rem", alignItems: "flex-start" }}>
        <div className="grow" style={{ minWidth: 280, display: "grid", gap: "0.75rem", alignContent: "start" }}>
          <label className="row">
            Assign to:
            <AssigneeField
              value={assignedIds}
              members={members}
              onChange={setAssignedIds}
              addLabel={assignedIds.length ? "add another" : "+ assign"}
            />
          </label>

          {!initial && assignedIds.length > 1 && (
            <div className="card" style={{ margin: 0, padding: "0.5rem 0.75rem", marginTop: "0.5rem" }}>
              <div className="small" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
                How should this task work for {assignedIds.length} people?
              </div>
              <label className="row small" style={{ gap: "0.4rem" }}>
                <input
                  type="radio"
                  name="multi-mode"
                  checked={!separateTasks}
                  onChange={() => setSeparateTasks(false)}
                />
                Track as a single task — one checklist everyone shares
              </label>
              <label className="row small" style={{ gap: "0.4rem", marginTop: "0.25rem" }}>
                <input
                  type="radio"
                  name="multi-mode"
                  checked={separateTasks}
                  onChange={() => setSeparateTasks(true)}
                />
                Create a separate task for each person
              </label>
            </div>
          )}

          <div className="row wrap" style={{ gap: "0.8rem" }}>
            <label className="row">
              Repeat:
              <select value={pattern} onChange={(e) => handlePatternChange(e.target.value)}>
                {PATTERNS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>

            {hasRepeat && (
              <label className="row" style={{ gap: "0.4rem" }}>
                Ends:
                <select value={ends} onChange={(e) => setEnds(e.target.value)}>
                  <option value="never">Never</option>
                  <option value="on">On</option>
                  <option value="after">After</option>
                </select>
                {ends === "on" && (
                  <input type="date" value={endsDate} onChange={(e) => setEndsDate(e.target.value)} />
                )}
                {ends === "after" && (
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={endsCount}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") { setEndsCount(""); return; }
                      const n = Number(v);
                      if (!Number.isInteger(n) || n < 1) return;
                      setEndsCount(v);
                    }}
                    placeholder="#"
                    style={{ width: "5rem", textAlign: "center" }}
                  />
                )}
                {ends === "after" && (
                  <span className="muted">
                    {Number(endsCount) === 1 ? "occurrence" : "occurrences"}
                  </span>
                )}
              </label>
            )}

            {pattern === "custom" && (
              <>
                <label className="row" style={{ flexBasis: "100%" }}>
                  Every:
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={interval}
                    onChange={(e) => setInterval(e.target.value)}
                    style={{ width: "3.5rem", textAlign: "center" }}
                  />
                  <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                    <option value="day">{Number(interval) === 1 ? "day" : "days"}</option>
                    <option value="week">{Number(interval) === 1 ? "week" : "weeks"}</option>
                    <option value="month">{Number(interval) === 1 ? "month" : "months"}</option>
                    <option value="year">{Number(interval) === 1 ? "year" : "years"}</option>
                  </select>
                </label>

                {period === "week" && (
                  <div className="row small" style={{ flexBasis: "100%" }}>
                    <span className="muted">on:</span>
                    {DAYS.map(([code, label]) => (
                      <label key={code} className="row" style={{ gap: "2px" }}>
                        <input
                          type="checkbox"
                          checked={days.includes(code)}
                          onChange={() => toggleDay(code)}
                        />
                        {label}
                      </label>
                    ))}
                    {days.length === 0 && (
                      <span className="muted small">pick at least one day</span>
                    )}
                  </div>
                )}
              </>
            )}

            <label className="row" style={{ flexBasis: "100%" }}>
              Deadline:
              {hasRepeat ? (
                <input
                  type="time"
                  value={deadlineTime}
                  onChange={(e) => setDeadlineTime(e.target.value)}
                />
              ) : (
                <input
                  type="date"
                  value={deadlineDate}
                  onChange={(e) => setDeadlineDate(e.target.value)}
                />
              )}
            </label>
          </div>
        </div>

        <div style={{ display: "grid", gap: "0.5rem", minWidth: 230 }}>
          <label className="row">
            <input
              type="checkbox"
              checked={requiresAdultReview}
              onChange={(e) => setRequiresAdultReview(e.target.checked)}
            />
            Needs adult review
          </label>

          {settings?.enable_categories && (
            <label className="row">
              Category:
              <select value={categoryId || ""} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Uncategorized</option>
                {(categories || []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}
          {settings?.enable_priorities && (
            <label className="row">
              Priority:
              <select value={priorityId || ""} onChange={(e) => setPriorityId(e.target.value)}>
                <option value="">None</option>
                {(priorities || []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}
          {settings?.enable_dollar && (
            <label className="row">
              Value ($):
              <input
                type="number"
                min="0"
                step="0.01"
                value={dollarValue}
                onChange={(e) => setDollarValue(e.target.value)}
                placeholder="0.00"
                style={{ width: "6rem" }}
              />
            </label>
          )}
        </div>
      </div>

      <div className="row" style={{ marginTop: "0.4rem" }}>
        <button className="primary" type="submit">{initial ? "Save changes" : "Add task"}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}