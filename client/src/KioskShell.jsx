import { useCallback, useEffect, useMemo, useState } from "react";
import { Users, LogOut } from "lucide-react";
import modules, { getClientModule } from "./modules/index.js";
import Avatar from "./components/Avatar.jsx";
import { getModules, getMembers, logout } from "./api.js";
import { usePolling } from "./realtime.js";
import Logo from "./components/Logo.jsx";

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

  // The wall display shows real family members; accounts marked to be hidden
  // (e.g. the admin or the display account itself) are excluded from the sidebar.
  // Ordered oldest (top) to youngest (bottom); no-birthday members go last.
  const sidebarMembers = useMemo(
    () => members
      .filter((m) => !m.hide_from_kiosk)
      .sort((a, b) => {
        if (!a.birthday && !b.birthday) return 0;
        if (!a.birthday) return 1;
        if (!b.birthday) return -1;
        return a.birthday.localeCompare(b.birthday);
      }),
    [members]
  );

  // Modules visible for the selected member, or the globally-enabled set when
  // the whole family is selected. Admin-only modules need an admin selected.
  const visible = useMemo(() => {
    let names;
    if (selected) names = new Set(selected.enabled_modules || []);
    else names = globalEnabled;
    return modules.filter(
      (m) =>
        m.name !== "admin" && // admin settings are reserved for a logged-in user
        names.has(m.name) &&
        (!m.adminOnly || !!selected?.is_admin)
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
      <nav className="nav">
        <span className="title" style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 800, flex: 1 }}>
          <Logo size={38} />
          <span style={{ whiteSpace: "nowrap" }}><span className="clan">Clan</span><span className="board" style={{ marginLeft: "0.12em" }}>Board</span></span>
        </span>
        <div className="nav-modules">
          {nav.map((m) => (
            <button
              key={m.name}
              className={`navlink ${active === m.name ? "active" : ""}`}
              onClick={() => setActive(m.name)}
              title={m.navLabel}
            >
              {m.icon && <m.icon size={34} />}
            </button>
          ))}
        </div>
        <span className="nav-actions">
          <button className="navlink" title="Log out" onClick={async () => { await logout(); onLogout(); }}>
            <LogOut size={32} />
          </button>
        </span>
      </nav>

      <div className="kiosk-body">
        <aside className="kiosk-side">
          <button
            className={`kiosk-family ${!selected ? "active" : ""}`}
            onClick={() => selectMember(null)}
            title="Show the whole clan"
          >
            <span className="avatar kiosk-avatar">
              <Users size={28} />
            </span>
            <span className="kiosk-name">Whole Clan</span>
          </button>

          {sidebarMembers.map((m) => (
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
          <main style={{ maxWidth: 1100, margin: "0 auto", padding: "1rem" }}>
            {currentModule?.page ? (
              <currentModule.page user={user} memberId={selectedId} member={selected || undefined} />
            ) : (
              <div className="card">This module isn't available for {selected?.name || "this view"}.</div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}