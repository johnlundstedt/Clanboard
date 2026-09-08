import express from "express";
import { db, getSetting, setSetting, isModuleEnabled } from "../../db.js";

function migrate() {
  // Dashboard has no own tables; it aggregates tasks, users, and settings.
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function birthsInWindow(daysAhead) {
  const today = todayStr();
  const todayMMDD = today.slice(5);
  const nowYear = Number(today.slice(0, 4));

  const users = db.prepare("SELECT name, birthday FROM users WHERE birthday IS NOT NULL").all();
  const list = [];
  for (const u of users) {
    const mmdd = u.birthday.slice(5);
    let offset = 0;
    if (mmdd < todayMMDD) offset = 1;
    const y = nowYear + offset;
    const d = new Date(`${y}-${mmdd}T12:00:00`);
    const dateStr = `${y}-${mmdd}`;
    const diff = Math.round((d - new Date(`${today}T12:00:00`)) / 86400000);
    if (diff >= 0 && diff <= daysAhead) {
      const age = d.getFullYear() - Number(u.birthday.slice(0, 4));
      list.push({
        name: u.name,
        date: dateStr,
        days_until: diff,
        turning_age: age,
      });
    }
  }
  list.sort((a, b) => a.days_until - b.days_until || a.turning_age - b.turning_age);
  return list;
}

const WMO_CODES = {
  0: ["Sunny", "☀"],
  1: ["Mostly clear", "🌤"],
  2: ["Partly cloudy", "⛅"],
  3: ["Overcast", "☁"],
  45: ["Foggy", "🌫"],
  48: ["Icy fog", "🌫"],
  51: ["Light drizzle", "🌦"],
  53: ["Drizzle", "🌧"],
  55: ["Heavy drizzle", "🌧"],
  61: ["Light rain", "🌦"],
  63: ["Rain", "🌧"],
  65: ["Heavy rain", "🌧"],
  66: ["Freezing rain", "🌧"],
  67: ["Freezing rain", "🌧"],
  71: ["Light snow", "🌨"],
  73: ["Snow", "🌨"],
  75: ["Heavy snow", "❄"],
  77: ["Snow grains", "🌨"],
  80: ["Rain showers", "🌦"],
  81: ["Rain showers", "🌧"],
  82: ["Violent showers", "🌧"],
  85: ["Snow showers", "🌨"],
  86: ["Snow showers", "🌨"],
  95: ["Thunderstorm", "⛈"],
  96: ["Thunderstorm + hail", "⛈"],
  99: ["Thunderstorm + hail", "⛈"],
};

function cToF(c) {
  return c == null ? null : (c * 9) / 5 + 32;
}

// Convert a daily weather day from the API (metric) into the configured units.
// `units` is 'imperial' | 'metric' | 'both'. Returns string temps suitable for
// direct display plus the raw metric values for the code's labels.
function convertDay(day, units) {
  const out = { ...day };
  if (units === "imperial") {
    out.max = Math.round(cToF(day.max));
    out.min = Math.round(cToF(day.min));
    out.tempUnit = "F";
  } else if (units === "metric") {
    out.max = Math.round(day.max);
    out.min = Math.round(day.min);
    out.tempUnit = "C";
  } else {
    out.maxMetric = Math.round(day.max);
    out.minMetric = Math.round(day.min);
    out.maxImperial = Math.round(cToF(day.max));
    out.minImperial = Math.round(cToF(day.min));
    out.tempUnit = "both";
  }
  return out;
}

async function fetchWeather(lat, lon, units) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,weather_code");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "4");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather API ${res.status}`);
  const data = await res.json();
  const daily = data.daily || {};
  const days = (daily.time || []).map((date, i) => {
    const code = daily.weather_code?.[i];
    const [label, icon] = WMO_CODES[code] || ["Unknown", "🌡"];
    return convertDay(
      {
        date,
        max: daily.temperature_2m_max?.[i],
        min: daily.temperature_2m_min?.[i],
        code,
        label,
        icon,
      },
      units
    );
  });
  return days;
}

// Per-member "what's due today": tasks assigned to the member that are due
// today (started via due_at), overdue, or open with no due date. A task with
// several assignees appears on each of their lists (completion is shared).
// completedToday counts tasks they finished today (any task).
// Pass `userIds` to render rows only for those members (single-member view);
// otherwise every family member gets a row.
function childTodayRows(userIds = null) {
  const today = todayStr();
  let children;
  if (userIds) {
    children = db
      .prepare(`SELECT * FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`)
      .all(...userIds);
  } else {
    children = db.prepare("SELECT * FROM users ORDER BY id").all();
  }

  const childTotals = [];
  for (const child of children) {
    const todays = db.prepare(`
      SELECT * FROM tasks
      WHERE completed_at IS NULL
        AND (
              due_at IS NULL
              OR substr(due_at, 1, 10) < ?
              OR substr(due_at, 1, 10) = ?
            )
        AND EXISTS (
          SELECT 1 FROM task_assignees ta
          WHERE ta.task_id = tasks.id AND ta.user_id = ?
        )
      ORDER BY substr(due_at, 1, 10), due_at, id
    `).all(today, today, child.id);

    const completedTodayCount = db.prepare(`
      SELECT COUNT(*) AS c FROM tasks
      WHERE substr(completed_at, 1, 10) = ?
        AND EXISTS (
          SELECT 1 FROM task_assignees ta
          WHERE ta.task_id = tasks.id AND ta.user_id = ?
        )
    `).get(today, child.id).c;

    childTotals.push({
      child: {
        id: child.id,
        name: child.name,
        photo_url: child.photo_url,
      },
      todays,
      completed_today_count: completedTodayCount,
      total: todays.length,
      done: 0,
    });
  }

  return childTotals;
}

const router = express.Router();

// Household settings used by the dashboard (lat/lon for weather)
router.get("/settings", (req, res) => {
  res.json({
    latitude: getSetting("latitude"),
    longitude: getSetting("longitude"),
    weather_location: getSetting("weather_location"),
    weather_units: getSetting("weather_units") || "metric",
  });
});

router.post("/settings", (req, res) => {
  const { latitude, longitude, weather_location, weather_units } = req.body;
  if (latitude) setSetting("latitude", String(latitude));
  if (longitude) setSetting("longitude", String(longitude));
  if (weather_location !== undefined) setSetting("weather_location", weather_location);
  if (weather_units !== undefined) {
    const units = ["imperial", "metric", "both"].includes(weather_units) ? weather_units : "metric";
    setSetting("weather_units", units);
  }
  res.json({ ok: true });
});

// City-name search via Open-Meteo Geocoding (free, no API key)
router.get("/geocode", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ results: [] });
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", q);
  url.searchParams.set("count", "6");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: "Geocoding API error" });
    const data = await r.json();
    res.json({
      results: (data.results || []).map((x) => ({
        name: x.name,
        admin1: x.admin1 || null,
        country: x.country || null,
        country_code: x.country_code || null,
        latitude: x.latitude,
        longitude: x.longitude,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Reverse geocode (used by the "use my location" button to name the spot)
router.get("/reverse-geocode", async (req, res) => {
  const { lat, lon } = req.query;
  if (lat === undefined || lon === undefined) {
    return res.status(400).json({ error: "lat and lon are required" });
  }
  const url = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("localityLanguage", "en");
  url.searchParams.set("format", "json");
  try {
    const r = await fetch(url);
    if (!r.ok) return res.json({ name: null });
    const d = await r.json();
    const parts = [d.city || d.locality, d.principalSubdivision, d.countryName].filter(Boolean);
    if (!parts.length) return res.json({ name: null });
    res.json({ name: parts.join(", ") });
  } catch {
    res.json({ name: null });
  }
});

router.get("/", async (req, res) => {
  const lat = getSetting("latitude");
  const lon = getSetting("longitude");
  const units = getSetting("weather_units") || "metric";

  let weather = null;
  if (lat && lon) {
    try {
      weather = await fetchWeather(lat, lon, units);
    } catch (err) {
      console.error("[dashboard] weather:", err.message);
      weather = null;
    }
  }

  const upcomingBirthdays = birthsInWindow(30);

  // Optional ?user_id= narrows the view to a single family member (wall display).
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  const member = userId ? db.prepare("SELECT * FROM users WHERE id = ?").get(userId) : null;
  const children = member ? childTodayRows([member.id]) : childTodayRows();
  const unassigned = member
    ? []
    : db.prepare(`
        SELECT * FROM tasks
        WHERE completed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id
          )
        ORDER BY substr(due_at, 1, 10) IS NULL, due_at, id
      `).all();

  // Today's meal plan entries (free-text), if the meal-plan module is on
  const todayDate = todayStr();
  const todayMeals = {};
  if (isModuleEnabled("meal-plan")) {
    const rows = db.prepare("SELECT meal_slot, text FROM meal_plan WHERE date = ?").all(todayDate);
    for (const row of rows) todayMeals[row.meal_slot] = row.text;
  }

  res.json({
    date: todayDate,
    weather,
    children,
    upcomingBirthdays,
    unassigned,
    todayMeals,
  });
});

export default {
  name: "dashboard",
  navLabel: "Home",
  migrate,
  router,
};