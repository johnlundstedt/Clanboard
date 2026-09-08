import WeatherLocation from "../../components/WeatherLocation.jsx";

// Dashboard admin panel: weather location. Reuses the shared editors.
export default function DashboardAdmin({ onSaved }) {
  return (
    <div style={{ marginTop: "0.75rem" }}>
      <WeatherLocation onSaved={onSaved} />
    </div>
  );
}