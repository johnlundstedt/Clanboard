import { useEffect } from "react";

// Lightweight WebSocket client with a table-keyed subscription bus.
// If the socket can't connect, pages just fall back to their own polling/manual refreshes.

const listeners = new Map(); // table -> Set<cb>
let socket = null;
let reconnectTimer = null;

function notify(table) {
  const cbs = listeners.get(table);
  if (cbs) for (const cb of [...cbs]) cb();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${proto}//${location.host}/ws`);

  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "change" && msg.table) notify(msg.table);
    } catch {
      /* ignore malformed */
    }
  };

  socket.onclose = () => {
    socket = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  };
  socket.onerror = () => socket?.close();
}

function ensureConnected() {
  if (!socket || socket.readyState > 1) connect();
}

export function ensureRealtime() {
  ensureConnected();
}

export function subscribe(table, cb) {
  ensureConnected();
  if (!listeners.has(table)) listeners.set(table, new Set());
  const set = listeners.get(table);
  set.add(cb);
  return () => set.delete(cb);
}

// Subscribe a refresh callback to a table; calls cb when a change broadcast arrives.
export function useRealtime(table, refresh) {
  useEffect(() => subscribe(table, refresh), [table, refresh]);
}

// Fallback: poll every `intervalMs` while the socket isn't connected.
export function usePolling(table, refresh, intervalMs = 10000) {
  useRealtime(table, refresh);
  useEffect(() => {
    const id = setInterval(() => {
      if (!socket || socket.readyState !== 1) refresh();
    }, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, refresh, intervalMs]);
}