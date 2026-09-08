import { useCallback, useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import modules, { getClientModule } from "./modules/index.js";
import Avatar from "./components/Avatar.jsx";
import { getModules, getMembers, logout } from "./api.js";
import { usePolling } from "./realtime.js";

// Wall-display shell: left-hand family sidebar (whole family + each member's
// avatar), module nav across the top filtered to the selected member, and the
// selected member's dashboard as the default view.
export default function KioskShell({ user, onLogout }) {
  const [members, setMembers] = useState([]);
  const [globalEnabled, setGlobalEnabled] = useState(new Set());
  const [selectedId, setSelectedId] = useState(null); // null = whole family
  const [active, setActive] = useState("dashboard");

  const refresh = useCallback(async () => {
    const [mods] = await Promise.all([getModules(), getMembers()]);
    setGlobalEnabled(new Set(mods.filter((m) => m.enabled).map((m) => m.name)));
  }, []);

  const refreshMembers = useCallback(async () => {
    setMembers(await getMembers());
  }, []);

  usePolling("users", refreshMembers, 30000);
  usePolling("modules", refresh, 30000);

  useEffect(() => {
    refresh();
    refreshMembers();
  }, [refresh, refreshMembers]);

  const selected = useMemo(
    () => members.find((m) => m.id === selectedId) || null,
    [members, selectedId]
  );

  // Modules visible for the selected member, or the globally-enabled set when
  // the whole family is selected. Admin-only modules need an admin selected.
  const visible = useMemo(() => {
    let names;
    if (selected) names = new Set(selected.enabled_modules || []);
    else names = globalEnabled;
    return modules.filter(
      (m) => names.has(m.name) && (!m.adminOnly || !!selected?.is_admin)
    );
  }, [selected, globalEnabled]);

  // Home is the landing view; keep it reachable even if it ever disappears
  // from the resolved set.
  const nav = useMemo(() => {
    const list = visible.some((m) => m.name === "dashboard")
      ? visible
      : [getClientModule("dashboard"), ...visible].filter(Boolean);
    return list;
  }, [visible]);

  function selectMember(id) {
    setSelectedId(id);
    const m = id ? members.find((x) => x.id === id) : null;
    const names = new Set(m?.enabled_modules || []);
    const defaultFor = modules.find(
      (mod) => names.has(mod.name) && (!mod.adminOnly || m?.is_admin)
    );
    setActive(defaultFor?.name || "dashboard");
  }

  const currentModule = getClientModule(active);

  return (
    <div className="kiosk">
      <aside className="kiosk-side">
        <button
          className={`kiosk-family ${!selected ? "active" : ""}`}
          onClick={() => selectMember(null)}
          title="Show the whole family"
        >
          <span className="avatar kiosk-avatar">
            <Users size={28} />
          </span>
          <span className="kiosk-name">Whole family</span>
        </button>

        {members.map((m) => (
          <button
            key={m.id}
            className={`kiosk-member ${selectedId === m.id ? "active" : ""}`}
            onClick={() => selectMember(m.id)}
            title={m.name}
          >
            <Avatar user={m} size="lg" />
            <span className="kiosk-name">{m.name}</span>
          </button>
        ))}
      </aside>

      <div className="kiosk-main">
        <nav className="nav">
          <span className="title">{user.family_name ? `${user.family_name} Clanboard` : "Clanboard"}</span>
          {nav.map((m) => (
            <button
              key={m.name}
              className={`navlink ${active === m.name ? "active" : ""}`}
              onClick={() => setActive(m.name)}
              title={m.navLabel}
            >
              {m.icon && <m.icon size={18} style={{ verticalAlign: "-3px", marginRight: 5 }} />}
              {m.navLabel}
            </button>
          ))}
          <span className="spacer" />
          <span className="muted small">{selected ? selected.name : "Whole family"}</span>
          <button className="navlink" onClick={async () => { await logout(); onLogout(); }}>
            Log out
          </button>
        </nav>

        <main style={{ maxWidth: 1100, margin: "0 auto", padding: "1rem" }}>
          {currentModule?.page ? (
            <currentModule.page user={user} memberId={selectedId} />
          ) : (
            <div className="card">This module isn't available for {selected?.name || "this view"}.</div>
          )}
        </main>
      </div>
    </div>
  );
}