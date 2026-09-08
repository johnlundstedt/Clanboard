import { useState } from "react";
import { SlidersHorizontal, ListChecks, UserCog, Users, Calendar } from "lucide-react";
import BasicSettingsPanel from "./BasicSettingsPanel.jsx";
import TasksAdminPanel from "./TasksAdminPanel.jsx";
import RolesPanel from "./RolesPanel.jsx";
import MembersPanel from "./MembersPanel.jsx";
import CalendarAdmin from "../calendar/CalendarAdmin.jsx";

const SECTIONS = [
  {
    key: "basic",
    label: "Basic Settings",
    icon: SlidersHorizontal,
    desc: "Family name, weather units, module toggles, and weather location.",
    component: BasicSettingsPanel,
  },
  {
    key: "tasks",
    label: "Tasks",
    icon: ListChecks,
    desc: "Task categories, priorities, and optional dollar values.",
    component: TasksAdminPanel,
  },
  {
    key: "roles",
    label: "Roles",
    icon: UserCog,
    desc: "Named roles and the permissions each member gets per module.",
    component: RolesPanel,
  },
  {
    key: "members",
    label: "Members",
    icon: Users,
    desc: "Add or edit household members, photos, roles, and admin flags.",
    component: MembersPanel,
  },
  {
    key: "calendar",
    label: "Calendar",
    icon: Calendar,
    desc: "Google Calendar connections (read-only, synced in).",
    component: CalendarAdmin,
  },
];

export default function AdminPage({ onSaved }) {
  const [section, setSection] = useState(null);

  if (section) {
    const meta = SECTIONS.find((s) => s.key === section);
    const Panel = meta.component;
    return (
      <div>
        <div className="row wrap" style={{ marginBottom: "1rem", justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>{meta.label}</h1>
          <button onClick={() => setSection(null)}>← All sections</button>
        </div>
        <Panel onSaved={onSaved} />
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ margin: "0 0 1rem" }}>Admin</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "0.9rem" }}>
        {SECTIONS.map(({ key, label, icon: Icon, desc }) => (
          <button
            key={key}
            className="card"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "0.6rem",
              textAlign: "left",
              color: "var(--text)",
              cursor: "pointer",
            }}
            onClick={() => setSection(key)}
          >
            <span className="row" style={{ gap: "0.6rem" }}>
              <Icon size={26} style={{ color: "var(--accent)" }} />
              <strong style={{ fontSize: "1.05rem" }}>{label}</strong>
            </span>
            <span className="small muted">{desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}