import { useCallback, useEffect, useState } from "react";
import modules from "../index.js";
import WeatherLocation from "../../components/WeatherLocation.jsx";
import {
  getAdminSettings, setAdminSettings,
  getAdminModules, setModuleEnabled,
} from "../../api.js";
import { usePolling } from "../../realtime.js";

const UNITS = [
  ["metric", "Metric (°C)"],
  ["imperial", "Imperial (°F)"],
  ["both", "Both (°F & °C)"],
];

export default function BasicSettingsPanel({ onSaved }) {
  const [familyName, setFamilyName] = useState("");
  const [units, setUnits] = useState("metric");
  const [unitsSaved, setUnitsSaved] = useState(false);
  const [moduleStatuses, setModuleStatuses] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [siteUrl, setSiteUrl] = useState("");

  const refresh = useCallback(async () => {
    const [s, mods] = await Promise.all([getAdminSettings(), getAdminModules()]);
    setFamilyName(s.family_name || "");
    setUnits(s.weather_units || "metric");
    setModuleStatuses(mods);
    setEmailConfigured(!!s.email_configured);
    setSiteUrl(s.site_url || "");
  }, []);

  usePolling("modules", refresh);

  useEffect(() => { refresh(); }, [refresh]);

  async function saveSettings() {
    setSaving(true);
    try {
      await setAdminSettings({ family_name: familyName });
      window.dispatchEvent(new Event("fh:modules-changed"));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    } finally {
      setSaving(false);
    }
  }

  async function saveEmailSettings() {
    setSaving(true);
    try {
      await setAdminSettings({ site_url: siteUrl });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveUnits(value) {
    setUnits(value);
    await setAdminSettings({ weather_units: value });
    setUnitsSaved(true);
    setTimeout(() => setUnitsSaved(false), 2000);
    onSaved?.();
  }

  async function toggleModule(name, enabled) {
    await setModuleEnabled(name, enabled);
    window.dispatchEvent(new Event("fh:modules-changed"));
    refresh();
  }

  const preview = familyName.trim() ? `${familyName.trim()} Clanboard` : "Clanboard";

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Household</h3>

        <div className="row wrap" style={{ gap: "0.5rem" }}>
          <label className="grow" style={{ minWidth: 220 }}>
            <span className="small muted" style={{ display: "block", marginBottom: "0.25rem" }}>Clan name</span>
            <input
              className="grow"
              value={familyName}
              onChange={(e) => setFamilyName(e.target.value)}
              placeholder="e.g. Lundstedt"
            />
          </label>
        </div>

        <div className="small muted" style={{ marginTop: "0.5rem" }}>
          Shown in the top-left corner as <strong>{preview}</strong>.
        </div>

        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button className="primary" onClick={saveSettings} disabled={saving}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save settings"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Modules</h3>
        <div className="small muted" style={{ marginBottom: "0.6rem" }}>
          Enable or disable each module for the whole household. Disabled modules
          disappear from navigation and stop running.
        </div>
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {moduleStatuses.map((s) => {
            const meta = modules.find((m) => m.name === s.name);
            return (
              <label key={s.name} className="row" style={{ justifyContent: "space-between" }}>
                <div className="row">
                  {meta?.icon ? <meta.icon size={18} /> : <span>🧩</span>}
                  <strong>{meta?.navLabel || s.name}</strong>
                </div>
                <span className="row small">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={meta?.locked}
                    onChange={(e) => toggleModule(s.name, e.target.checked)}
                  />
                  {meta?.locked ? "Core — always on" : s.enabled ? "Enabled" : "Disabled"}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Weather</h3>

        <label style={{ minWidth: 200, display: "block", marginBottom: "0.75rem" }}>
          <span className="small muted" style={{ display: "block", marginBottom: "0.25rem" }}>Weather units</span>
          <select value={units} onChange={(e) => saveUnits(e.target.value)}>
            {UNITS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          {unitsSaved && <span className="small" style={{ marginLeft: "0.5rem", color: "var(--green)" }}>Saved ✓</span>}
        </label>

        <WeatherLocation onSaved={onSaved} />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Member login & email</h3>
        <div className="small muted" style={{ marginBottom: "0.6rem" }}>
          Members sign in with their name and a password. When login is enabled
          for a member, a temporary password is emailed from{" "}
          <strong>no-reply@clanboard.app</strong> (add that address to your{" "}
          <a href="https://resend.com/domains" target="_blank" rel="noreferrer">Resend</a>{" "}
          verified domain). First sign-in forces a password change; three failed
          attempts locks the account until a parent unlocks it.
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <span className="small muted" style={{ display: "block", marginBottom: "0.25rem" }}>Email sending (Resend)</span>
          {emailConfigured ? (
            <span className="badge green">Enabled — API key from deployment config</span>
          ) : (
            <span className="badge amber">Not configured — set the RESEND_API_KEY secret</span>
          )}
        </div>
        <label style={{ display: "block", marginBottom: "0.75rem" }}>
          <span className="small muted" style={{ display: "block", marginBottom: "0.25rem" }}>Site URL (for email links)</span>
          <input
            style={{ width: "26rem", maxWidth: "100%" }}
            type="url"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://clanboard.app"
          />
        </label>
        <div className="row">
          <button className="primary" onClick={saveEmailSettings} disabled={saving}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save email settings"}
          </button>
        </div>
      </div>
    </div>
  );
}