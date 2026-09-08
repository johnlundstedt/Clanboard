// Recurrence engine: computes the next occurrence date for repeating tasks.
//
// Patterns:
//   NULL        - do not repeat
//   'daily'     - every day
//   'weekdays'  - every Mon-Fri
//   'weekends'  - every Sat-Sun
//   'custom'    - every X days/weeks/months/years (recurrence_interval/period);
//                 custom weekly repeats use recurrence_days_of_week for "repeat on"
//
// A recurring task is a single row that "rolls over" on completion: the next
// occurrence is written into due_at (YYYY-MM-DD) with completion reset, so the
// UI always shows the current instance. due_time holds the daily deadline time.

export const DAY_INDEX = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
export const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR"];
export const WEEKEND_CODES = ["SA", "SU"];
const FIXED_PERIOD = { daily: "day", weekdays: "week", weekends: "week", weekly: "week" };

export function parseDays(daysOfWeekText) {
  try {
    const arr = JSON.parse(daysOfWeekText);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateFrom(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
}

function patternPeriod(task) {
  if (task.recurrence_type === "custom") return task.recurrence_period || "day";
  return FIXED_PERIOD[task.recurrence_type] || "day";
}

function patternInterval(task) {
  if (task.recurrence_type === "custom") {
    const n = Number(task.recurrence_interval);
    return Number.isInteger(n) && n > 0 ? n : 1;
  }
  return 1;
}

// Day codes to use for a week-based pattern (custom-week, weekdays, weekends)
function patternDays(task) {
  if (task.recurrence_type === "weekdays") return WEEKDAY_CODES;
  if (task.recurrence_type === "weekends") return WEEKEND_CODES;
  return parseDays(task.recurrence_days_of_week);
}

// Earliest occurrence of a week-based cycle strictly after `afterDate`.
// Cycles anchor to `anchor`: cycle k's start is anchor + k*intervalWeeks*7 days,
// and each day in `offsets` (0-6, relative to the anchor's weekday) is an
// occurrence within that cycle.
export function nextOnDaySet(anchor, intervalWeeks, offsets, afterDate) {
  const span = intervalWeeks * 7;
  const diff = daysBetween(anchor, afterDate);
  let i0 = Math.floor(diff / span);
  if (i0 < 0) i0 = 0;
  for (let i = i0; i <= i0 + 2; i++) {
    const cycleStart = addDays(anchor, i * span);
    for (const off of offsets) {
      const d = addDays(cycleStart, off);
      if (d > afterDate) return d;
    }
  }
  return null;
}

// Earliest occurrence of a month-based cycle strictly after `afterDate`. The
// day-of-month matches the anchor's day (clamped for short months).
export function nextMonthOccurrence(anchorY, anchorM, anchorD, interval, afterDate) {
  let y = anchorY, m = anchorM;
  for (let i = 0; i < 4000; i++) {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const s = dateFrom(y, m, Math.min(anchorD, lastDay));
    if (s > afterDate) return s;
    m += interval;
    y += Math.floor((m - 1) / 12);
    m = ((m - 1) % 12) + 1;
  }
  return null;
}

// Same, but year-anchored (Feb 29 clamps to Feb 28 in non-leap years).
export function nextYearOccurrence(anchorY, anchorM, anchorD, interval, afterDate) {
  let y = anchorY;
  for (let i = 0; i < 4000; i++) {
    const lastDay = new Date(Date.UTC(y, anchorM, 0)).getUTCDate();
    const s = dateFrom(y, anchorM, Math.min(anchorD, lastDay));
    if (s > afterDate) return s;
    y += interval;
  }
  return null;
}

// Compute the next occurrence date (YYYY-MM-DD) after `afterDate` for a
// recurring task, or null when it isn't recurring / has no valid pattern.
export function nextOccurrence(task, afterDate) {
  if (!task.recurrence_type) return null;
  const period = patternPeriod(task);
  const interval = patternInterval(task);
  const anchor = task.recurrence_start_date || (task.created_at ? task.created_at.slice(0, 10) : null) || afterDate;
  if (!anchor) return null;
  const [ay, am, ad] = anchor.split("-").map(Number);

  if (period === "day") return addDays(afterDate, interval);

  if (period === "week") {
    const dayCodes = patternDays(task);
    const offsets = [];
    const anchorDow = new Date(`${anchor}T12:00:00`).getDay();
    for (const code of dayCodes) {
      if (DAY_INDEX[code] === undefined) continue;
      offsets.push((DAY_INDEX[code] - anchorDow + 7) % 7);
    }
    offsets.sort((a, b) => a - b);
    if (!offsets.length) return null;
    return nextOnDaySet(anchor, interval, offsets, afterDate);
  }

  if (period === "month") return nextMonthOccurrence(ay, am, ad, interval, afterDate);
  if (period === "year") return nextYearOccurrence(ay, am, ad, interval, afterDate);
  return null;
}

// True when `dateStr` (the next occurrence) falls inside the task's start/end window.
export function withinRange(task, dateStr) {
  if (task.recurrence_start_date && dateStr < task.recurrence_start_date) return false;
  if (task.recurrence_end_date && dateStr > task.recurrence_end_date) return false;
  return true;
}

// 1-based index of the scheduled occurrence on `dateStr` (counts occurrences
// from the anchor). Null when the task isn't recurring / has no valid pattern.
// Used to implement "ends after N occurrences".
export function occurrenceIndex(task, dateStr) {
  const anchor = task.recurrence_start_date || (task.created_at ? task.created_at.slice(0, 10) : null);
  if (!anchor || !task.recurrence_type) return null;
  const period = patternPeriod(task);
  const interval = patternInterval(task);
  if (dateStr <= anchor) return 1;
  const diff = daysBetween(anchor, dateStr);

  if (period === "day") {
    const before = Math.floor((diff - 1) / interval) + 1;
    return before + 1;
  }

  if (period === "week") {
    const dayCodes = patternDays(task);
    const offsets = [];
    const anchorDow = new Date(`${anchor}T12:00:00`).getDay();
    for (const code of dayCodes) {
      if (DAY_INDEX[code] === undefined) continue;
      offsets.push((DAY_INDEX[code] - anchorDow + 7) % 7);
    }
    offsets.sort((a, b) => a - b);
    if (!offsets.length) return null;
    const span = interval * 7;
    const full = Math.floor(diff / span);
    const rem = diff - full * span;
    let inCycle = 0;
    for (const off of offsets) if (off < rem) inCycle++;
    return full * offsets.length + inCycle + 1;
  }

  if (period === "month") {
    const [ay, am, ad] = anchor.split("-").map(Number);
    let y = ay, m = am, count = 0;
    let lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let occ = dateFrom(y, m, Math.min(ad, lastDay));
    while (occ < dateStr && count < 4000) {
      count++;
      m += interval;
      y += Math.floor((m - 1) / 12);
      m = ((m - 1) % 12) + 1;
      lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      occ = dateFrom(y, m, Math.min(ad, lastDay));
    }
    return count + 1;
  }

  if (period === "year") {
    const [ay, am, ad] = anchor.split("-").map(Number);
    let y = ay, count = 0;
    let lastDay = new Date(Date.UTC(y, am, 0)).getUTCDate();
    let occ = dateFrom(y, am, Math.min(ad, lastDay));
    while (occ < dateStr && count < 4000) {
      count++;
      y += interval;
      lastDay = new Date(Date.UTC(y, am, 0)).getUTCDate();
      occ = dateFrom(y, am, Math.min(ad, lastDay));
    }
    return count + 1;
  }

  return null;
}