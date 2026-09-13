import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { DbClient } from "./db.js";
import { calendarCache, calendarConnections } from "../schema.js";
import { badRequest, notFound } from "./errors.js";

export interface ConnectionWire {
  id: number;
  provider: string;
  label: string | null;
  calendar_id: string;
  api_key: string | null;
  color: string | null;
  enabled: 0 | 1;
  created_at: string;
}

function mapConnection(c: typeof calendarConnections.$inferSelect): ConnectionWire {
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    calendar_id: c.calendarId,
    api_key: c.apiKey,
    color: c.color,
    enabled: c.enabled ? 1 : 0,
    created_at: c.createdAt,
  };
}

// Accept either a raw Google Calendar id (e.g. "abc@group.calendar.google.com")
// or one of Google's shareable links. Returns the raw calendar id, or null if
// the input isn't recognizable.
export function parseCalendarId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  if (!/^https?:\/\//i.test(raw)) return raw; // plain calendar id

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // ?cid=<base64url of the id> (the "add by link" share format)
  const cid = url.searchParams.get("cid");
  if (cid) {
    try {
      const b64 = cid.replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const decoded = atob(padded).trim();
      if (decoded) return decoded;
    } catch {
      /* fall through */
    }
    return cid.trim();
  }

  // ?src=<encoded id> (the embed format)
  const src = url.searchParams.get("src");
  if (src) {
    try {
      return decodeURIComponent(src.trim());
    } catch {
      return src.trim();
    }
  }

  // /ical/<id>/public/basic.ics (the export format)
  const ical = url.pathname.match(/\/ical\/(.+?)(?:\/public)?(?:\/(?:basic|full)\.ics)?$/);
  if (ical) {
    try {
      return decodeURIComponent(ical[1]);
    } catch {
      return ical[1];
    }
  }

  return null;
}

export async function listConnections(db: DbClient): Promise<ConnectionWire[]> {
  const rows = await db.select().from(calendarConnections).orderBy(asc(calendarConnections.id)).all();
  return rows.map(mapConnection);
}

export async function createConnection(db: DbClient, body: Record<string, unknown>) {
  const { provider, label, calendar_id, api_key, color } = body;
  const parsed = parseCalendarId(calendar_id);
  if (!parsed) throw badRequest("Enter a Google Calendar ID or a calendar share link.");
  const [conn] = await db
    .insert(calendarConnections)
    .values({
      provider: (provider as string) || "google",
      label: (label as string | null) ?? null,
      calendarId: parsed,
      apiKey: (api_key as string | null) ?? null,
      color: (color as string | null) ?? null,
    })
    .returning()
    .all();
  return mapConnection(conn);
}

export async function updateConnection(db: DbClient, id: number, body: Record<string, unknown>) {
  const existing = await db.select().from(calendarConnections).where(eq(calendarConnections.id, id)).get();
  if (!existing) throw notFound("Not found");
  const { label, calendar_id, api_key, color, enabled } = body;

  let parsedId: string | null = null;
  if (calendar_id !== undefined) {
    parsedId = parseCalendarId(calendar_id);
    if (!parsedId) throw badRequest("Enter a Google Calendar ID or a calendar share link.");
  }

  await db
    .update(calendarConnections)
    .set({
      label: label !== undefined ? (label as string | null) : existing.label,
      calendarId: parsedId ?? existing.calendarId,
      apiKey: api_key !== undefined ? (api_key as string | null) : existing.apiKey,
      color: color !== undefined ? (color as string | null) : existing.color,
      enabled: enabled !== undefined ? Boolean(enabled) : existing.enabled,
    })
    .where(eq(calendarConnections.id, id))
    .run();
  return { ok: true };
}

export async function deleteConnection(db: DbClient, id: number) {
  await db.delete(calendarConnections).where(eq(calendarConnections.id, id)).run();
  return { ok: true };
}

// --- Events (read-only cache) -------------------------------------------------

interface EventWire {
  id: number;
  connection_id: number;
  event_id: string;
  summary: string | null;
  location: string | null;
  description: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: 0 | 1;
  color: string | null;
  calendar_label: string | null;
}

export async function getEvents(db: DbClient, start: string, end?: string): Promise<EventWire[]> {
  const rows = await db
    .select({
      id: calendarCache.id,
      connectionId: calendarCache.connectionId,
      eventId: calendarCache.eventId,
      summary: calendarCache.summary,
      location: calendarCache.location,
      description: calendarCache.description,
      startAt: calendarCache.startAt,
      endAt: calendarCache.endAt,
      allDay: calendarCache.allDay,
      color: calendarCache.color,
      calendarLabel: calendarConnections.label,
    })
    .from(calendarCache)
    .innerJoin(calendarConnections, eq(calendarConnections.id, calendarCache.connectionId))
    .where(
      and(
        gte(calendarCache.startAt, start),
        eq(calendarConnections.enabled, true),
        end ? lt(calendarCache.startAt, end) : undefined
      )
    )
    .orderBy(asc(calendarCache.startAt))
    .all();
  return rows.map((r) => ({
    id: r.id,
    connection_id: r.connectionId,
    event_id: r.eventId,
    summary: r.summary,
    location: r.location,
    description: r.description,
    start_at: r.startAt,
    end_at: r.endAt,
    all_day: r.allDay ? 1 : 0,
    color: r.color,
    calendar_label: r.calendarLabel,
  }));
}

// --- Google Calendar sync -----------------------------------------------------

async function fetchEvents(
  conn: ConnectionWire,
  timeMin: string,
  timeMax: string
): Promise<unknown[]> {
  if (!conn.api_key) {
    throw new Error(
      "Google Calendar sync needs an API key: in Google Cloud, enable the " +
        "Calendar API for your project, create an API key, then save it on this " +
        "calendar connection (Admin → Calendar)."
    );
  }
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id)}/events`
  );
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("key", conn.api_key);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Calendar ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { items?: unknown[] };
  return data.items || [];
}

interface GcalItem {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  colorId?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

function isAllDay(item: GcalItem) {
  return !!item.start?.date;
}

function normalizeStart(item: GcalItem): string | null {
  if (item.start?.date) return `${item.start.date}T00:00:00`;
  return item.start?.dateTime || item.start?.date || null;
}

function normalizeEnd(item: GcalItem): string | null {
  if (item.end?.date) return `${item.end.date}T00:00:00`;
  return item.end?.dateTime || item.end?.date || null;
}

// Sync one connection into the cache. Returns summary counts; callers broadcast
// the realtime event on success (the framework-owned part stays in adapters).
export async function syncConnection(db: DbClient, conn: ConnectionWire) {
  if (!conn.enabled) return { skipped: 0 };

  const timeMin = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

  let items: unknown[];
  try {
    items = await fetchEvents(conn, timeMin, timeMax);
  } catch (err) {
    // Leave cache intact on transient failure; admin sees error in sync result
    console.error(`[calendar] sync ${conn.id} (${conn.calendar_id}):`, err instanceof Error ? err.message : err);
    return { skipped: 0, error: err instanceof Error ? err.message : String(err) };
  }

  const seen = new Set<string>();
  for (const raw of items) {
    const item = raw as GcalItem;
    if (!item?.id) continue;
    if (!isAllDay(item) && !item.start?.dateTime) continue;
    seen.add(item.id);
    await db
      .insert(calendarCache)
      .values({
        connectionId: conn.id,
        eventId: item.id,
        summary: item.summary || "(untitled)",
        location: item.location || null,
        description: item.description || null,
        startAt: normalizeStart(item),
        endAt: normalizeEnd(item),
        allDay: isAllDay(item),
        color: item.colorId || conn.color || null,
      })
      .onConflictDoUpdate({
        target: [calendarCache.connectionId, calendarCache.eventId],
        set: {
          summary: sql`excluded.summary`,
          location: sql`excluded.location`,
          description: sql`excluded.description`,
          startAt: sql`excluded.start_at`,
          endAt: sql`excluded.end_at`,
          allDay: sql`excluded.all_day`,
          color: sql`excluded.color`,
        },
      })
      .run();
  }

  // Remove events that disappeared from the source within our window
  if (seen.size > 0) {
    const ids = [...seen];
    await db
      .delete(calendarCache)
      .where(
        and(
          eq(calendarCache.connectionId, conn.id),
          sql`${calendarCache.eventId} NOT IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
        )
      )
      .run();
  }

  return { inserted: seen.size };
}

export async function runSyncAll(db: DbClient) {
  const conns = (await db.select().from(calendarConnections).where(eq(calendarConnections.enabled, true)).all()).map(mapConnection);
  const counts: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const conn of conns) {
    const result = await syncConnection(db, conn);
    counts.push({ id: conn.id, calendar_id: conn.calendar_id, ...result });
    if (result.error) errors.push(result.error as string);
  }
  return { counts, errors };
}