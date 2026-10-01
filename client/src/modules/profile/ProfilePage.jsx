import { useEffect, useRef, useState } from "react";
import { Camera, ChevronDown, ImagePlus, Trash2 } from "lucide-react";
import { updateOwnProfile, uploadMyPhoto } from "../../api.js";
import Avatar from "../../components/Avatar.jsx";

// A member's own settings, reached from the header avatar menu. Deliberately
// narrow: photo and theme only. Anything an admin controls (role, account type,
// login) stays in Admin >> Member entry, so this page can't be used to grant
// itself access to anything.
export default function ProfilePage({ user, onDone, onSaved }) {
  const [theme, setTheme] = useState(user?.theme || "system");
  const [photoUrl, setPhotoUrl] = useState(user?.photo_url || "");
  const [uploading, setUploading] = useState(false);
  const [photoMenuOpen, setPhotoMenuOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  async function uploadDataUrl(data) {
    setUploading(true);
    try {
      const res = await uploadMyPhoto(data);
      setPhotoUrl(res.photo_url);
    } catch (err) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  function pickFile(file) {
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = () => uploadDataUrl(reader.result);
    reader.onerror = () => setUploading(false);
    reader.readAsDataURL(file);
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
    canvas.getContext("2d").drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
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
    setBusy(true);
    try {
      await updateOwnProfile({ theme, photo_url: photoUrl || null });
      // Picks up the new theme in App's applyTheme effect, and the new photo in
      // the header avatar.
      window.dispatchEvent(new Event("fh:user-changed"));
      setSaved(true);
      onSaved?.();
    } catch (err) {
      alert(`Could not save: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="member-form profile-form" onSubmit={handleSubmit}>
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Settings</h3>
        <button type="button" onClick={onDone}>Back</button>
      </div>

      <section className="form-section">
        <p className="form-legend">Photo</p>
        <div className="identity-row">
          <div className="identity-photo">
            <Avatar user={{ name: user?.name || "", photo_url: photoUrl }} size="lg" />
            <button
              type="button"
              className="small"
              aria-haspopup="menu"
              aria-expanded={photoMenuOpen}
              disabled={uploading}
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
                    <Camera size={16} /> Take photo
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
                        onClick={() => { setPhotoMenuOpen(false); setPhotoUrl(""); }}
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
          <span className="form-hint">
            Your photo shows next to your name across the app, and as the
            avatar in the header.
          </span>
        </div>
      </section>

      <section className="form-section">
        <p className="form-legend">Theme</p>
        <div className="form-field">
          <label htmlFor="own-theme">Theme</label>
          <select
            id="own-theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          >
            <option value="system">Follow the device</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <span className="form-hint">
            Follow the device keeps it in step with your system setting.
          </span>
        </div>
      </section>

      <div className="form-actions">
        <span className="spacer" />
        {saved && !busy && (
          <span className="small" style={{ color: "var(--green)" }}>Saved</span>
        )}
        <button type="button" onClick={onDone}>Cancel</button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      {cameraOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "var(--scrim)",
            display: "grid",
            placeItems: "center",
            padding: "1rem",
          }}
        >
          <div className="card" style={{ maxWidth: 480, width: "100%" }}>
            <video ref={videoRef} playsInline muted style={{ width: "100%", borderRadius: 8 }} />
            <div className="form-actions" style={{ marginTop: "0.6rem" }}>
              <button type="button" onClick={closeCamera}>Cancel</button>
              <span className="spacer" />
              <button type="button" className="primary" onClick={captureFrame}>Take photo</button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}