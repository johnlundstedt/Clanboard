import { useCallback, useEffect, useState } from "react";
import {
  getCalendarConnections, createCalendarConnection, deleteCalendarConnection, syncCalendar,
} from "../../api.js";

const COLORS = ["", "#3b82f6", "#16a34a", "#ea580c", "#9333ea", "#dc2626", "#0d9488", "#ca8a04"];

export default function CalendarAdmin({ onSaved }) {
  const [connections, setConnections] = useState([]);
  const [form, setForm] = useState({ label: "", calendar_id: "", api_key: "", color: "" });
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  const refresh = useCallback(async () => {
    setConnections(await getCalendarConnections());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleAdd() {
    if (!form.calendar_id.trim()) return;
    await createCalendarConnection({ ...form, calendar_id: form.calendar_id.trim() });
    setForm({ label: "", calendar_id: "", api_key: "", color: "" });
    refresh();
    onSaved?.();
  }

  async function handleRemove(id) {
    await deleteCalendarConnection(id);
    refresh();
    onSaved?.();
  }

  async function handleSync() {
    setSyncing(true);
    setSyncMsg("");
    try {
      const res = await syncCalendar();
      setSyncMsg(
        res.errors?.length
          ? `Synced with ${res.errors.length} error(s): ${res.errors[0]}`
          : `Synced ${res.counts.reduce((n, c) => n + (c.inserted || 0), 0)} events.`
      );
      onSaved?.();
    } catch {
      setSyncMsg("Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.75rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <div className="small muted">Google Calendar connections (read-only, synced into the Calendar view):</div>
        <button onClick={handleSync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
      </div>
      {syncMsg && <div className="small">{syncMsg}</div>}

      {connections.length === 0 && (
        <div className="small muted">
          Add a Google Calendar ID. Use a shared/API-key-accessible calendar — events load into the app but stay read-only.
        </div>
      )}

      <div style={{ display: "grid", gap: "0.35rem" }}>
        {connections.map((c) => (
          <div key={c.id} className="row">
            <span className="badge" style={{ background: c.color || "#eef2ff", color: "#1e293b" }}>
              {c.label || c.calendar_id}
            </span>
            <span className="small muted grow">{c.calendar_id}</span>
            <button className="small danger" onClick={() => handleRemove(c.id)}>Remove</button>
          </div>
        ))}
      </div>

      <div className="row wrap" style={{ gap: "0.4rem" }}>
        <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Label (e.g. Kids)" style={{ flex: 1, minWidth: 90 }} />
        <input value={form.calendar_id} onChange={(e) => setForm({ ...form, calendar_id: e.target.value })} placeholder="Google calendar ID" style={{ flex: 2, minWidth: 150 }} />
        <input value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="API key (optional)" style={{ flex: 2, minWidth: 150 }} />
        <select value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })}>
          {COLORS.map((c) => <option key={c || "none"} value={c}>{c ? "Color" : "Default"}</option>)}
        </select>
        <button className="primary" onClick={handleAdd}>Add</button>
      </div>
    </div>
  );
}