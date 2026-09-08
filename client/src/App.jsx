import { useCallback, useEffect, useState } from "react";
import modules, { getClientModule } from "./modules/index.js";
import { getMe, login, logout } from "./api.js";
import { ensureRealtime } from "./realtime.js";
import KioskShell from "./KioskShell.jsx";

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(null);

  useEffect(() => {
    function onUnauthorized() {
      setUser(null);
      setLoading(false);
    }
    function onModulesChanged() {
      loadSession();
    }
    window.addEventListener("fh:unauthorized", onUnauthorized);
    window.addEventListener("fh:modules-changed", onModulesChanged);
    return () => {
      window.removeEventListener("fh:unauthorized", onUnauthorized);
      window.removeEventListener("fh:modules-changed", onModulesChanged);
    };
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me);
      const resolved = new Set(me.enabled_modules || []);
      const defaultMod = modules.find((m) => m.default) || modules[0];
      setActive((a) => a || (resolved.has(defaultMod.name)
        ? defaultMod.name
        : modules.find((m) => resolved.has(m.name) && !m.adminOnly)?.name || defaultMod.name));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSession();
    ensureRealtime();
  }, [loadSession]);

  if (loading) return <div className="login-wrap"><div className="card">Loading…</div></div>;

  if (!user) return <LoginScreen onLogin={loadSession} />;

  // Wall-display account: the whole-household kiosk shell with the family sidebar
  if (user.is_kiosk) return <KioskShell user={user} onLogout={() => setUser(null)} />;

  // Regular logins: nav is scoped to the modules the admin enabled for this member
  const userMods = new Set(user.enabled_modules || []);
  const visible = modules.filter(
    (m) => userMods.has(m.name) && (!m.adminOnly || user.is_admin)
  );
  const currentModule = getClientModule(active);
  const Page = currentModule?.page;

  return (
    <div>
      <nav className="nav">
        <span className="title">{user.family_name ? `${user.family_name} Clanboard` : "Clanboard"}</span>
        {visible.map((m) => (
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
        <span className="muted small">{user.name}</span>
        <button className="navlink" onClick={async () => { await logout(); setUser(null); }}>Log out</button>
      </nav>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "1rem" }}>
        {Page ? (
          <Page user={user} />
        ) : (
          <div className="card">This module isn't available.</div>
        )}
      </main>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(name.trim(), password);
      await onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1 style={{ marginTop: 0 }}>Clanboard</h1>
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus autoComplete="username" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
          {error && <p className="small" style={{ color: "var(--red)", margin: 0 }}>{error}</p>}
          <button className="primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </div>
      </form>
    </div>
  );
}