import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../src/schema.js";
import * as dashboard from "../src/core/dashboard.js";
import { addDays, todayStr } from "../src/modules/tasks/recurrence.js";
import {
  closeD1,
  makeD1Database,
  makeSqliteDatabase,
  type TestDatabase,
} from "./helpers/db.js";

// dashboard core: weather settings + pure conversions, birthday window, per-child
// task rows, and the household aggregation — proven identical on the container
// (better-sqlite3) and Cloudflare (D1) backends. Live network calls (open-meteo,
// geocoders) are deliberately not exercised here.

const backends = [
  { name: "sqlite", make: makeSqliteDatabase },
  { name: "d1", make: makeD1Database },
];

afterAll(async () => {
  await closeD1();
});

async function seedUser(db: TestDatabase, overrides: Partial<typeof s.users.$inferSelect> = {}) {
  const [u] = await db.db
    .insert(s.users)
    .values({ name: "Ada", ...overrides })
    .returning()
    .all();
  return u;
}

for (const backend of backends) {
  describe(`core/dashboard (${backend.name})`, () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await backend.make();
    });

    afterAll(async () => {
      await db.close();
    });

    beforeEach(async () => {
      if (backend.name === "d1") {
        await closeD1();
        db = await backend.make();
      } else {
        await db.reset();
      }
    });

    describe("pure conversions", () => {
      it("cToF converts Celsius and passthroughs null", () => {
        expect(dashboard.cToF(0)).toBe(32);
        expect(dashboard.cToF(20)).toBe(68);
        expect(dashboard.cToF(null)).toBeNull();
        expect(dashboard.cToF(undefined)).toBeNull();
      });

      it("convertDay in metric keeps Celsius", () => {
        const out = dashboard.convertDay({ date: "2026-09-11", max: 21.4, min: 12.6, code: 3 }, "metric");
        expect(out.max).toBe(21);
        expect(out.min).toBe(13);
        expect(out.tempUnit).toBe("C");
      });

      it("convertDay in imperial converts to Fahrenheit", () => {
        const out = dashboard.convertDay({ date: "2026-09-11", max: 21.4, min: 12.6, code: 3 }, "imperial");
        expect(out.max).toBe(71);
        expect(out.min).toBe(55);
        expect(out.tempUnit).toBe("F");
      });

      it("convertDay in both ships C and F", () => {
        const out = dashboard.convertDay(
          { date: "2026-09-11", max: 21.4, min: 12.6, code: 95 },
          "both"
        ) as Record<string, unknown>;
        expect(out.tempUnit).toBe("both");
        expect(out.maxMetric).toBe(21);
        expect(out.minMetric).toBe(13);
        expect(out.maxImperial).toBe(71);
        expect(out.minImperial).toBe(55);
      });
    });

    describe("weather settings", () => {
      it("defaults to metric with no stored location", async () => {
        const settings = await dashboard.weatherSettings(db.db);
        expect(settings.latitude).toBeNull();
        expect(settings.longitude).toBeNull();
        expect(settings.weather_units).toBe("metric");
      });

      it("stores location and units, validating units", async () => {
        await dashboard.updateWeatherSettings(db.db, {
          latitude: "47.6",
          longitude: "-122.3",
          weather_units: "imperial",
        });
        let settings = await dashboard.weatherSettings(db.db);
        expect(settings.latitude).toBe("47.6");
        expect(settings.weather_units).toBe("imperial");

        // Invalid units fall back to metric instead of being persisted
        await dashboard.updateWeatherSettings(db.db, { weather_units: "fahrenheit" });
        settings = await dashboard.weatherSettings(db.db);
        expect(settings.weather_units).toBe("metric");
      });
    });

    describe("birthsInWindow", () => {
      it("lists upcoming birthdays within the window, sorted, with days_until", async () => {
        const today = todayStr();
        const [a] = today.split("-");
        const birthToday = `2015-${today.slice(5)}`;
        const [y, m] = today.split("-").map(Number);
        const tomorrow = addDays(today, 1);
        const birthTomorrow = `2016-${tomorrow.slice(5)}`;
        await seedUser(db, { name: "Today Kid", birthday: birthToday });
        await seedUser(db, { name: "Tomorrow Kid", birthday: birthTomorrow });
        // A birthday just outside the 30-day window must be excluded
        const far = addDays(today, 40);
        await seedUser(db, { name: "Far Kid", birthday: `2019-${far.slice(5)}` });

        const births = await dashboard.birthsInWindow(db.db, 30);
        expect(births.map((b) => b.name)).toEqual(["Today Kid", "Tomorrow Kid"]);
        expect(births[0].days_until).toBeLessThanOrEqual(births[1].days_until);
        expect(births[0].turning_age).toBe(y > 2015 ? y - 2015 : 0);
        expect(births[0].date).toBe(today);
      });
    });

    describe("childTodayRows", () => {
      it("groups open/due-today tasks per member and counts completions today", async () => {
        const today = todayStr();
        const alice = await seedUser(db, { name: "Alice" });
        const bob = await seedUser(db, { name: "Bob" });

        const dueTask = await seedTask(db, { name: "Dishes", dueAt: today, completedAt: null });
        await link(db, dueTask.id, alice.id);
        const doneToday = await seedTask(db, {
          name: "Laundry",
          dueAt: addDays(today, -1),
          completedAt: `${today}T18:00:00`,
        });
        await link(db, doneToday.id, alice.id);
        const tomorrow = await seedTask(db, { name: "Tomorrow task", dueAt: addDays(today, 1) });
        await link(db, tomorrow.id, alice.id);

        const rows = await dashboard.childTodayRows(db.db, [alice.id]);
        expect(rows).toHaveLength(1);
        expect(rows[0].child.name).toBe("Alice");
        expect(rows[0].todays.map((t) => t.name)).toEqual(["Dishes"]);
        expect(rows[0].completed_today_count).toBe(1);
        expect(rows[0].total).toBe(1);

        const both = await dashboard.childTodayRows(db.db);
        expect(both.map((r) => r.child.name).sort()).toEqual(["Alice", "Bob"]);
        expect(both.find((r) => r.child.id === bob.id)?.todays).toEqual([]);
      });

      it("counts recurring completions today through occurrences", async () => {
        const today = todayStr();
        const alice = await seedUser(db, { name: "Alice" });
        // Simulates a recurring task whose row already rolled to tomorrow:
        // it only belongs on today's list because of the stored occurrence.
        const rec = await seedTask(db, {
          name: "Water plants",
          dueAt: addDays(today, 1),
          completedAt: null,
        });
        await link(db, rec.id, alice.id);
        await db.db.insert(s.taskOccurrences).values({
          taskId: rec.id,
          occurrenceDate: today,
          completedAt: `${today}T09:00:00`,
          completedBy: alice.id,
        }).run();

        const rows = await dashboard.childTodayRows(db.db, [alice.id]);
        expect(rows[0].completed_today_count).toBe(1);
        expect(rows[0].todays.map((t) => t.name)).toContain("Water plants");
        expect(rows[0].todays.find((t) => t.name === "Water plants")!.completed_at).toBeTruthy();
        expect(rows[0].done).toBe(1);
      });

      it("counts a completion on the viewer's day, not the UTC one", async () => {
        // The heart of the bug. A completion stamped 03:00 UTC on the 26th
        // happened at 21:00 on the 25th in Chicago. The old count compared
        // substr(completed_at,1,10) against the viewer's today, so that chore
        // landed on the *26th's* tally and the household's "done today" number
        // was wrong for the last few hours of every evening.
        //
        // Every timestamp below is built from the Chicago day rather than from
        // "now", so the UTC date genuinely differs from the local day and the
        // test discriminates at any hour the suite happens to run.
        const ZONE = "America/Chicago";
        const day = todayStr(ZONE);
        const alice = await seedUser(db, { name: "Alice" });
        // 06:00 on the Chicago day — same day in UTC, counts either way.
        const morning = await seedTask(db, { name: "Early chore", dueAt: day, completedAt: `${day}T06:00:00` });
        await link(db, morning.id, alice.id);
        // 03:00 UTC the NEXT day — which is 21:00 on the Chicago day. The old
        // comparison read the UTC head ("the 26th") and missed this one.
        const evening = await seedTask(db, {
          name: "Evening chore",
          dueAt: day,
          completedAt: `${addDays(day, 1)}T03:00:00`,
        });
        await link(db, evening.id, alice.id);
        // Finished two local days ago: not today's work in any zone.
        const stale = await seedTask(db, {
          name: "Old chore",
          dueAt: addDays(day, -2),
          completedAt: `${addDays(day, -2)}T20:00:00`,
        });
        await link(db, stale.id, alice.id);

        const rows = await dashboard.childTodayRows(db.db, [alice.id], ZONE);
        expect(rows[0].completed_today_count).toBe(2);
        // Read as a UTC day, the same three rows file the evening chore on the
        // next day and only the morning one counts — the pre-fix behaviour, and
        // the proof that the query result now depends on the viewer's zone.
        const asUtc = await dashboard.childTodayRows(db.db, [alice.id], "UTC");
        expect(asUtc[0].completed_today_count).toBe(1);
      });

      it("stamps completed_day on a completed occurrence for the client's grouping", async () => {
        // `todays` carries open tasks and anything with an occurrence row, so a
        // finished repeat is the case where the client both shows a done count
        // and buckets the day — the stamping is observable there.
        const ZONE = "America/Chicago";
        const day = todayStr(ZONE);
        const alice = await seedUser(db, { name: "Alice" });
        const rec = await seedTask(db, { name: "Water plants", dueAt: day, completedAt: null });
        await link(db, rec.id, alice.id);
        await db.db.insert(s.taskOccurrences).values({
          taskId: rec.id,
          occurrenceDate: day,
          // 21:00 the day before, i.e. a UTC date one day ahead of the local day.
          completedAt: `${addDays(day, 1)}T03:00:00`,
          completedBy: alice.id,
        }).run();

        const rows = await dashboard.childTodayRows(db.db, [alice.id], ZONE);
        const wire = rows[0].todays.find((t) => t.name === "Water plants")!;
        expect(wire.completed_at).toBe(`${addDays(day, 1)}T03:00:00`);
        // The viewer's day, not the UTC head of the stamp.
        expect(wire.completed_day).toBe(day);
        expect(wire.reviewed_day).toBeNull();
        // "n of m done" is a plain truthiness count, so it needs the flag, not
        // the day; the day is what the list sections group on.
        expect(rows[0].done).toBe(1);
        expect(rows[0].total).toBe(1);
      });
    });

    describe("scheduleEvents", () => {
      // The dashboard reads the Calendar module's cache, so these events are the
      // same rows the Calendar page shows — one timed UTC instant and one plain
      // all-day date, which the server must stamp in the *viewer's* frame.

      // The UTC instant of a wall-clock time on a local day, e.g. ("2026-09-27",
      // "20:00", "America/Los_Angeles"). Offsets shift with DST, so the fixtures
      // derive the instant rather than hard-coding an hour.
      function instantAt(day: string, hhmm: string, timeZone: string) {
        const wallAt = (ts: number) => {
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(new Date(ts));
          const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
          return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
        };
        // Start from the same wall time read as UTC, then step back until the
        // zone's own reading of the instant lands on it again; two passes settle
        // every real offset, DST included.
        const target = Date.parse(`${day}T${hhmm}:00Z`);
        let ts = target;
        for (let i = 0; i < 3; i++) {
          const drift = wallAt(ts) - target;
          if (!drift) break;
          ts -= drift;
        }
        return new Date(ts).toISOString();
      }

      async function seedSchedule(db: TestDatabase, timezone: string) {
        const today = todayStr(timezone);
        const [conn] = await db.db
          .insert(s.calendarConnections)
          .values({ provider: "google", calendarId: "family@group.calendar.google.com", label: "Family", enabled: true })
          .returning()
          .all();
        const [off] = await db.db
          .insert(s.calendarConnections)
          .values({ provider: "google", calendarId: "swim@group.calendar.google.com", enabled: false })
          .returning()
          .all();
        await db.db
          .insert(s.calendarCache)
          .values([
            // All-day on the viewer's today (stored as a plain local date).
            { connectionId: conn.id, eventId: "a1", summary: "Field trip", startAt: `${today}T00:00:00`, endAt: `${today}T00:00:00`, allDay: true },
            // 20:00 on the viewer's today, stored as the UTC instant Google sent.
            { connectionId: conn.id, eventId: "t1", summary: "Swim lesson", startAt: instantAt(today, "20:00", timezone), allDay: false },
            { connectionId: conn.id, eventId: "t2", summary: "Soccer", startAt: instantAt(addDays(today, 2), "09:00", timezone), allDay: false },
            // Past and beyond the window: never on the dashboard.
            { connectionId: conn.id, eventId: "old", summary: "Yesterday", startAt: instantAt(addDays(today, -2), "18:00", timezone), allDay: false },
            { connectionId: conn.id, eventId: "far", summary: "Two weeks out", startAt: instantAt(addDays(today, 14), "18:00", timezone), allDay: false },
            // A disabled calendar never contributes, same as on the Calendar page.
            { connectionId: off.id, eventId: "x1", summary: "Hidden swim", startAt: instantAt(today, "20:00", timezone), allDay: false },
          ])
          .run();
        return { today, conn };
      }

      it("returns the window in the viewer's frame, all-day first, chronologically", async () => {
        const ZONE = "America/Los_Angeles";
        const { today } = await seedSchedule(db, ZONE);

        const events = await dashboard.scheduleEvents(db.db, today, 7, ZONE);
        expect(events.map((e) => e.summary)).toEqual(["Field trip", "Swim lesson", "Soccer"]);

        // The evening event is stamped on the day the viewer is actually on, at
        // the hour they will turn up — while the stored instant sits on a
        // different UTC day, which is the frame that used to file it under
        // tomorrow and read as the wrong clock time.
        const lesson = events.find((e) => e.summary === "Swim lesson")!;
        expect(lesson.local_date).toBe(today);
        expect(lesson.local_time).toBe("20:00");
        expect(lesson.start_at!.slice(0, 10)).not.toBe(today);
        expect(lesson.calendar_label).toBe("Family");

        // All-day leads the day, timed events follow by clock time.
        expect(events[0].all_day).toBe(1);
        expect(events[1].local_time).toBe("20:00");
        expect(events.map((e) => e.local_date)).toEqual([today, today, addDays(today, 2)]);
      });

      it("keeps a full day inside the window for viewers far from UTC", async () => {
        // Kiritimati is UTC+14: its 00:01 local event is 10:01 UTC the *previous*
        // day, so a window built from the local date without padding would drop
        // the very first minute of the day.
        const ZONE = "Pacific/Kiritimati";
        const today = todayStr(ZONE);
        const [conn] = await db.db
          .insert(s.calendarConnections)
          .values({ provider: "google", calendarId: "c@group.calendar.google.com", enabled: true })
          .returning()
          .all();
        await db.db
          .insert(s.calendarCache)
          .values([{ connectionId: conn.id, eventId: "edge", summary: "Midnight", startAt: instantAt(today, "00:01", ZONE), allDay: false }])
          .run();

        const events = await dashboard.scheduleEvents(db.db, today, 7, ZONE);
        expect(events.map((e) => e.summary)).toEqual(["Midnight"]);
        expect(events[0].local_date).toBe(today);
        expect(events[0].local_time).toBe("00:01");
      });
    });

    describe("getDashboard", () => {
      it("aggregates weather(null), birthdays, members, unassigned, and today's meals", async () => {
        const today = todayStr();
        await seedUser(db, {
          name: "Birthday Kid",
          birthday: `2015-${today.slice(5)}`,
        });
        await seedUser(db, { name: "No Due Date" });

        // Assigned uncompleted task due today → shows on the member's list, not unassigned
        const assigned = await seedTask(db, { name: "Assigned task", dueAt: today });
        const me = (await db.db.select().from(s.users).orderBy(s.users.id).all())[0];
        await link(db, assigned.id, me.id);

        // An unassigned, uncompleted task with a due date → unassigned bucket
        await seedTask(db, { name: "Unassigned task", dueAt: today });

        await db.db.insert(s.modules).values({ name: "meal-plan", enabled: true }).run();
        await db.db.insert(s.mealPlan).values({ date: today, mealSlot: "dinner", text: "Pasta" }).run();

        const result = await dashboard.getDashboard(db.db);
        expect(result.date).toBe(today);
        expect(result.weather).toBeNull();
        expect(result.upcomingBirthdays.map((b) => b.name)).toContain("Birthday Kid");
        expect(result.children.map((c) => c.child.name).sort()).toEqual(["Birthday Kid", "No Due Date"]);
        expect(result.unassigned.map((t) => t.name)).toEqual(["Unassigned task"]);
        expect(result.todayMeals).toEqual({ dinner: "Pasta" });

        // Narrowed wall view for one member still summarizes the same day
        const single = await dashboard.getDashboard(db.db, { user_id: me.id });
        expect(single.children).toHaveLength(1);
        expect(single.children[0].child.id).toBe(me.id);
        expect(single.unassigned).toEqual([]);
        expect(single.upcomingEvents).toEqual([]);
      });

      it("carries the household schedule and drops it when the calendar module is off", async () => {
        const today = todayStr();
        await seedUser(db, { name: "No Due Date" });
        const [conn] = await db.db
          .insert(s.calendarConnections)
          .values({ provider: "google", calendarId: "family@group.calendar.google.com", label: "Family", enabled: true })
          .returning()
          .all();
        await db.db
          .insert(s.calendarCache)
          .values([
            { connectionId: conn.id, eventId: "e1", summary: "Piano", startAt: `${addDays(today, 1)}T15:00:00Z`, allDay: false },
          ])
          .run();

        const on = await dashboard.getDashboard(db.db, { timezone: "UTC" });
        expect(on.upcomingEvents.map((e) => e.summary)).toEqual(["Piano"]);

        // The schedule belongs to the Calendar module, so disabling that module
        // empties it instead of leaving stale events on the home view.
        await db.db.insert(s.modules).values({ name: "calendar", enabled: false }).run();
        const off = await dashboard.getDashboard(db.db, { timezone: "UTC" });
        expect(off.upcomingEvents).toEqual([]);
      });
    });

    async function seedTask(
      db: TestDatabase,
      overrides: Partial<{ name: string; dueAt: string | null; completedAt: string | null }>
    ) {
      const [t] = await db.db
        .insert(s.tasks)
        .values({
          name: overrides.name ?? "Task",
          dueAt: overrides.dueAt ?? null,
          completedAt: overrides.completedAt ?? null,
        } as never)
        .returning()
        .all();
      return t;
    }

    async function link(db: TestDatabase, taskId: number, userId: number) {
      await db.db.insert(s.taskAssignees).values({ taskId, userId }).run();
    }
  });
}