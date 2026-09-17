import { useCallback, useEffect, useMemo, useState } from "react";
import { Users, LogOut } from "lucide-react";
import modules, { getClientModule } from "./modules/index.js";
import Avatar from "./components/Avatar.jsx";
import { getModules, getMembers, getTasks, logout } from "./api.js";
import { usePolling } from "./realtime.js";
import Logo from "./components/Logo.jsx";

// Wall display: keep the screen awake for as long as the kiosk is open.
// A screen wake lock is released when the tab is hidden, so re-request it
// whenever the kiosk becomes visible again.
function useScreenWakeLock() {
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let lock = null;
    let released = false;
    async function request() {
      if (released) return;
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {
        lock = null;
      }
    }
    function onVisibility() {
      if (document.visibilityState === "visible") request();
    }
    request();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      released = true;
      if (lock) lock.release().catch(() => {});
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}

// Wall-display shell: left-hand family sidebar (whole family + each member's
// avatar), module nav across the top filtered to the selected member, and the
// selected member's dashboard as the default view.
export default function KioskShell({ user, onLogout }) {
  const [members, setMembers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [globalEnabled, setGlobalEnabled] = useState(new Set());
  const [selectedId, setSelectedId] = useState(null); // null = whole family
  const [active, setActive] = useState("dashboard");

  useScreenWakeLock();

  const refresh = useCallback(async () => {
    const [mods] = await Promise.all([getModules(), getMembers()]);
    setGlobalEnabled(new Set(mods.filter((m) => m.enabled).map((m) => m.name)));
  }, []);

  const refreshMembers = useCallback(async () => {
    setMembers(await getMembers());
  }, []);

  const refreshTasks = useCallback(async () => {
    setTasks(await getTasks());
  }, []);

  usePolling("users", refreshMembers, 30000);
  usePolling("modules", refresh, 30000);
  usePolling("tasks", refreshTasks, 30000);

  useEffect(() => {
    refresh();
    refreshMembers();
    refreshTasks();
  }, [refresh, refreshMembers, refreshTasks]);

  const selected = useMemo(
    () => members.find((m) => m.id === selectedId) || null,
    [members, selectedId]
  );

  // The wall display shows real family members; accounts marked to be hidden
  // (e.g. the admin or the display account itself) are excluded from the sidebar.
  // Ordered oldest (top) to youngest (bottom); no-birthday members go last.
  const sidebarMembers = useMemo(
    () => members
      .filter((m) => !m.system_account)
      .sort((a, b) => {
        if (!a.birthday && !b.birthday) return 0;
        if (!a.birthday) return 1;
        if (!b.birthday) return -1;
        return a.birthday.localeCompare(b.birthday);
      }),
    [members]
  );

  // Per-member task counters for the sidebar badges (mirrors the Tasks module:
  // badge = incomplete assigned tasks, green ✓ when all fully done, none when
  // the member has no assigned tasks).
  const counts = useMemo(() => {
    const c = {};
    for (const m of sidebarMembers) {
      const mine = tasks.filter((t) => (t.assignees || []).some((a) => a.id === m.id));
      const fullyDone = (t) => t.completed_at && (!t.requires_adult_review || t.reviewed_at);
      c[m.id] = {
        total: mine.length,
        incomplete: mine.filter((t) => !fullyDone(t)).length,
      };
    }
    return c;
  }, [tasks, sidebarMembers]);

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
        <span className="title" style={{ display: "inline-flex", alignItems: "center", fontWeight: 800, flex: 1 }}>
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
              <span className="avatar-wrap">
                <Avatar user={m} size="lg" />
                {counts[m.id]?.total > 0 && (
                  counts[m.id].incomplete > 0
                    ? <span className="avatar-badge" title={`${counts[m.id].incomplete} incomplete task${counts[m.id].incomplete === 1 ? "" : "s"}`}>{counts[m.id].incomplete}</span>
                    : <span className="avatar-badge green" title="All tasks done">✓</span>
                )}
              </span>
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