import { asc, eq } from "drizzle-orm";
import type { DbClient } from "./db.js";
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
  const items = await db.select().from(listItems).orderBy(asc(listItems.id)).all();
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
  await db.update(listItems).set({ checked: checked ? true : false }).where(eq(listItems.id, itemId)).run();
  return { ok: true };
}

export async function removeItem(db: DbClient, itemId: number) {
  await db.delete(listItems).where(eq(listItems.id, itemId)).run();
  return { ok: true };
}