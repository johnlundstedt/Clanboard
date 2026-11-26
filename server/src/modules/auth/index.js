import { Hono } from "hono";
import * as core from "../../core/auth.js";
import * as email from "../../core/email.js";
import { containerDb } from "../../core/container-db.js";
import { security } from "../../web/security.js";
import { storage } from "../../web/storage.js";
import { parsePhotoDataUrl, photoKey } from "../../core/storage.js";
import { readJson, respond } from "../../web/helpers.js";

async function migrate(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT,
      expires_at INTEGER
    );
  `);
}

// Re-exported for places that build user objects from raw rows (index.js).
export const hashPassword = core.hashPassword;
export const publicUser = core.publicUser;

const app = new Hono();

// Current authenticated user (or 401)
app.get("/me", (c) =>
  respond(c, async () => {
    const session = await security().currentSession(c);
    if (!session) throw Object.assign(new Error("Not authenticated"), { status: 401 });
    const user = await security().userById(session.userId);
    if (!user) throw Object.assign(new Error("Not authenticated"), { status: 401 });
    return core.getMePayload(containerDb, user);
  })
);

app.post("/login", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const user = await core.verifyCredentials(containerDb, body.name, body.password);
    await security().setSession(c, user.id);
    return core.publicUser(user);
  })
);

app.post("/logout", (c) => {
  security().clearSession(c);
  return c.json({ ok: true });
});

// --- Self-service profile ----------------------------------------------------
// The header's avatar menu lets a signed-in member change their own photo and
// theme. This is the only non-admin write path onto a user row, so it accepts
// exactly two fields (see core.updateOwnProfile) — role, admin flag and login
// settings stay admin-only, whatever the request body claims.
app.patch("/profile", (c) =>
  respond(c, async () => {
    const session = await security().currentSession(c);
    if (!session) throw Object.assign(new Error("Not authenticated"), { status: 401 });
    const user = await security().userById(session.userId);
    if (!user) throw Object.assign(new Error("Not authenticated"), { status: 401 });
    const body = await readJson(c);
    await core.updateOwnProfile(containerDb, user.id, body);
    // Return the full payload so the client refreshes name/modules/caps in the
    // same round trip instead of re-fetching /me.
    const fresh = await security().userById(session.userId);
    return core.getMePayload(containerDb, fresh);
  })
);

// Upload the signed-in member's own photo. Mirrors the admin photo route, which
// is admin-guarded and so unreachable from here.
app.post("/profile/photo", (c) =>
  respond(c, async () => {
    const session = await security().currentSession(c);
    if (!session) throw Object.assign(new Error("Not authenticated"), { status: 401 });
    const user = await security().userById(session.userId);
    if (!user) throw Object.assign(new Error("Not authenticated"), { status: 401 });
    const body = await readJson(c);
    const photo = parsePhotoDataUrl(body.data);
    const key = photoKey(user.name, photo.ext);
    await storage().put(key, photo.bytes, photo.mime);
    return { photo_url: `/uploads/${key}` };
  }, { status: 201 })
);

// Ask by name + email for a password reset. Emails a fresh temporary password;
// answers uniformly so nobody can enumerate accounts. A confirmed match also
// clears lockout state (the request proves the owner controls the mailbox).
app.post("/forgot-password", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const match = await core.findLoginUser(
      containerDb,
      String(body.name ?? ""),
      String(body.email ?? "")
    );
    if (match) {
      try {
        const password = core.generateTemporaryPassword();
        await core.resetPassword(containerDb, match.id, password);
        await email.sendTemporaryPasswordEmail(containerDb, match.email, password, "reset");
      } catch (err) {
        // Swallow delivery failures: the response must not reveal whether an
        // account matched, and a misconfigured sender shouldn't break the flow.
        console.error("[auth] forgot-password email failed:", err);
      }
    }
    return { ok: true };
  })
);

// Set a new password for the signed-in user (forced first-login change). The
// original password must be verified, and the new one must pass the policy.
app.post("/set-password", (c) =>
  respond(c, async () => {
    const session = await security().currentSession(c);
    if (!session) throw Object.assign(new Error("Not authenticated"), { status: 401 });
    const user = await security().userById(session.userId);
    if (!user) throw Object.assign(new Error("Not authenticated"), { status: 401 });
    const body = await readJson(c);
    if (!core.verifyPassword(body.current_password, user.password_hash)) {
      throw Object.assign(new Error("Current password is incorrect"), { status: 400 });
    }
    const policyError = core.validateNewPassword(body.new_password);
    if (policyError) throw Object.assign(new Error(policyError), { status: 400 });
    await core.resetPassword(containerDb, user.id, body.new_password, false);
    return { ok: true };
  })
);

export default {
  name: "auth",
  navLabel: null,
  migrate,
  app,
  hashPassword,
  publicUser,
};