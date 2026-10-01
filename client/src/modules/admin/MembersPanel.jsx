import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ChevronDown, ImagePlus, Trash2 } from "lucide-react";
import Avatar from "../../components/Avatar.jsx";
import PasswordInput from "../../components/PasswordInput.jsx";
import {
  getMembers, createMember, updateMember, deleteMember, unlockMember, resetMemberPassword, uploadPhoto,
  getRoles,
} from "../../api.js";
import { usePolling } from "../../realtime.js";

// Manage household members: name, photo, birthday and gender, plus the role,
// admin flag and optional email sign-in that decide what they can reach.
export default function MembersPanel() {
  const [members, setMembers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showSystemAccounts, setShowSystemAccounts] = useState(false);

  const refresh = useCallback(async () => {
    const [m, r] = await Promise.all([getMembers(), getRoles()]);
    setMembers(m);
    setRoles(r);
  }, []);

  usePolling("users", refresh);

  useEffect(() => { refresh(); }, [refresh]);

  // System accounts (e.g. the kiosk / wall-display login) are hidden until the
  // "Show system accounts" toggle is switched on.
  const visibleMembers = showSystemAccounts
    ? members
    : members.filter((m) => !m.system_account);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div className="row">
        <div className="grow">
          <p className="small muted" style={{ margin: 0 }}>
            Each member has a name, photo and birthday. A role decides what they
            can see and do; switch on sign-in to let them log in with their own
            email address.
          </p>
        </div>
        <button className="primary" onClick={() => { setEditing(null); setShowForm(true); }}>+ Add member</button>
      </div>

      {(showForm || editing) && (
        <div className="card">
          <MemberForm
            key={editing?.id ?? "new"}
            roles={roles}
            initial={editing}
            onCancel={() => { setShowForm(false); setEditing(null); }}
            onSaved={refresh}
          />
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>Household members</h2>
        <label className="row small" style={{ marginBottom: "0.6rem" }}>
          <input type="checkbox" checked={showSystemAccounts} onChange={(e) => setShowSystemAccounts(e.target.checked)} />
          Show wall display and system accounts
        </label>
        <div style={{ display: "grid", gap: "0.4rem" }}>
          {visibleMembers.map((m) => (
            <div key={m.id} className="row" style={{ padding: "0.3rem 0" }}>
              <Avatar user={m} />
              <div className="grow">
                <strong>{m.name}</strong>
                {m.is_admin && <span className="badge" style={{ marginLeft: "0.4rem" }}>admin</span>}
                {m.is_kiosk && <span className="badge" style={{ marginLeft: "0.4rem" }}>kiosk</span>}
                {m.login_enabled && <span className="badge" style={{ marginLeft: "0.4rem" }}>login</span>}
                {m.locked && <span className="badge amber" style={{ marginLeft: "0.4rem" }}>locked</span>}
                {m.role_id && <span className="badge" style={{ marginLeft: "0.4rem" }}>{roleName(m, roles)}</span>}
                {isBirthdayToday(m.birthday) && <span className="badge amber" style={{ marginLeft: "0.4rem" }}>🎂 today</span>}
                <div className="small muted" style={{ display: "flex", flexWrap: "wrap", columnGap: "0.4rem" }}>
                  {m.system_account
                    ? "system account"
                    : [
                        m.email
                          ? <span className="hide-narrow">Email {m.email}</span>
                          : m.login_enabled ? "no email set" : null,
                        m.login_enabled && m.must_change_password ? "must change password" : null,
                        m.birthday ? `Birthday ${formatBirthday(m.birthday)} · age ${calculateAge(m.birthday)}` : null,
                      ].filter(Boolean).map((node, i) => <span key={i}>{node}</span>)}
                </div>
              </div>
              {m.locked && (
                <button onClick={async () => { await unlockMember(m.id); refresh(); }}>Unlock</button>
              )}
              <button onClick={() => { setEditing(m); setShowForm(false); }}>Edit</button>
            </div>
          ))}
          {visibleMembers.length === 0 && <p className="muted">No members yet.</p>}
        </div>
      </div>
    </div>
  );
}

function roleName(member, roles) {
  return roles.find((r) => r.id === member.role_id)?.name || "";
}

function MemberForm({ roles, initial, onCancel, onSaved }) {
  const [name, setName] = useState(initial?.name || "");
  const [birthday, setBirthday] = useState(initial?.birthday || "");
  const [gender, setGender] = useState(initial?.gender || "");
  const [roleId, setRoleId] = useState(initial?.role_id || "");
  const [isAdmin, setIsAdmin] = useState(!!initial?.is_admin);
  const [theme, setTheme] = useState(initial?.theme || "system");
  // The kiosk and system-account flags are two views of one choice: what this
  // account is, rather than anything about a person.
  const [accountType, setAccountType] = useState(
    initial?.system_account ? "system" : initial?.is_kiosk ? "wall" : "person"
  );
  const [password, setPassword] = useState("");
  const [loginEnabled, setLoginEnabled] = useState(!!initial?.login_enabled);
  const [email, setEmail] = useState(initial?.email || "");
  const [photoUrl, setPhotoUrl] = useState(initial?.photo_url || "");
  const [uploading, setUploading] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [photoMenuOpen, setPhotoMenuOpen] = useState(false);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const advancedRef = useRef(null);

  // Only a person has a birthday, a photo, a gender and a role — a wall display
  // or system account is just a name that signs in on the device.
  const isPerson = accountType === "person";
  // Admin is the role that reviews other people's tasks. Someone who already
  // holds it keeps the switch even under a role that can't review, so the flag
  // is never cleared out from under them.
  const canBeAdmin = roleCanReview(roleId, roles) || isAdmin;

  async function uploadDataUrl(data) {
    setUploading(true);
    try {
      const res = await uploadPhoto(data, name || "member");
      setPhotoUrl(res.photo_url);
    } catch (err) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function pickFile(file) {
    if (!file) return;
    setUploading(true);
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await uploadDataUrl(data);
    } finally {
      setUploading(false);
    }
  }

  function handleFileInput(e) {
    pickFile(e.target.files?.[0]);
    e.target.value = "";
  }

  async function openCamera() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Not supported");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
    } catch {
      cameraRef.current?.click();
    }
  }

  function closeCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOpen(false);
  }

  function captureFrame() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const data = canvas.toDataURL("image/jpeg", 0.85);
    setCameraOpen(false);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    uploadDataUrl(data);
  }

  useEffect(() => {
    if (cameraOpen && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [cameraOpen]);

  // A non-person account has almost nothing left to edit, so open Advanced on
  // mount to show where the account type lives. Set once: after that the
  // disclosure is the user's to fold away.
  useEffect(() => {
    if (advancedRef.current) advancedRef.current.open = !isPerson;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const payload = {
      name,
      // Switching away from Person clears the personal fields rather than
      // leaving them stranded on a wall display (a birthday there would show up
      // in the dashboard's birthday list).
      birthday: isPerson ? birthday || null : null,
      gender: isPerson ? gender || null : null,
      role_id: isPerson && roleId ? Number(roleId) : null,
      photo_url: isPerson ? photoUrl || null : null,
      is_admin: isPerson && isAdmin,
      is_kiosk: accountType === "wall",
      system_account: accountType === "system",
      // Applies to every account type: on a wall display it's how the screen
      // picks light or dark, and "system" keeps it in step with the display.
      theme,
      login_enabled: isPerson && loginEnabled,
      // The email is kept even with login off, so the address doesn't have to
      // be retyped the day sign-in is switched back on.
      email: email.trim() || null,
      ...(password ? { password } : {}),
    };
    if (initial) await updateMember(initial.id, payload);
    else await createMember(payload);
    onCancel();
    onSaved();
    window.dispatchEvent(new Event("fh:user-changed"));
  }

  async function handleResetPassword() {
    if (!initial) return;
    if (!confirm(`Email ${initial.name} a new temporary password? They'll set their own on next sign-in.`)) return;
    await resetMemberPassword(initial.id);
    await onSaved();
    alert(`Temporary password emailed to ${initial.email}.`);
  }

  async function handleDelete() {
    if (!initial) return;
    if (!confirm(`Delete ${initial.name}? They lose their account and any sign-in with it. This can't be undone.`)) return;
    await deleteMember(initial.id);
    onCancel();
    onSaved();
  }

  return (
    <form className="member-form" onSubmit={handleSubmit}>
      <h3 style={{ margin: 0 }}>{initial ? `Edit ${initial.name}` : "Add member"}</h3>

      <div className="form-grid">
        <section className="form-section">
          <p className="form-legend">Identity</p>

          <div className="identity-row">
            {isPerson && (
              <div className="identity-photo">
                <Avatar user={{ name, photo_url: photoUrl }} size="lg" />
                <button
                  type="button"
                  className="small"
                  aria-haspopup="menu"
                  aria-expanded={photoMenuOpen}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setPhotoMenuOpen((open) => !open)}
                >
                  Change <ChevronDown size={14} />
                </button>
                {photoMenuOpen && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 40 }}
                      onClick={() => setPhotoMenuOpen(false)}
                    />
                    <div className="card list-menu photo-menu" role="menu">
                      <button
                        type="button"
                        disabled={uploading}
                        onClick={() => { setPhotoMenuOpen(false); openCamera(); }}
                      >
                        <Camera size={16} /> {uploading ? "Uploading…" : "Take photo"}
                      </button>
                      <button
                        type="button"
                        disabled={uploading}
                        onClick={() => { setPhotoMenuOpen(false); galleryRef.current?.click(); }}
                      >
                        <ImagePlus size={16} /> Choose photo
                      </button>
                      {photoUrl && (
                        <>
                          <div style={{ borderTop: "1px solid var(--border)", margin: "0.25rem 0" }} />
                          <button
                            type="button"
                            className="danger"
                            onClick={() => { setPhotoMenuOpen(false); setPhotoUrl(null); }}
                          >
                            <Trash2 size={16} /> Remove photo
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
                <input
                  ref={cameraRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: "none" }}
                  onChange={handleFileInput}
                />
                <input
                  ref={galleryRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={handleFileInput}
                />
              </div>
            )}

            <div className="identity-fields">
              <div className="form-field">
                <label htmlFor="member-name">Name</label>
                <input
                  id="member-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              {isPerson ? (
                <>
                  <div className="form-field">
                    <label htmlFor="member-birthday">Birthday</label>
                    <div className="row" style={{ gap: "0.6rem" }}>
                      <input
                        id="member-birthday"
                        type="date"
                        value={birthday || ""}
                        onChange={(e) => setBirthday(e.target.value)}
                      />
                      {birthday && <span className="small muted">age {calculateAge(birthday)}</span>}
                    </div>
                  </div>

                  <div className="form-field">
                    <label htmlFor="member-gender">Gender</label>
                    <select
                      id="member-gender"
                      value={gender || ""}
                      onChange={(e) => setGender(e.target.value)}
                    >
                      <option value="">Not specified</option>
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                      <option value="nonbinary">Non-binary</option>
                    </select>
                  </div>
                </>
              ) : (
                <span className="form-hint">
                  A wall display or system account is just a name — it has no
                  photo, birthday, gender or role.
                </span>
              )}

              <div className="form-field">
                <label htmlFor="member-theme">Theme</label>
                <select
                  id="member-theme"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value)}
                >
                  <option value="system">Follow the device</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
                <span className="form-hint">
                  Follow the device keeps it in step with the system setting.
                </span>
              </div>
            </div>
          </div>
        </section>

        {isPerson && (
          <section className="form-section form-role">
            <p className="form-legend">Role</p>
            <div className="form-field">
              <label htmlFor="member-role">Role</label>
              <select
                id="member-role"
                value={roleId || ""}
                onChange={(e) => setRoleId(e.target.value)}
              >
                <option value="">No role</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <span className="form-hint">
                Decides what this member can see and do across the app.
              </span>
            </div>
            {canBeAdmin && (
              <Switch
                checked={isAdmin}
                onChange={setIsAdmin}
                label="Admin"
                hint="Full access everywhere, including settings."
              />
            )}
          </section>
        )}

        {isPerson && (
          <section className="form-section form-signin">
            <p className="form-legend">Sign-in</p>
            <Switch
              checked={loginEnabled}
              onChange={setLoginEnabled}
              label="Allow login"
              hint="Lets this member sign in with an email address instead of picking their name."
            />
            {loginEnabled && (
              <>
                <div className="form-field">
                  <label htmlFor="member-email">Email</label>
                  <input
                    id="member-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="member-password">Password</label>
                  <PasswordInput
                    id="member-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={initial ? "Blank = keep current" : "Blank = email a temporary one"}
                    autoComplete="new-password"
                  />
                  <span className="form-hint">
                    {password
                      ? "At least 8 characters, with an uppercase letter, a lowercase letter and a symbol."
                      : `A temporary password will be emailed${
                          initial
                            ? " — they change it on the next sign-in."
                            : " — they set their own on first sign-in."
                        }`}
                  </span>
                </div>
              </>
            )}
            {loginEnabled && initial?.login_enabled && initial.email && (
              <div className="row wrap" style={{ gap: "0.5rem" }}>
                <button type="button" onClick={handleResetPassword}>Reset password</button>
                <span className="form-hint">
                  Emails a temporary password to {initial.email}.
                </span>
              </div>
            )}
          </section>
        )}
      </div>

      <details className="advanced" ref={advancedRef}>
        <summary><span className="form-legend">Advanced</span></summary>
        <div className="advanced-body">
          <div className="form-field">
            <label htmlFor="member-account-type">Account type</label>
            <select
              id="member-account-type"
              value={accountType}
              onChange={(e) => setAccountType(e.target.value)}
            >
              <option value="person">Person</option>
              <option value="wall">Wall display</option>
              <option value="system">System</option>
            </select>
            <span className="form-hint">
              A wall display or system account has no birthday, photo, gender or
              role, and never signs in with an email.
            </span>
          </div>
        </div>
      </details>

      <div className="form-actions">
        {initial && (
          <button type="button" className="danger" onClick={handleDelete}>Delete member</button>
        )}
        <span className="spacer" />
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit">{initial ? "Save" : "Add member"}</button>
      </div>

      {cameraOpen && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 40, background: "var(--scrim)" }}
            onClick={closeCamera}
          />
          <div
            className="card"
            style={{
              position: "fixed", zIndex: 41, top: "8%", left: "4%", right: "4%", maxWidth: 520,
              margin: "0 auto", padding: "1rem", display: "flex", flexDirection: "column", gap: "0.8rem",
            }}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{ width: "100%", borderRadius: 8, background: "#000", minHeight: 280, objectFit: "cover" }}
            />
            <div className="row" style={{ justifyContent: "center" }}>
              <button type="button" className="primary" onClick={captureFrame}>📸 Capture</button>
              <button type="button" onClick={closeCamera}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </form>
  );
}

// Toggle switch standing in for a checkbox: a target worth touching, and
// unambiguous about being on or off.
function Switch({ checked, onChange, label, hint }) {
  return (
    <div className="form-field">
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          checked={!!checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="switch-track"><span className="switch-thumb" /></span>
        <span className="switch-label">{label}</span>
      </label>
      {hint && <span className="form-hint">{hint}</span>}
    </div>
  );
}

// Admin belongs to whoever reviews other people's tasks, and "review" is a
// capability a role grants. No role at all inherits every capability
// server-side, and a role that gates no tasks module tells us nothing, so both
// count as able to hold it.
function roleCanReview(roleId, roles) {
  if (!roleId) return true;
  const role = roles.find((r) => String(r.id) === String(roleId));
  const tasks = role?.modules?.find((m) => m.name === "tasks");
  if (!tasks) return true;
  return !!tasks.caps?.review;
}

// Format "YYYY-MM-DD" as e.g. "Mar 15"
function formatBirthday(birthday) {
  const d = new Date(`${birthday}T12:00:00`);
  if (Number.isNaN(d.getTime())) return birthday;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Age in years as of today (0 if birthday hasn't been reached yet this year)
function calculateAge(birthday) {
  const b = new Date(`${birthday}T12:00:00`);
  if (Number.isNaN(b.getTime())) return 0;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const thisYearBirthday = new Date(b);
  thisYearBirthday.setFullYear(now.getFullYear());
  if (now < thisYearBirthday) age -= 1;
  return age;
}

function isBirthdayToday(birthday) {
  if (!birthday) return false;
  const b = new Date(`${birthday}T12:00:00`);
  const now = new Date();
  return b.getMonth() === now.getMonth() && b.getDate() === now.getDate();
}