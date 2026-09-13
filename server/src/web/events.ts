import { changeLog } from "../core/changes.js";

// Portable change-notification layer. Adapters call `notify*` after any state
// mutation; the change log records it for /api/changes pollers, and the
// container additionally pushes the ws broadcast (Node-only) when a hook is
// bound. The Workers entry only needs the change log (no bindWsBroadcast).

type WsHook = (table: string, payload?: Record<string, unknown>) => void;
let wsBroadcast: WsHook | null = null;

// Bind the ws push (container entry only). Passes through to realtime.js.
export function bindWsBroadcast(fn: WsHook): void {
  wsBroadcast = fn;
}

export function notify(table: string, payload: Record<string, unknown> = {}): void {
  changeLog.record(table);
  wsBroadcast?.(table, payload);
}

export const notifyList = () => notify("lists");
export const notifyTasks = () => notify("tasks");
export const notifyMealPlan = () => notify("meal_plan");
export const notifyCalendar = () => notify("calendar");
export const notifyUsers = () => notify("users");
export const notifyModules = () => notify("modules");
export const notifyDashboard = () => notify("dashboard");