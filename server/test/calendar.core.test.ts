import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../src/schema.js";
import * as calendar from "../src/core/calendar.js";
import type { ConnectionWire } from "../src/core/calendar.js";
import {
  closeD1,
  makeD1Database,
  makeSqliteDatabase,
  type TestDatabase,
} from "./helpers/db.js";

// calendar core: connection CRUD, event cache reads, and the sync flow's
// failure modes — proven identical on better-sqlite3 and D1. Google's HTTP API
// is not touched (connections without an API key exercise the sync error path).

const backends = [
  { name: "sqlite", make: makeSqliteDatabase },
  { name: "d1", make: makeD1Database },
];

afterAll(async () => {
  await closeD1();
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

for (const backend of backends) {
  describe(`core/calendar (${backend.name})`, () => {
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

    describe("parseCalendarId", () => {
      it("accepts a raw calendar id", () => {
        expect(calendar.parseCalendarId("family@group.calendar.google.com")).toBe(
          "family@group.calendar.google.com"
        );
        expect(calendar.parseCalendarId("  primary  ")).toBe("primary");
      });

      it("decodes the cid share-link format (base64url)", () => {
        const id = "family@group.calendar.google.com";
        const url = `https://calendar.google.com/calendar/u/0?cid=${b64(id)}`;
        expect(calendar.parseCalendarId(url)).toBe(id);
      });

      it("decodes the embed src format", () => {
        const url =
          "https://calendar.google.com/calendar/embed?src=family%40group.calendar.google.com";
        expect(calendar.parseCalendarId(url)).toBe("family@group.calendar.google.com");
      });

      it("decodes the ical export format", () => {
        const url =
          "https://calendar.google.com/calendar/ical/family%40group.calendar.google.com/public/basic.ics";
        expect(calendar.parseCalendarId(url)).toBe("family@group.calendar.google.com");
      });

      it("rejects empty input, non-URLs with an unrecognizable shape, and foreign URLs", () => {
        expect(calendar.parseCalendarId("")).toBeNull();
        expect(calendar.parseCalendarId("   ")).toBeNull();
        expect(calendar.parseCalendarId("https://example.com/somewhere")).toBeNull();
      });
    });

    describe("connections", () => {
      it("create requires a usable calendar id and returns the mapped row", async () => {
        await expect(
          calendar.createConnection(db.db, {
            calendar_id: "https://example.com/not-a-calendar",
          } as never)
        ).rejects.toMatchObject({ status: 400 });

        const conn = await calendar.createConnection(db.db, {
          calendar_id: "family@group.calendar.google.com",
          label: "Family",
          api_key: "key123",
        });
        expect(conn.id).toBeGreaterThan(0);
        expect(conn.calendar_id).toBe("family@group.calendar.google.com");
        expect(conn.label).toBe("Family");
        expect(conn.api_key).toBe("key123");
        expect(conn.enabled).toBe(1); // wire shape: 1|0, like the container
        expect(conn.provider).toBe("google");
        expect(typeof conn.created_at).toBe("string");
      });

      it("updateConnection edits fields and validates replacements", async () => {
        const conn = await calendar.createConnection(db.db, {
          calendar_id: "a@group.calendar.google.com",
          label: "Old",
          enabled: true,
        });
        await calendar.updateConnection(db.db, conn.id, {
          label: "Renamed",
          enabled: false,
          calendar_id: "b@group.calendar.google.com",
        });
        const all = await calendar.listConnections(db.db);
        expect(all).toHaveLength(1);
        expect(all[0].label).toBe("Renamed");
        expect(all[0].enabled).toBe(0);
        expect(all[0].calendar_id).toBe("b@group.calendar.google.com");

        await expect(
          calendar.updateConnection(db.db, conn.id, { calendar_id: "https://example.com/not-a-calendar" })
        ).rejects.toMatchObject({ status: 400 });
        await expect(calendar.updateConnection(db.db, 9999, { label: "x" })).rejects.toMatchObject({
          status: 404,
        });
      });

      it("deleteConnection removes the connection", async () => {
        const conn = await calendar.createConnection(db.db, {
          calendar_id: "c@group.calendar.google.com",
        });
        await calendar.deleteConnection(db.db, conn.id);
        expect(await calendar.listConnections(db.db)).toEqual([]);
      });
    });

    describe("config key fallback", () => {
      beforeEach(() => calendar.initCalendarConfig({ googleApiKey: null }));
      afterEach(() => calendar.initCalendarConfig({ googleApiKey: null }));

      it("prefers a connection's own key over deployment config", () => {
        calendar.initCalendarConfig({ googleApiKey: "cfg-key" });
        expect(calendar.resolveApiKey({ api_key: "conn-key" })).toBe("conn-key");
        expect(calendar.resolveApiKey({ api_key: null })).toBe("cfg-key");
        expect(calendar.resolveApiKey({ api_key: "" })).toBe("cfg-key");
        calendar.initCalendarConfig({ googleApiKey: null });
        expect(calendar.resolveApiKey({ api_key: null })).toBeNull();
      });

      it("uses the configured Google API key when the connection has none", async () => {
        const realFetch = globalThis.fetch;
        const urls: string[] = [];
        vi.stubGlobal(
          "fetch",
          (async (input: string | URL | Request) => {
            urls.push(String(input));
            return new Response(JSON.stringify({ items: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }) as typeof fetch
        );
        try {
          calendar.initCalendarConfig({ googleApiKey: "cfg-key" });
          const conn = await calendar.createConnection(db.db, {
            calendar_id: "family@group.calendar.google.com",
          });
          const result = (await calendar.syncConnection(db.db, conn as ConnectionWire)) as {
            inserted: number;
          };
          expect(result.inserted).toBe(0);
          expect(urls).toHaveLength(1);
          expect(new URL(urls[0]).searchParams.get("key")).toBe("cfg-key");
        } finally {
          vi.unstubAllGlobals();
          globalThis.fetch = realFetch;
        }
      });

      it("a connection's own key beats the config key in the sync request", async () => {
        const realFetch = globalThis.fetch;
        const urls: string[] = [];
        vi.stubGlobal(
          "fetch",
          (async (input: string | URL | Request) => {
            urls.push(String(input));
            return new Response(JSON.stringify({ items: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }) as typeof fetch
        );
        try {
          calendar.initCalendarConfig({ googleApiKey: "cfg-key" });
          const conn = await calendar.createConnection(db.db, {
            calendar_id: "family@group.calendar.google.com",
            api_key: "conn-key",
          });
          await calendar.syncConnection(db.db, conn as ConnectionWire);
          expect(urls).toHaveLength(1);
          expect(new URL(urls[0]).searchParams.get("key")).toBe("conn-key");
        } finally {
          vi.unstubAllGlobals();
          globalThis.fetch = realFetch;
        }
      });
    });

    describe("getEvents", () => {
      it("joins cache to connections, applies the window, and hides disabled calendars", async () => {
        const on = await calendar.createConnection(db.db, {
          calendar_id: "family@group.calendar.google.com",
          label: "Family",
          enabled: true,
          color: "#f00",
        });
        const off = await calendar.createConnection(db.db, {
          calendar_id: "swim@group.calendar.google.com",
          label: "Swim",
        });
        // Enabled is only changeable afterwards (create ignores it, like the container)
        await calendar.updateConnection(db.db, off.id, { enabled: false });

        await db.db
          .insert(s.calendarCache)
          .values([
            { connectionId: on.id, eventId: "e1", summary: "Morning", startAt: "2026-09-11T08:00:00", endAt: "2026-09-11T09:00:00", allDay: false },
            { connectionId: on.id, eventId: "e2", summary: "All day", startAt: "2026-09-11T00:00:00", endAt: "2026-09-11T00:00:00", allDay: true },
            { connectionId: off.id, eventId: "e3", summary: "Hidden swim", startAt: "2026-09-11T10:00:00" },
            { connectionId: on.id, eventId: "e4", summary: "Outside window", startAt: "2026-09-13T10:00:00" },
          ])
          .run();

        const events = await calendar.getEvents(db.db, "2026-09-11T00:00:00", "2026-09-12T00:00:00");
        expect(events.map((e) => e.event_id)).toEqual(["e2", "e1"]);
        const allDay = events[0];
        expect(allDay.summary).toBe("All day");
        expect(allDay.all_day).toBe(1);
        expect(allDay.calendar_label).toBe("Family");
        expect(events[0].start_at).toBe("2026-09-11T00:00:00");

        // Without an end bound the window is half-open
        const open = await calendar.getEvents(db.db, "2026-09-11T00:00:00");
        expect(open.map((e) => e.event_id)).toEqual(["e2", "e1", "e4"]);
      });
    });

    describe("sync flow failures", () => {
      it("reports a missing API key instead of throwing", async () => {
        const conn = await calendar.createConnection(db.db, {
          calendar_id: "family@group.calendar.google.com",
        });
        const result = (await calendar.syncConnection(db.db, conn as ConnectionWire)) as {
          skipped: number;
          error?: string;
        };
        expect(result.skipped).toBe(0);
        expect(typeof result.error).toBe("string");
        expect(result.error).toContain("API key");
      });

      it("skips disabled connections and aggregates errors in runSyncAll", async () => {
        await calendar.createConnection(db.db, {
          calendar_id: "a@group.calendar.google.com",
          enabled: true,
        });
        const off = await calendar.createConnection(db.db, {
          calendar_id: "swim@group.calendar.google.com",
          enabled: false,
        });
        await calendar.updateConnection(db.db, off.id, { enabled: false });
        const result = await calendar.runSyncAll(db.db);
        expect(result.counts).toHaveLength(1);
        expect(result.counts[0].skipped).toBe(0);
        expect(result.errors).toHaveLength(1);
        void off;
      });
    });

    describe("sync status", () => {
      beforeEach(() => calendar.initCalendarConfig({ googleApiKey: "cfg-key" }));
      afterEach(() => calendar.initCalendarConfig({ googleApiKey: null }));

      it("records last_synced_at and clears the error on success", async () => {
        const realFetch = globalThis.fetch;
        vi.stubGlobal(
          "fetch",
          (async () =>
            new Response(JSON.stringify({ items: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })) as typeof fetch
        );
        try {
          const conn = await calendar.createConnection(db.db, {
            calendar_id: "family@group.calendar.google.com",
          });
          await calendar.syncConnection(db.db, conn as ConnectionWire);
          const [row] = await calendar.listConnections(db.db);
          expect(row.last_synced_at).toBeTruthy();
          expect(row.last_sync_error).toBeNull();
        } finally {
          vi.unstubAllGlobals();
          globalThis.fetch = realFetch;
        }
      });

      it("persists the failure message on a sync error and recovers afterwards", async () => {
        const realFetch = globalThis.fetch;
        const fail = (async () => new Response("not found", { status: 404 })) as typeof fetch;
        const succeed = (async () =>
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })) as typeof fetch;
        try {
          const conn = await calendar.createConnection(db.db, {
            calendar_id: "family@group.calendar.google.com",
          });

          vi.stubGlobal("fetch", fail);
          await calendar.syncConnection(db.db, conn as ConnectionWire);
          let [row] = await calendar.listConnections(db.db);
          expect(row.last_sync_error).toContain("Google Calendar 404");
          expect(row.last_synced_at).toBeNull();

          vi.stubGlobal("fetch", succeed);
          await calendar.syncConnection(db.db, conn as ConnectionWire);
          [row] = await calendar.listConnections(db.db);
          expect(row.last_sync_error).toBeNull();
          expect(row.last_synced_at).toBeTruthy();
        } finally {
          vi.unstubAllGlobals();
          globalThis.fetch = realFetch;
        }
      });

      it("disabled connections keep their status and are never fetched", async () => {
        const realFetch = globalThis.fetch;
        let fetched = 0;
        vi.stubGlobal(
          "fetch",
          (async () => {
            fetched += 1;
            return new Response(JSON.stringify({ items: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }) as typeof fetch
        );
        try {
          const conn = await calendar.createConnection(db.db, {
            calendar_id: "family@group.calendar.google.com",
          });
          await calendar.syncConnection(db.db, conn as ConnectionWire);
          await calendar.updateConnection(db.db, conn.id, { enabled: false });
          const result = await calendar.syncConnection(db.db, (await calendar.listConnections(db.db))[0]);
          expect(result.skipped).toBe(0);
          expect(await calendar.runSyncAll(db.db)).toEqual({ counts: [], errors: [] });
          expect(fetched).toBe(1);
        } finally {
          vi.unstubAllGlobals();
          globalThis.fetch = realFetch;
        }
      });
    });
  });
}