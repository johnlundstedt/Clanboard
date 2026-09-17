import { useCallback, useEffect, useState } from "react";
import { User, Lock, LogOut } from "lucide-react";
import modules, { getClientModule } from "./modules/index.js";
import { getMe, login, logout, forgotPassword, setPassword, getTodayTasks } from "./api.js";
import { ensureRealtime, usePolling } from "./realtime.js";
import KioskShell from "./KioskShell.jsx";
import Logo from "./components/Logo.jsx";
import Avatar from "./components/Avatar.jsx";
import PasswordInput from "./components/PasswordInput.jsx";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(null);
  const [todayDueCount, setTodayDueCount] = useState(0);

  const tasksEnabled = !!user && !user.is_kiosk && (user.enabled_modules || []).includes("tasks");

  const refreshTodayDue = useCallback(async () => {
    try {
      const { date, dueToday } = await getTodayTasks();
      const today = date || todayStr();
      setTodayDueCount(dueToday.filter((t) => (t.due_at || "").slice(0, 10) === today).length);
    } catch {
      /* not signed in / tasks unavailable — keep whatever we had */
    }
  }, []);

  // Keep the header count fresh: subscribe to the tasks change bus (same
  // shared realtime poller the pages use), but only once the member can see
  // tasks.
  usePolling("tasks", refreshTodayDue);
  useEffect(() => {
    if (tasksEnabled) refreshTodayDue();
  }, [tasksEnabled, refreshTodayDue]);

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

  // First sign-in with a temporary password: choose a permanent one before
  // anything else (applies to login-managed members; exempt accounts are never
  // flagged).
  if (user.must_change_password) {
    return <SetPasswordScreen user={user} onDone={loadSession} />;
  }

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
        <span className="title" style={{ display: "inline-flex", alignItems: "center", fontWeight: 800, flex: 1 }}>
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
              {m.name === "tasks" && todayDueCount > 0 && (
                <span className="nav-badge" title="Outstanding tasks due today">{todayDueCount}</span>
              )}
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
  const [mode, setMode] = useState("login");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "forgot") {
        await forgotPassword(name.trim(), password);
        setMode("sent");
      } else {
        await login(name.trim(), password);
        await onLogin();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-brand">
        <Logo size={150} />
        <h1><span className="clan">Clan</span> <span className="board">Board</span></h1>
        <p className="login-tagline">Clan life, organized.</p>
      </div>
      <form className="card login-card" onSubmit={submit}>
        {mode === "forgot" ? (
          <>
            <h2 style={{ margin: "1.25rem 0 0.4rem" }}>Reset password</h2>
            <p className="small" style={{ margin: "0 0 1.5rem", color: "var(--muted)" }}>
              Enter your name and the email on your account.
            </p>
            <div style={{ display: "grid", gap: "0.6rem" }}>
              <div className="field">
                <User size={18} className="field-icon" />
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus autoComplete="username" />
              </div>
              <div className="field">
                <Lock size={18} className="field-icon" />
                <input type="email" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Email" autoComplete="email" />
              </div>
              {error && <p className="small" style={{ color: "var(--red)", margin: 0 }}>{error}</p>}
              <button className="primary" type="submit" disabled={busy}>{busy ? "Sending…" : "Email me a temporary password"}</button>
              <button type="button" className="small" style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer" }} onClick={() => { setMode("login"); setError(""); }}>
                Back to sign in
              </button>
            </div>
          </>
        ) : mode === "sent" ? (
          <>
            <h2 style={{ margin: "1.25rem 0 0.4rem" }}>Check your email</h2>
            <p className="small" style={{ margin: "0 0 1.5rem", color: "var(--muted)" }}>
              If a matching account exists, a temporary password is on its way. Use it to sign in, then choose a new password.
            </p>
            <button type="button" className="primary" onClick={() => { setMode("login"); setName(""); setPassword(""); setError(""); }}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <h2 style={{ margin: "1.25rem 0 0.4rem" }}>Welcome</h2>
            <p className="small" style={{ margin: "0 0 1.5rem", color: "var(--muted)" }}>Sign in to your Clan Board account</p>
            <div style={{ display: "grid", gap: "0.6rem" }}>
              <div className="field">
                <User size={18} className="field-icon" />
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus autoComplete="username" />
              </div>
              <PasswordInput leftIcon={<Lock size={18} />} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
              {error && <p className="small" style={{ color: "var(--red)", margin: 0 }}>{error}</p>}
              <button className="primary" type="submit" disabled={busy} style={{ marginBottom: "1.25rem" }}>{busy ? "Signing in…" : "Sign in"}</button>
              <button type="button" className="small" style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer" }} onClick={() => { setMode("forgot"); setError(""); setPassword(""); }}>
                Forgot password?
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function SetPasswordScreen({ user, onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (next !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    try {
      await setPassword(current, next);
      await onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-brand">
        <Logo size={150} />
        <h1><span className="clan">Clan</span> <span className="board">Board</span></h1>
        <p className="login-tagline">Clan life, organized.</p>
      </div>
      <form className="card login-card" onSubmit={submit}>
        <h2 style={{ margin: "1.25rem 0 0.4rem" }}>Hi {user.name}, pick a new password</h2>
        <p className="small" style={{ margin: "0 0 1.5rem", color: "var(--muted)" }}>
          At least 8 characters, with an uppercase letter, a lowercase letter, and a symbol.
        </p>
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <PasswordInput leftIcon={<Lock size={18} />} value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Temporary password" autoFocus autoComplete="current-password" />
          <PasswordInput leftIcon={<Lock size={18} />} value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password" autoComplete="new-password" />
          <PasswordInput leftIcon={<Lock size={18} />} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat new password" autoComplete="new-password" />
          {error && <p className="small" style={{ color: "var(--red)", margin: 0 }}>{error}</p>}
          <button className="primary" type="submit" disabled={busy} style={{ marginBottom: "1.25rem" }}>{busy ? "Saving…" : "Save new password"}</button>
        </div>
        <button type="button" className="small" style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer" }} onClick={async () => { await logout(); window.dispatchEvent(new Event("fh:unauthorized")); }}>
          Log out
        </button>
      </form>
    </div>
  );
}