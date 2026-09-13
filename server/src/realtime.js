import { WebSocketServer } from "ws";

// Node-container WebSocket transport only. Portable change notifications live
// in src/web/events.js (change log + ws hook); this file is never imported by
// the future Workers entry.

let wss = null;

export function setupRealtime(server) {
  wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });
  });

  const interval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30000);
  wss.on("close", () => clearInterval(interval));
}

// Broadcast a change to all connected clients. `table` is used by clients to
// decide which cached data to invalidate.
export function broadcast(table, payload = {}) {
  if (!wss) return;
  const msg = JSON.stringify({ type: "change", table, ...payload });
  for (const socket of wss.clients) {
    if (socket.readyState === 1) socket.send(msg);
  }
}