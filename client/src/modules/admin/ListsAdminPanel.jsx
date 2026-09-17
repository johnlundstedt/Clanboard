import { useCallback, useEffect, useState } from "react";
import { getAdminSettings, setAdminSettings } from "../../api.js";

// Admin panel for the Lists module: whether the hourly background job should
// clean up checked items, and after how long (default 1 hour).
export default function ListsAdminPanel({ onSaved }) {
  const [autoDelete, setAutoDelete] = useState(false);
  // Stored as minutes; presented as hours so the default reads "1 hour".
  const [hours, setHours] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    const s = await getAdminSettings();
    setAutoDelete(!!s.lists_autodelete_enabled);
    const minutes = Number(s.lists_autodelete_minutes) || 60;
    setHours(minutes / 60);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function save() {
    setSaving(true);
    try {
      const minutes = Math.round((Number(hours) || 1) * 60);
      await setAdminSettings({
        lists_autodelete_enabled: autoDelete,
        lists_autodelete_minutes: minutes,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Checked item cleanup</h3>
        <div className="small muted" style={{ marginBottom: "0.75rem" }}>
          A background job quietly retires checked items after they've sat
          checked for a while, so shopping lists don't pile up with old done
          items. Unchecked items are never touched.
        </div>

        <label className="row" style={{ justifyContent: "space-between", marginBottom: "0.75rem" }}>
          <div className="row">
            <input
              type="checkbox"
              checked={autoDelete}
              onChange={(e) => setAutoDelete(e.target.checked)}
            />
            <strong>Automatically remove checked items</strong>
          </div>
          <span className="small muted">{autoDelete ? "On" : "Off"}</span>
        </label>

        <label style={{ display: "block", maxWidth: "14rem" }}>
          <span className="small muted" style={{ display: "block", marginBottom: "0.25rem" }}>
            Remove after (hours)
          </span>
          <input
            type="number"
            min="0.5"
            step="0.5"
            value={hours}
            disabled={!autoDelete}
            onChange={(e) => setHours(e.target.value === "" ? 1 : Number(e.target.value))}
          />
          <span className="small muted" style={{ marginTop: "0.4rem", display: "block" }}>
            Defaults to 1 hour (60 minutes).
          </span>
        </label>

        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save settings"}
          </button>
        </div>
      </div>
    </div>
  );
}