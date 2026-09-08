import { useCallback, useEffect, useState } from "react";
import { getCalendarEvents } from "../../api.js";
import { usePolling } from "../../realtime.js";

const VIEWS = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
];

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function startOfMonth(date) {
  const d = new Date(date);
  d.setDate(1);
  return d;
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Monday-start grid: cells = array of dates covering the 6-week grid (or enough
// to reach the next month). Col 0 = Monday.
function monthGrid(firstOfMonth) {
  const lead = (firstOfMonth.getDay() + 6) % 7; // days to reach Monday column
  const gridStart = addDays(firstOfMonth, -lead);
  const cells = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));
  return cells;
}

export default function CalendarPage() {
  const [view, setView] = useState("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [events, setEvents] = useState([]);

  // Range to fetch, based on the active view. The next-period button moves the
  // anchor by exactly one day/week/month.
  const range = useCallback(() => {
    if (view === "day") {
      const end = addDays(anchor, 1);
      return { start: anchor, end };
    }
    if (view === "month") {
      const end = addMonths(startOfMonth(anchor), 1);
      return { start: startOfMonth(anchor), end };
    }
    const start = startOfWeek(anchor);
    return { start, end: addDays(start, 7) };
  }, [view, anchor]);

  const { start, end } = range();
  const startISO = new Date(`${fmtDate(start)}T00:00:00`).toISOString();
  const endISO = new Date(`${fmtDate(end)}T00:00:00`).toISOString();

  const refresh = useCallback(async () => {
    setEvents(await getCalendarEvents(startISO, endISO));
  }, [startISO, endISO]);

  usePolling("calendar", refresh, 30000);

  useEffect(() => { refresh(); }, [refresh]);

  const today = fmtDate(new Date());

  function shift(n) {
    if (view === "day") setAnchor((a) => addDays(a, n));
    else if (view === "month") setAnchor((a) => addMonths(a, n));
    else setAnchor((a) => addDays(startOfWeek(a), n * 7));
  }

  function resetToNow() {
    if (view === "day") setAnchor(new Date());
    else if (view === "month") setAnchor(startOfMonth(new Date()));
    else setAnchor(startOfWeek(new Date()));
  }

  const nowLabel = view === "day" ? "Today" : view === "month" ? "This month" : "This week";

  let rangeLabel;
  if (view === "day") {
    rangeLabel = anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  } else if (view === "month") {
    rangeLabel = start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  } else {
    rangeLabel = `${fmtDate(start).slice(5).replace("-", "/")} – ${fmtDate(addDays(start, 6)).slice(5).replace("-", "/")}`;
  }

  const eventsForDate = (d) =>
    events
      .filter((e) => e.start_at.slice(0, 10) === fmtDate(d))
      .sort((a, b) => a.start_at.localeCompare(b.start_at));

  const renderEvent = (e) => (
    <div key={e.id} className="cal-evt" style={{ borderLeft: `4px solid ${e.color || "#3b82f6"}` }}>
      {!e.all_day && e.start_at && <span className="small">{e.start_at.slice(11, 16)} </span>}
      {e.summary}
    </div>
  );

  return (
    <div>
      <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>Calendar</h1>

        <div className="row wrap" style={{ gap: "0.6rem" }}>
          <div className="row" style={{ gap: "0.25rem" }}>
            {VIEWS.map(([key, label]) => (
              <button
                key={key}
                className={view === key ? "primary small" : "small"}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="row">
            <button onClick={() => shift(-1)}>←</button>
            <strong style={{ whiteSpace: "nowrap" }}>{rangeLabel}</strong>
            <button onClick={() => shift(1)}>→</button>
            <button onClick={resetToNow}>{nowLabel}</button>
          </div>
        </div>
      </div>

      {view === "day" && (
        <div className="cal-day" style={{ minHeight: "20vh" }}>
          <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>
            {start.toLocaleDateString(undefined, { weekday: "long" })} <span className="small muted">{fmtDate(start).slice(5).replace("-", "/")}</span>
          </div>
          {eventsForDate(start).map(renderEvent)}
          {eventsForDate(start).length === 0 && <span className="small muted">No events.</span>}
        </div>
      )}

      {view === "week" && (
        <div className="row wrap">
          {Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d) => {
            const ds = fmtDate(d);
            const dayEvents = eventsForDate(d);
            const isToday = ds === today;
            return (
              <div key={ds} className="cal-day" style={{ flex: "1 1 120px", minWidth: 120, borderColor: isToday ? "var(--accent)" : undefined, background: isToday ? "#f0f7ff" : undefined }}>
                <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>
                  {d.toLocaleDateString(undefined, { weekday: "short" })} <span className="small muted">{ds.slice(8)}</span>
                </div>
                {dayEvents.map(renderEvent)}
                {dayEvents.length === 0 && <span className="small muted">—</span>}
              </div>
            );
          })}
        </div>
      )}

      {view === "month" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "0.4rem" }}>
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => (
            <div key={w} className="small muted" style={{ textAlign: "center" }}>{w}</div>
          ))}
          {monthGrid(start).map((d) => {
            const ds = fmtDate(d);
            const isToday = ds === today;
            const inMonth = d.getMonth() === start.getMonth();
            const dayEvents = eventsForDate(d);
            return (
              <div key={ds} className="cal-day" style={{
                minHeight: 70,
                opacity: inMonth ? 1 : 0.4,
                borderColor: isToday ? "var(--accent)" : undefined,
                background: isToday ? "#f0f7ff" : undefined,
              }}>
                <div style={{ fontWeight: 700, marginBottom: "0.25rem" }}>
                  {d.getDate()}
                </div>
                {dayEvents.slice(0, 3).map(renderEvent)}
                {dayEvents.length > 3 && (
                  <div className="small muted">+{dayEvents.length - 3} more</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {events.length === 0 && (
        <p className="small muted" style={{ marginTop: "1rem" }}>
          No synced events yet. An admin can connect Google Calendars in Admin → Calendar.
        </p>
      )}
    </div>
  );
}