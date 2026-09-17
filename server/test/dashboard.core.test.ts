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