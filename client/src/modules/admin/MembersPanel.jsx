import { useCallback, useEffect, useRef, useState } from "react";
import Avatar from "../../components/Avatar.jsx";
import {
  getMembers, createMember, updateMember, deleteMember, uploadPhoto,
  getRoles,
} from "../../api.js";
import { usePolling } from "../../realtime.js";

// Manage household members: name, birthday, gender, role, admin flag, and photo
// (camera or gallery upload).
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
            Each member has a name, date of birth, gender, role, and optional admin
            flag. Photos can be taken with the device camera or uploaded.
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
          Show system accounts
        </label>
        <div style={{ display: "grid", gap: "0.4rem" }}>
          {visibleMembers.map((m) => (
            <div key={m.id} className="row" style={{ padding: "0.3rem 0" }}>
              <Avatar user={m} />
              <div className="grow">
                <strong>{m.name}</strong>
                {m.is_admin && <span className="badge" style={{ marginLeft: "0.4rem" }}>admin</span>}
                {m.role_id && <span className="badge" style={{ marginLeft: "0.4rem" }}>{roleName(m, roles)}</span>}
                {isBirthdayToday(m.birthday) && <span className="badge amber" style={{ marginLeft: "0.4rem" }}>🎂 today</span>}
                <div className="small muted">
                  {m.birthday
                    ? `Birthday ${formatBirthday(m.birthday)} · age ${calculateAge(m.birthday)}`
                    : ""}
                  {m.photo_url ? " · photo" : ""}
                </div>
              </div>
              <button onClick={() => { setEditing(m); setShowForm(false); }}>Edit</button>
              <button className="danger" onClick={async () => {
                if (confirm(`Remove ${m.name}?`)) { await deleteMember(m.id); refresh(); }
              }}>✕</button>
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
  const [systemAccount, setSystemAccount] = useState(!!initial?.system_account);
  const [password, setPassword] = useState("");
  const [photoUrl, setPhotoUrl] = useState(initial?.photo_url || "");
  const [uploading, setUploading] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);

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

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const payload = {
      name,
      birthday: birthday || null,
      gender: gender || null,
      role_id: roleId ? Number(roleId) : null,
      photo_url: photoUrl || null,
      is_admin: isAdmin,
      system_account: systemAccount,
      ...(password ? { password } : {}),
    };
    if (initial) await updateMember(initial.id, payload);
    else await createMember(payload);
    onCancel();
    onSaved();
    window.dispatchEvent(new Event("fh:user-changed"));
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.6rem" }}>
      <h3 style={{ margin: 0 }}>{initial ? `Edit ${initial.name}` : "Add member"}</h3>

      <div className="row wrap">
        <input style={{ width: "18rem", maxWidth: "100%" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required autoFocus />
        <input type="date" value={birthday || ""} onChange={(e) => setBirthday(e.target.value)} title="Birthday" />
        {birthday && <span className="small muted">age {calculateAge(birthday)}</span>}
      </div>

      <div className="row wrap">
        <select value={gender || ""} onChange={(e) => setGender(e.target.value)}>
          <option value="">Gender (optional)</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="nonbinary">Non-binary</option>
        </select>

        <select value={roleId || ""} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">No role</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>

        <label className="row small">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Admin
        </label>
        <label className="row small">
          <input type="checkbox" checked={systemAccount} onChange={(e) => setSystemAccount(e.target.checked)} />
          System Account
        </label>
      </div>

      <div className="row wrap">
        <div className="row">
          <Avatar user={{ name, photo_url: photoUrl }} size="lg" />
          <div className="row wrap" style={{ gap: "0.4rem" }}>
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
            <button type="button" disabled={uploading} onClick={openCamera}>
              {uploading ? "Uploading…" : "📷 Take photo"}
            </button>
            <button type="button" disabled={uploading} onClick={() => galleryRef.current?.click()}>
              {uploading ? "Uploading…" : "🖼️ Choose photo"}
            </button>
            {photoUrl && <button type="button" className="small" onClick={() => setPhotoUrl(null)}>Remove</button>}
          </div>
        </div>
      </div>

      <div className="row">
        <input
          style={{ width: "25rem", maxWidth: "100%" }}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={initial ? "New password (leave blank to keep)" : "Password (blank = no login)"}
          autoComplete="new-password"
        />
      </div>

      <div className="row">
        <button className="primary" type="submit">{initial ? "Save" : "Add member"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>

      {cameraOpen && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.6)" }}
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