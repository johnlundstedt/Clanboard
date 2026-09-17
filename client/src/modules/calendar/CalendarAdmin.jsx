import { useCallback, useEffect, useState } from "react";
import {
  getCalendarConnections, createCalendarConnection, updateCalendarConnection, deleteCalendarConnection, syncCalendar,
} from "../../api.js";

const COLORS = ["", "#3b82f6", "#16a34a", "#ea580c", "#9333ea", "#dc2626", "#0d9488", "#ca8a04"];

export default function CalendarAdmin({ onSaved }) {
  const [connections, setConnections] = useState([]);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  const refresh = useCallback(async () => {
    setConnections(await getCalendarConnections());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg("");
    try {
      const res = await syncCalendar();
      setSyncMsg(
        res.errors?.length
          ? `Synced with ${res.errors.length} error(s).`
          : `Synced ${res.counts.reduce((n, c) => n + (c.inserted || 0), 0)} events.`
      );
      await refresh();
    } catch {
      setSyncMsg("Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div className="row">
        <div className="grow">
          <p className="small muted" style={{ margin: 0 }}>
            Each calendar is read-only and synced into the Calendar view every 15 minutes. Add a Google
            Calendar ID or paste a share link, give the calendar an optional background color, and toggle
            sync on or off from its edit form.
          </p>
        </div>
        <button className="primary" onClick={() => { setEditing(null); setShowForm(true); }}>+ Add calendar</button>
        <button onClick={handleSync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
      </div>

      {syncMsg && <div className="small">{syncMsg}</div>}

      {(showForm || editing) && (
        <div className="card">
          <CalendarForm
            key={editing?.id ?? "new"}
            initial={editing}
            onCancel={() => { setShowForm(false); setEditing(null); }}
            onSaved={refresh}
          />
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>Connected calendars</h2>
        <div style={{ display: "grid", gap: "0.4rem" }}>
          {connections.map((c) => (
            <div key={c.id} className="row" style={{ padding: "0.3rem 0" }}>
              <span className="badge" style={{ background: c.color || "#eef2ff", color: "#1e293b" }}>
                {c.label || c.calendar_id}
              </span>
              <span className="small muted grow">{c.calendar_id}</span>
              <CalendarStatus conn={c} />
              <button onClick={() => { setEditing(c); setShowForm(false); }}>Edit</button>
            </div>
          ))}
          {connections.length === 0 && <p className="muted">No calendars connected yet.</p>}
        </div>
      </div>
    </div>
  );
}

function CalendarStatus({ conn }) {
  if (!conn.enabled) {
    return (
      <span className="badge" title="Disabled — not synced" style={{ background: "#e2e8f0", color: "#475569" }}>
        off
      </span>
    );
  }
  if (conn.last_sync_error) {
    return (
      <span className="badge" title={conn.last_sync_error} style={{ background: "#fee2e2", color: "#b91c1c" }}>
        ⚠ sync error
      </span>
    );
  }
  if (conn.last_synced_at) {
    return <span className="small muted" style={{ whiteSpace: "nowrap" }}>synced {fmtTime(conn.last_synced_at)}</span>;
  }
  return <span className="small muted" style={{ whiteSpace: "nowrap" }}>never synced</span>;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function CalendarForm({ initial, onCancel, onSaved }) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [calendarId, setCalendarId] = useState(initial?.calendar_id ?? "");
  const [apiKey, setApiKey] = useState(initial?.api_key ?? "");
  const [color, setColor] = useState(initial?.color ?? "");
  const [enabled, setEnabled] = useState(initial ? !!initial.enabled : true);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!calendarId.trim()) return;
    try {
      const payload = {
        label: label.trim() || null,
        calendar_id: calendarId.trim(),
        api_key: apiKey.trim() || null,
        color: color || null,
        enabled,
      };
      if (initial) await updateCalendarConnection(initial.id, payload);
      else await createCalendarConnection(payload);
      onCancel();
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete() {
    if (!initial) return;
    if (!confirm(`Remove the calendar "${initial.label || initial.calendar_id}"? Its synced events are removed from the app.`)) return;
    await deleteCalendarConnection(initial.id);
    onCancel();
    onSaved();
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.6rem" }}>
      <h3 style={{ margin: 0 }}>{initial ? `Edit ${initial.label || initial.calendar_id}` : "Add calendar"}</h3>

      <div className="row wrap">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Kids)" style={{ flex: 1, minWidth: 120 }} />
        <input value={calendarId} onChange={(e) => setCalendarId(e.target.value)} placeholder="Google calendar ID or share link" style={{ flex: 2, minWidth: 200 }} required />
      </div>

      <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Google API key (blank = use the GOOGLE_API_KEY deployment config)" style={{ width: "100%" }} />

      <div className="row wrap">
        <select value={color} onChange={(e) => setColor(e.target.value)}>
          {COLORS.map((c) => <option key={c || "none"} value={c}>{c ? "Color" : "Default color"}</option>)}
        </select>
        <label className="row small">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <strong>Enabled — sync this calendar</strong>
        </label>
      </div>
      {!enabled && (
        <span className="small muted">While off, this calendar is not synced and its events are hidden from the Calendar view.</span>
      )}

      {error && <span className="small" style={{ color: "#b91c1c" }}>{error}</span>}

      <div className="row">
        <button className="primary" type="submit">{initial ? "Save" : "Add calendar"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
        {initial && <button type="button" className="danger" onClick={handleDelete}>Delete calendar</button>}
      </div>
    </form>
  );
}