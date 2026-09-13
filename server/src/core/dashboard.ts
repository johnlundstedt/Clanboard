import { and, asc, eq, exists, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import type { DbClient } from "./db.js";
import { getSetting, isModuleEnabled, setSetting } from "./db.js";
import { mealPlan, taskAssignees, tasks, users } from "../schema.js";
import { todayStr } from "../modules/tasks/recurrence.js";
import { HttpError, badRequest } from "./errors.js";
import { mapTaskRow } from "./tasks.js";

// WMO weather codes -> [label, emoji] (same mapping the old handler used).
export const WMO_CODES: Record<number, [string, string]> = {
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

export function cToF(c: number | null | undefined): number | null {
  return c == null ? null : (c * 9) / 5 + 32;
}

interface WeatherDay {
  date: string;
  max?: number | null;
  min?: number | null;
  code?: number | null;
  label?: string;
  icon?: string;
}

// Convert a daily weather day from the API (metric) into the configured units.
// `units` is 'imperial' | 'metric' | 'both'. Returns string temps suitable for
// direct display plus the raw metric values for the code's labels.
export function convertDay(day: WeatherDay, units: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...day };
  if (units === "imperial") {
    out.max = Math.round(cToF(day.max) as number);
    out.min = Math.round(cToF(day.min) as number);
    out.tempUnit = "F";
  } else if (units === "metric") {
    out.max = Math.round(day.max as number);
    out.min = Math.round(day.min as number);
    out.tempUnit = "C";
  } else {
    out.maxMetric = Math.round(day.max as number);
    out.minMetric = Math.round(day.min as number);
    out.maxImperial = Math.round(cToF(day.max) as number);
    out.minImperial = Math.round(cToF(day.min) as number);
    out.tempUnit = "both";
  }
  return out;
}

export async function fetchWeather(lat: string, lon: string, units: string) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,weather_code");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "4");

  const res = await fetch(url);
  if (!res.ok) throw new HttpError(502, `Weather API ${res.status}`);
  const data = (await res.json()) as { daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[] } };
  const daily = data.daily || {};
  const days = (daily.time || []).map((date, i) => {
    const code = daily.weather_code?.[i];
    const [label, icon] = WMO_CODES[code ?? -1] || ["Unknown", "🌡"];
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

// City-name search via Open-Meteo Geocoding (free, no API key).
export async function geocode(q: string | undefined) {
  const query = (q || "").trim();
  if (!query) return { results: [] };
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "6");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  let r: Response;
  try {
    r = await fetch(url);
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : "Geocoding API error");
  }
  if (!r.ok) throw new HttpError(502, "Geocoding API error");
  const data = (await r.json()) as { results?: Array<{ name: string; admin1?: string; country?: string; country_code?: string; latitude: number; longitude: number }> };
  return {
    results: (data.results || []).map((x) => ({
      name: x.name,
      admin1: x.admin1 || null,
      country: x.country || null,
      country_code: x.country_code || null,
      latitude: x.latitude,
      longitude: x.longitude,
    })),
  };
}

// Reverse geocode (used by the "use my location" button to name the spot).
export async function reverseGeocode(lat: unknown, lon: unknown) {
  if (lat === undefined || lon === undefined) throw badRequest("lat and lon are required");
  const url = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("localityLanguage", "en");
  url.searchParams.set("format", "json");
  try {
    const r = await fetch(url);
    if (!r.ok) return { name: null };
    const d = (await r.json()) as { city?: string; locality?: string; principalSubdivision?: string; countryName?: string };
    const parts = [d.city || d.locality, d.principalSubdivision, d.countryName].filter(Boolean);
    if (!parts.length) return { name: null };
    return { name: parts.join(", ") };
  } catch {
    return { name: null };
  }
}

export async function weatherSettings(db: DbClient) {
  return {
    latitude: await getSetting(db, "latitude"),
    longitude: await getSetting(db, "longitude"),
    weather_location: await getSetting(db, "weather_location"),
    weather_units: (await getSetting(db, "weather_units")) || "metric",
  };
}

export async function updateWeatherSettings(db: DbClient, body: Record<string, unknown>) {
  const { latitude, longitude, weather_location, weather_units } = body;
  if (latitude) await setSetting(db, "latitude", String(latitude));
  if (longitude) await setSetting(db, "longitude", String(longitude));
  if (weather_location !== undefined) await setSetting(db, "weather_location", String(weather_location));
  if (weather_units !== undefined) {
    const units = ["imperial", "metric", "both"].includes(String(weather_units))
      ? String(weather_units)
      : "metric";
    await setSetting(db, "weather_units", units);
  }
  return { ok: true };
}

interface BirthdayWire {
  name: string;
  date: string;
  days_until: number;
  turning_age: number;
}

export async function birthsInWindow(db: DbClient, daysAhead: number): Promise<BirthdayWire[]> {
  const today = todayStr();
  const todayMMDD = today.slice(5);
  const nowYear = Number(today.slice(0, 4));

  const usersRows = await db.select({ name: users.name, birthday: users.birthday }).from(users).all();
  const list: BirthdayWire[] = [];
  for (const u of usersRows) {
    if (!u.birthday) continue;
    const mmdd = u.birthday.slice(5);
    let offset = 0;
    if (mmdd < todayMMDD) offset = 1;
    const y = nowYear + offset;
    const d = new Date(`${y}-${mmdd}T12:00:00`);
    const dateStr = `${y}-${mmdd}`;
    const diff = Math.round((d.getTime() - new Date(`${today}T12:00:00`).getTime()) / 86400000);
    if (diff >= 0 && diff <= daysAhead) {
      const age = d.getFullYear() - Number(u.birthday.slice(0, 4));
      list.push({ name: u.name, date: dateStr, days_until: diff, turning_age: age });
    }
  }
  list.sort((a, b) => a.days_until - b.days_until || a.turning_age - b.turning_age);
  return list;
}

interface ChildRowWire {
  child: { id: number; name: string; photo_url: string | null };
  todays: ReturnType<typeof mapTaskRow>[];
  completed_today_count: number;
  total: number;
  done: number;
}

// Per-member "what's due today": tasks assigned to the member that are due
// today (started via due_at), overdue, or open with no due date. A task with
// several assignees appears on each of their lists (completion is shared).
// completedToday counts tasks they finished today (any task).
// Pass `userIds` to render rows only for those members (single-member view);
// otherwise every family member gets a row.
export async function childTodayRows(
  db: DbClient,
  userIds: number[] | null = null
): Promise<ChildRowWire[]> {
  const today = todayStr();
  const usersPromise = userIds
    ? db.select().from(users).where(inArray(users.id, userIds)).all()
    : db.select().from(users).orderBy(asc(users.id)).all();
  const children = await usersPromise;

  const childTotals: ChildRowWire[] = [];
  for (const child of children) {
    const todaysRows = await db
      .select()
      .from(tasks)
      .where(
        and(
          isNull(tasks.completedAt),
          or(
            isNull(tasks.dueAt),
            sql`substr(${tasks.dueAt}, 1, 10) < ${today}`,
            sql`substr(${tasks.dueAt}, 1, 10) = ${today}`
          ),
          exists(
            db
              .select({ one: sql`1` })
              .from(taskAssignees)
              .where(and(eq(taskAssignees.taskId, tasks.id), eq(taskAssignees.userId, child.id)))
          )
        )
      )
      .orderBy(sql`substr(${tasks.dueAt}, 1, 10), ${tasks.dueAt}, ${tasks.id}`)
      .all();

    const completedTodayCount = await db
      .select({ c: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          sql`substr(${tasks.completedAt}, 1, 10) = ${today}`,
          exists(
            db
              .select({ one: sql`1` })
              .from(taskAssignees)
              .where(and(eq(taskAssignees.taskId, tasks.id), eq(taskAssignees.userId, child.id)))
          )
        )
      )
      .get();

    childTotals.push({
      child: { id: child.id, name: child.name, photo_url: child.photoUrl },
      todays: todaysRows.map(mapTaskRow),
      completed_today_count: Number(completedTodayCount?.c ?? 0),
      total: todaysRows.length,
      done: 0,
    });
  }
  return childTotals;
}

// Household dashboard: weather, birthdays, per-member task rows, unassigned
// tasks, and today's meals. `user_id` narrows to a single member (wall display).
export async function getDashboard(db: DbClient, opts: { user_id?: string | number } = {}) {
  const lat = await getSetting(db, "latitude");
  const lon = await getSetting(db, "longitude");
  const units = (await getSetting(db, "weather_units")) || "metric";

  let weather = null;
  if (lat && lon) {
    try {
      weather = await fetchWeather(lat, lon, units);
    } catch (err) {
      console.error("[dashboard] weather:", err instanceof Error ? err.message : err);
      weather = null;
    }
  }

  const upcomingBirthdays = await birthsInWindow(db, 30);

  const userId = opts.user_id ? Number(opts.user_id) : null;
  const member = userId ? await db.select().from(users).where(eq(users.id, userId)).get() : null;
  const children = member ? await childTodayRows(db, [member.id]) : await childTodayRows(db);

  let unassigned: ReturnType<typeof mapTaskRow>[] = [];
  if (!member) {
    const rows = await db
      .select()
      .from(tasks)
      .where(
        and(
          isNull(tasks.completedAt),
          notExists(db.select({ one: sql`1` }).from(taskAssignees).where(eq(taskAssignees.taskId, tasks.id)))
        )
      )
      .orderBy(sql`substr(${tasks.dueAt}, 1, 10) IS NULL, ${tasks.dueAt}, ${tasks.id}`)
      .all();
    unassigned = rows.map(mapTaskRow);
  }

  const todayDate = todayStr();
  const todayMeals: Record<string, string | null> = {};
  if (await isModuleEnabled(db, "meal-plan")) {
    const rows = await db
      .select({ mealSlot: mealPlan.mealSlot, text: mealPlan.text })
      .from(mealPlan)
      .where(eq(mealPlan.date, todayDate))
      .all();
    for (const row of rows) todayMeals[row.mealSlot] = row.text as string;
  }

  return { date: todayDate, weather, children, upcomingBirthdays, unassigned, todayMeals };
}