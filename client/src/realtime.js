import { useEffect } from "react";

// Change-driven realtime layer. The server keeps a global change log behind
// /api/changes (same code on the Node container and the Cloudflare Worker) —
// every state mutation records which table it touched. This module short-polls
// that endpoint with a revision cursor and dispatches per-table events, so
// subscribers refresh ONLY when something they care about actually changed,
// never on a timer. There is exactly one poller regardless of how many
// components subscribe (a page subscribing to N tables previously started N
// independent timers, hammering endpoints like /api/dashboard every few
// seconds).

const listeners = new Map(); // table -> Set<cb>
const POLL_MS = 10000;
let pollTimer = null;
let cursor = null; // { rev, epoch } from the server's change log

function dispatch(table) {
  const cbs = listeners.get(table);
  if (cbs) for (const cb of [...cbs]) cb();
}

function notifyAll() {
  for (const table of listeners.keys()) dispatch(table);
}

async function pollOnce() {
  try {
    const qs = cursor ? `?since=${cursor.rev}&epoch=${cursor.epoch}` : "";
    const res = await fetch(`/api/changes${qs}`);
    if (!res.ok) return;
    const snap = await res.json();
    cursor = { rev: snap.rev, epoch: snap.epoch };
    const tables = snap.tables;
    if (tables === "*") notifyAll();
    else for (const t of tables) notify(t);
  } catch {
    /* offline or not signed in — try again next tick */
  }
}

function startPolling() {
  if (!pollTimer) {
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_MS);
  }
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// Start the shared poller while anyone is subscribed, stop it when the last
// subscriber leaves (e.g. on the login screen nothing polls).
function syncPolling() {
  const any = [...listeners.values()].some((s) => s.size > 0);
  if (any) startPolling();
  else stopPolling();
}

export function subscribe(table, cb) {
  if (!listeners.has(table)) listeners.set(table, new Set());
  const set = listeners.get(table);
  set.add(cb);
  syncPolling();
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(table);
    syncPolling();
  };
}

// Subscribe a refresh callback to a table (or list of tables); calls it when a
// change for that table arrives. Eat an empty initial refresh at mount.
export function useRealtime(tables, refresh) {
  const list = Array.isArray(tables) ? tables : [tables];
  const key = list.join(",");
  useEffect(() => {
    const offs = list.map((t) => subscribe(t, refresh));
    return () => offs.forEach((off) => off());
  }, [key, refresh]);
}

// Change-driven edition of `usePolling`: subscribes `refresh` to `table` (or a
// list of tables) instead of starting a per-subscription timer. The interval
// argument is accepted for call-site compatibility and ignored — refreshing on
// a schedule caused the constant server traffic this replaces.
export function usePolling(tables, refresh, _intervalMs) {
  useRealtime(tables, refresh);
}

// Kept as a no-op for compatibility — polling is driven by the subscriptions
// themselves, not by an explicit connect call.
export function ensureRealtime() {}