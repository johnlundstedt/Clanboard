import { Hono } from "hono";
import * as core from "../../core/auth.js";
import { containerDb } from "../../core/container-db.js";
import { security } from "../../web/security.js";
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

export default {
  name: "auth",
  navLabel: null,
  migrate,
  app,
  hashPassword,
  publicUser,
};