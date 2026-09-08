import { useEffect, useState } from "react";
import { getAdminSettings, setAdminSettings, geocode, reverseGeocode } from "../api.js";

// Reusable weather-location editor: city search, "use my location", and manual
// coordinates. Writes through the admin settings endpoint.
export default function WeatherLocation({ onSaved }) {
  const [label, setLabel] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [saved, setSaved] = useState(false);
  const [locating, setLocating] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await getAdminSettings();
      setLabel(s.weather_location || "");
      setLat(s.latitude || "");
      setLon(s.longitude || "");
    })();
  }, []);

  async function save(coords) {
    await setAdminSettings(coords);
    flashSaved();
    onSaved?.();
  }

  async function pick(place) {
    await save({
      latitude: place.latitude,
      longitude: place.longitude,
      weather_location: place.display,
    });
    setLat(String(place.latitude));
    setLon(String(place.longitude));
    setLabel(place.display);
    setResults(null);
    setQuery("");
  }

  async function search(q) {
    setQuery(q);
    if (!q.trim()) { setResults(null); return; }
    setSearching(true);
    try {
      const res = await geocode(q);
      setResults(res.results || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function useMyLocation() {
    if (!navigator.geolocation) {
      alert("Your browser doesn't support geolocation.");
      return;
    }
    setLocating(true);
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 })
      );
      const myLat = pos.coords.latitude.toFixed(4);
      const myLon = pos.coords.longitude.toFixed(4);
      let name = null;
      try { name = (await reverseGeocode(myLat, myLon)).name; } catch { /* ignore */ }
      await pick({ latitude: myLat, longitude: myLon, display: name || "My location" });
    } catch (err) {
      alert(`Couldn't get your location: ${err.message || "permission denied"}`);
    } finally {
      setLocating(false);
    }
  }

  async function saveManual() {
    await save({ latitude: lat, longitude: lon, weather_location: label });
  }

  function flashSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ display: "grid", gap: "0.6rem", marginTop: "0.75rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
      <div className="small muted">Weather location (Open-Meteo, no API key needed):</div>

      {/* City search */}
      <div style={{ position: "relative" }}>
        <div className="row">
          <input
            className="grow"
            value={query}
            onChange={(e) => search(e.target.value)}
            placeholder="Search for a city… (e.g. San Francisco)"
          />
          <button type="button" onClick={useMyLocation} disabled={locating}>
            {locating ? "Locating…" : "📍 Use my location"}
          </button>
        </div>
        {searching && <div className="small muted" style={{ marginTop: "0.3rem" }}>Searching…</div>}
        {!searching && results && results.length > 0 && (
          <div className="card" style={{ position: "absolute", zIndex: 10, width: "100%", marginTop: "0.3rem", padding: "0.25rem" }}>
            {results.map((r, i) => (
              <button
                key={i}
                type="button"
                style={{ display: "block", width: "100%", textAlign: "left", border: "none", background: "transparent", padding: "0.45rem 0.6rem", borderRadius: 8 }}
                onClick={() => pick({ latitude: r.latitude, longitude: r.longitude, display: displayName(r) })}
              >
                {displayName(r)}
                <span className="small muted"> · {r.latitude.toFixed(3)}, {r.longitude.toFixed(3)}</span>
              </button>
            ))}
          </div>
        )}
        {!searching && results && results.length === 0 && (
          <div className="small muted" style={{ marginTop: "0.3rem" }}>No places found for “{query}”.</div>
        )}
      </div>

      {lat && lon && (
        <div className="row small">
          <span className="badge green">✓ {label || "Set"}</span>
          <span className="muted">{lat}, {lon}</span>
        </div>
      )}

      {/* Advanced: manual coordinates */}
      <button className="small" type="button" onClick={() => setShowAdvanced((v) => !v)} style={{ justifySelf: "start" }}>
        {showAdvanced ? "Hide manual coordinates" : "Enter coordinates manually"}
      </button>
      {showAdvanced && (
        <div className="row wrap" style={{ gap: "0.5rem" }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Home)" style={{ flex: 1, minWidth: 90 }} />
          <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="Latitude" style={{ flex: 1, minWidth: 120 }} />
          <input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="Longitude" style={{ flex: 1, minWidth: 120 }} />
          <button className="primary" type="button" onClick={saveManual} disabled={!lat.trim() || !lon.trim()}>
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      )}

      <div className="small muted">The dashboard shows today + next 2 days once a location is set.</div>
    </div>
  );
}

function displayName(r) {
  return [r.name, r.admin1, r.country].filter(Boolean).join(", ");
}