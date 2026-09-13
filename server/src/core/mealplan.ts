import { and, between, eq, sql } from "drizzle-orm";
import type { DbClient } from "./db.js";
import { mealPlan } from "../schema.js";
import { badRequest } from "./errors.js";

export const SLOTS = ["breakfast", "lunch", "dinner", "snack"];

interface MealEntryWire {
  id: number;
  date: string;
  meal_slot: string;
  text: string | null;
  created_at: string;
}

function mapEntryRow(e: typeof mealPlan.$inferSelect): MealEntryWire {
  return {
    id: e.id,
    date: e.date,
    meal_slot: e.mealSlot,
    text: e.text,
    created_at: e.createdAt,
  };
}

export function weekEndStr(start: string): string {
  const end = new Date(`${start}T12:00:00`);
  end.setDate(end.getDate() + 6);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
}

export async function getWeek(db: DbClient, start: string | undefined) {
  if (!start) throw badRequest("start (YYYY-MM-DD) is required");

  // Match the old handler's date math rather than "fixing" it: days are added
  // with plain Date arithmetic, so DST-heavy zones behave exactly as before.
  const end = weekEndStr(start);

  const rows = await db
    .select()
    .from(mealPlan)
    .where(between(mealPlan.date, start, end))
    .orderBy(mealPlan.date)
    .all();

  return { start, end, entries: rows.map(mapEntryRow), slots: SLOTS };
}

export async function setEntry(db: DbClient, date: string, slot: string, text: string | undefined) {
  if (!SLOTS.includes(slot)) throw badRequest("invalid meal slot");

  const value = (text || "").trim();
  if (!value) {
    await db.delete(mealPlan).where(and(eq(mealPlan.date, date), eq(mealPlan.mealSlot, slot))).run();
  } else {
    await db
      .insert(mealPlan)
      .values({ date, mealSlot: slot, text: value })
      .onConflictDoUpdate({ target: [mealPlan.date, mealPlan.mealSlot], set: { text: sql`excluded.text` } })
      .run();
  }
  return { ok: true };
}