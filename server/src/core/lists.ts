import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { DbClient } from "./db.js";
import { getSetting } from "./db.js";
import { listItems, lists } from "../schema.js";
import { badRequest, notFound } from "./errors.js";

interface ListItemWire {
  id: number;
  list_id: number;
  text: string;
  checked: 0 | 1;
  added_by: string | null;
  created_at: string;
}

interface ListWire {
  id: number;
  name: string;
  created_at: string;
  items?: ListItemWire[];
}

function mapItemRow(i: typeof listItems.$inferSelect): ListItemWire {
  return {
    id: i.id,
    list_id: i.listId,
    text: i.text,
    checked: i.checked ? 1 : 0,
    added_by: i.addedBy,
    created_at: i.createdAt,
  };
}

function mapListRow(l: typeof lists.$inferSelect): ListWire {
  return { id: l.id, name: l.name, created_at: l.createdAt };
}

export async function listLists(db: DbClient) {
  const rows = await db.select().from(lists).orderBy(asc(lists.id)).all();
  const items = await db
    .select()
    .from(listItems)
    .where(isNull(listItems.deletedAt))
    .orderBy(asc(listItems.id))
    .all();
  const byList = new Map<number, ListItemWire[]>();
  for (const i of items) {
    const arr = byList.get(i.listId) ?? [];
    arr.push(mapItemRow(i));
    byList.set(i.listId, arr);
  }
  return rows.map((l) => {
    const out = mapListRow(l);
    out.items = byList.get(l.id) ?? [];
    return out;
  });
}

export async function createList(db: DbClient, name: string | undefined) {
  if (!name || !name.trim()) throw badRequest("name is required");
  const [row] = await db.insert(lists).values({ name: name.trim() }).returning().all();
  const out = mapListRow(row);
  out.items = [];
  return out;
}

export async function deleteList(db: DbClient, listId: number) {
  await db.delete(lists).where(eq(lists.id, listId)).run();
  return { ok: true };
}

export async function addItem(db: DbClient, listId: number, text: string | undefined) {
  if (!text || !text.trim()) throw badRequest("text is required");
  const list = await db.select({ id: lists.id }).from(lists).where(eq(lists.id, listId)).get();
  if (!list) throw notFound("list not found");
  const [row] = await db
    .insert(listItems)
    .values({ listId, text: text.trim() })
    .returning()
    .all();
  return mapItemRow(row);
}

export async function toggleItem(db: DbClient, itemId: number, checked: unknown) {
  const isChecked = Boolean(checked);
  await db
    .update(listItems)
    .set({
      checked: isChecked,
      // checked_at is the clock behind the auto-delete job: when an item gets
      // checked we stamp now, and unchecking clears it so time stops counting.
      checkedAt: isChecked ? sql`(datetime('now'))` : null,
    })
    .where(eq(listItems.id, itemId))
    .run();
  return { ok: true };
}

export async function removeItem(db: DbClient, itemId: number) {
  await db.delete(listItems).where(eq(listItems.id, itemId)).run();
  return { ok: true };
}

// Soft-delete every checked item whose checked_at is older than `minutes`,
// returning how many rows were tombstoned. Left for the hourly background job,
// but exported + tested so a caller can run a cleanup pass directly.
export async function deleteCheckedItemsOlderThan(db: DbClient, minutes: number): Promise<number> {
  const res = await db
    .update(listItems)
    .set({ deletedAt: sql`(datetime('now'))` })
    .where(
      and(
        isNull(listItems.deletedAt),
        eq(listItems.checked, true),
        isNotNull(listItems.checkedAt),
        lt(listItems.checkedAt, sql`datetime('now', ${`-${minutes} minutes`})`)
      )
    )
    .run();
  return Number(
    (res as { meta?: { changes?: unknown } })?.meta?.changes ??
      (res as { changes?: unknown })?.changes ??
      0
  );
}

// Hourly job entry: no-op unless the admin turned on the setting, then cleans
// everything past the configured threshold (default 1 hour = 60 minutes).
export async function autoDeleteCheckedItems(db: DbClient): Promise<number> {
  if ((await getSetting(db, "lists_autodelete_enabled")) !== "1") return 0;
  const minutes = Number(await getSetting(db, "lists_autodelete_minutes"));
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return deleteCheckedItemsOlderThan(db, minutes);
}