import { useCallback, useEffect, useState } from "react";
import { User, Lock, LogOut } from "lucide-react";
import modules, { getClientModule } from "./modules/index.js";
import { getMe, login, logout } from "./api.js";
import { ensureRealtime } from "./realtime.js";
import KioskShell from "./KioskShell.jsx";
import Logo from "./components/Logo.jsx";
import Avatar from "./components/Avatar.jsx";

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
    function onUserChanged() {
      loadSession();
    }
    window.addEventListener("fh:unauthorized", onUnauthorized);
    window.addEventListener("fh:modules-changed", onModulesChanged);
    window.addEventListener("fh:user-changed", onUserChanged);
    return () => {
      window.removeEventListener("fh:unauthorized", onUnauthorized);
      window.removeEventListener("fh:modules-changed", onModulesChanged);
      window.removeEventListener("fh:user-changed", onUserChanged);
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
        <span className="title" style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 800, flex: 1 }}>
          <Logo size={38} />
          <span style={{ whiteSpace: "nowrap" }}><span className="clan">Clan</span><span className="board" style={{ marginLeft: "0.12em" }}>Board</span></span>
        </span>
        <div className="nav-modules">
          {visible.map((m) => (
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
          <Avatar user={user} className="nav-avatar" />
          <button className="navlink" title="Log out" onClick={async () => { await logout(); setUser(null); }}>
            <LogOut size={32} />
          </button>
        </span>
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
      <div className="login-brand">
        <Logo size={300} />
        <h1><span className="clan">Clan</span> <span className="board">Board</span></h1>
        <p className="login-tagline">Clan life, organized.</p>
      </div>
      <form className="card login-card" onSubmit={submit}>
        <h2 style={{ margin: "1.25rem 0 0.4rem" }}>Welcome</h2>
        <p className="small" style={{ margin: "0 0 1.5rem", color: "var(--muted)" }}>Sign in to your Clan Board account</p>
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <div className="field">
            <User size={18} className="field-icon" />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus autoComplete="username" />
          </div>
          <div className="field">
            <Lock size={18} className="field-icon" />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
          </div>
          {error && <p className="small" style={{ color: "var(--red)", margin: 0 }}>{error}</p>}
          <button className="primary" type="submit" disabled={busy} style={{ marginBottom: "1.25rem" }}>{busy ? "Signing in…" : "Sign in"}</button>
        </div>
      </form>
    </div>
  );
}